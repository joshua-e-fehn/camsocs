"""The stage runner: guards, gating, dry runs, and the run log round-trip."""

from __future__ import annotations

import json

import httpx
import pytest
import respx

import camsocs_pipeline.pipeline.load as load
from camsocs_pipeline.pipeline.context import Stage
from camsocs_pipeline.pipeline.load import ConvexAuthError
from camsocs_pipeline.pipeline.state import load_state
from camsocs_pipeline.pipeline.sync import (
    GROUPS,
    STAGE_ORDER,
    STAGES,
    StageContext,
    StageGroup,
    group_inputs,
    resolve_group,
    resolve_stages,
    run_sync,
    staged_at,
)

SITE = "https://happy-otter-123.convex.site"


@pytest.fixture(autouse=True)
def _no_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(load.time, "sleep", lambda _seconds: None)


def ok_stage(ctx: StageContext) -> None:
    ctx.report.inserted += 1


def failing_stage(ctx: StageContext) -> None:
    raise RuntimeError("source down")


#: A registry shaped like the real one: independent stages, then a resolve
#: stage that load requires.
NAMES = ("discover", "fetch", "parse", "extract", "resolve", "load")


def registry(**overrides):
    return [
        Stage(name, overrides.get(name, ok_stage), requires=("resolve",) if name == "load" else ())
        for name in NAMES
    ]


def mock_convex(net: respx.MockRouter) -> dict[str, respx.Route]:
    return {
        "health": net.get(f"{SITE}/api/pipeline/health").respond(200, json={"ok": True}),
        "start": net.post(f"{SITE}/api/pipeline/runs/start").respond(
            200, json={"runKey": "x", "created": True}
        ),
        "finish": net.post(f"{SITE}/api/pipeline/runs/finish").respond(
            200, json={"runKey": "x", "status": "success", "unchanged": False}
        ),
    }


def test_resolve_stages_keeps_registry_order_and_rejects_unknown() -> None:
    assert [stage.name for stage in resolve_stages(None)] == list(STAGE_ORDER)
    names = [s.name for s in resolve_stages(["load", "fetch", "fetch"], registry())]
    assert names == ["fetch", "load"]
    with pytest.raises(ValueError, match="fecth"):
        resolve_stages(["fecth"], registry())
    with pytest.raises(ValueError, match="Duplicate"):
        resolve_stages(None, [*registry(), Stage("load", ok_stage)])


def test_the_real_registry_starts_with_seeds_and_ends_with_load() -> None:
    assert STAGE_ORDER[0] == "term_dates"
    assert "load" in STAGE_ORDER
    # Every registered stage resolves to its module's run().
    for stage in resolve_stages(None):
        assert callable(stage.resolve())


def test_dry_run_needs_no_credentials_and_writes_nothing(make_settings) -> None:
    # No CONVEX_HTTP_URL, no key, and no respx routes: any request would raise.
    # Stages that read public sources (`fetches`) read even in a dry run, so
    # this offline test runs every other registered stage.
    settings = make_settings()
    offline = [stage.name for stage in STAGES if not stage.fetches]

    report = run_sync(settings=settings, dry_run=True, stages=offline)

    assert report.ok, report.summary()
    assert report.dry_run
    assert [stage.name for stage in report.stages] == offline
    assert not settings.state_path.exists(), "a dry run leaves no state behind"


def test_the_load_stage_says_when_nothing_is_staged(make_settings) -> None:
    report = run_sync(settings=make_settings(), dry_run=True, stages=["load"])
    assert report.stages[0].notes == ["nothing staged"]


def test_a_real_run_brackets_the_stages_with_the_run_log(make_settings, net) -> None:
    routes = mock_convex(net)
    settings = make_settings(convex_http_url=SITE, pipeline_api_key="test-key")

    report = run_sync(settings=settings, stages=["discover", "fetch"], registry=registry())

    assert report.ok
    assert routes["health"].called
    start = json.loads(routes["start"].calls[0].request.content)
    assert start["requestedStages"] == ["discover", "fetch"]
    finish = json.loads(routes["finish"].calls[0].request.content)
    assert finish["runKey"] == start["runKey"] == report.run_key
    assert [stage["name"] for stage in finish["stages"]] == ["discover", "fetch"]
    assert finish["stages"][0]["inserted"] == 1
    state = load_state(settings.state_path)
    assert state.last_run_key == report.run_key
    assert state.last_run_ok is True


def test_a_failing_stage_is_recorded_and_the_rest_still_run(make_settings, net) -> None:
    routes = mock_convex(net)
    settings = make_settings(convex_http_url=SITE, pipeline_api_key="test-key")

    report = run_sync(settings=settings, registry=registry(parse=failing_stage))

    assert not report.ok
    statuses = {stage.name: stage.status for stage in report.stages}
    assert statuses["parse"] == "failed"
    assert statuses["extract"] == "ok", "stages that do not require it still run"
    finish = json.loads(routes["finish"].calls[0].request.content)
    parse = next(stage for stage in finish["stages"] if stage["name"] == "parse")
    assert parse["error"] == "RuntimeError: source down"
    assert load_state(settings.state_path).last_run_ok is False


def test_a_failed_requirement_skips_the_stage_that_needs_it(make_settings) -> None:
    report = run_sync(
        settings=make_settings(), dry_run=True, registry=registry(resolve=failing_stage)
    )

    statuses = {stage.name: stage.status for stage in report.stages}
    assert statuses["resolve"] == "failed"
    assert statuses["load"] == "not_run"
    assert report.stages[-1].notes == ["skipped: resolve failed"]


def test_a_requirement_that_was_not_requested_does_not_block(make_settings) -> None:
    report = run_sync(settings=make_settings(), dry_run=True, stages=["load"], registry=registry())
    assert report.ok


def test_a_stage_module_that_fails_to_import_fails_alone(make_settings) -> None:
    stages = [Stage("no_such_stage_module"), Stage("fine", ok_stage)]
    report = run_sync(settings=make_settings(), dry_run=True, registry=stages)
    assert [stage.status for stage in report.stages] == ["failed", "ok"]


def test_a_rejected_key_stops_the_run_before_any_stage(make_settings, net) -> None:
    net.get(f"{SITE}/api/pipeline/health").respond(401, json={"error": "Unauthorized"})
    start = net.post(f"{SITE}/api/pipeline/runs/start")
    called: list[str] = []

    def spy(ctx: StageContext) -> None:
        called.append(ctx.report.name)

    with pytest.raises(ConvexAuthError):
        run_sync(
            settings=make_settings(convex_http_url=SITE, pipeline_api_key="wrong"),
            registry=registry(discover=spy),
        )
    assert not start.called
    assert called == []


def test_a_failed_finish_fails_the_run_but_keeps_the_stage_results(make_settings, net) -> None:
    net.get(f"{SITE}/api/pipeline/health").respond(200, json={"ok": True})
    net.post(f"{SITE}/api/pipeline/runs/start").respond(200, json={"created": True})
    net.post(f"{SITE}/api/pipeline/runs/finish").mock(
        return_value=httpx.Response(400, json={"error": "Run x not found"})
    )

    report = run_sync(
        settings=make_settings(convex_http_url=SITE, pipeline_api_key="k"), registry=registry()
    )

    assert not report.ok
    assert "runs.finish failed" in (report.error or "")
    assert all(stage.ok for stage in report.stages)


def test_the_limit_reaches_the_stages(make_settings) -> None:
    seen: list[int | None] = []
    run_sync(
        settings=make_settings(),
        dry_run=True,
        limit=5,
        registry=registry(fetch=lambda ctx: seen.append(ctx.limit)),
    )
    assert seen == [5]


def test_the_load_stage_posts_keyed_staged_observations(make_settings) -> None:
    from datetime import UTC, datetime

    from camsocs_pipeline.claims import parser_field
    from camsocs_pipeline.models.observation import IdentityHints, Observation
    from camsocs_pipeline.staging.store import RESOLVED, StagingStore

    settings = make_settings()
    observation = Observation(
        source_type="su_directory",
        source_key="6789",
        source_url="https://www.cambridgesu.co.uk/opportunities/societies/",
        retrieved_at=datetime(2026, 10, 7, tzinfo=UTC),
        entity_type="organisation",
        identity=IdentityHints(name="CU Chess Club"),
        fields=[parser_field("name", "CU Chess Club", extractor="su.name", evidence="secondary")],
    )
    held = observation.model_copy(update={"source_key": "6790"})
    store = StagingStore(settings.staging_dir)
    store.write("su_directory", "r1", [observation, held])
    store.write(RESOLVED, "r1", [observation.model_copy(update={"entity_key": "org-cu-chess"})])

    report = run_sync(settings=settings, dry_run=True, stages=["load"])

    [load_report] = report.stages
    assert load_report.ok
    # The original the resolver copied is not waiting; the one it held is.
    assert load_report.skipped == 1, "the unkeyed harvest record waits for resolve"
    assert "3 records from su_directory, _resolved; 1 awaiting resolve" in load_report.notes


def test_load_posts_resolved_organisations_before_their_enrichment(
    make_settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A website observation adds fields to an organisation the resolver's
    output creates; the server refuses claims for an organisation that does
    not exist yet, so `_resolved` goes first — and `--limit` counts only
    records that can load."""
    from datetime import UTC, datetime

    from camsocs_pipeline.claims import parser_field
    from camsocs_pipeline.models.observation import IdentityHints, Observation
    from camsocs_pipeline.staging.store import RESOLVED, StagingStore

    def org(source_type: str, key: str | None, field: str, value: str) -> Observation:
        return Observation(
            source_type=source_type,
            source_key=f"{source_type}-1",
            source_url=f"https://{source_type.replace('_', '-')}.example/",
            retrieved_at=datetime(2026, 10, 7, tzinfo=UTC),
            entity_type="organisation",
            identity=IdentityHints(name="CU Chess Club", known_key=key),
            entity_key=key,
            fields=[parser_field(field, value, extractor="t", evidence="primary")],
        )

    settings = make_settings()
    store = StagingStore(settings.staging_dir)
    store.write("cucbc", "r1", [org("cucbc", None, "name", "Unkeyed")])
    store.write(
        "society_website", "r1", [org("society_website", "org-cu-chess", "howToJoin", "Turn up")]
    )
    store.write(RESOLVED, "r1", [org("su_directory", "org-cu-chess", "name", "CU Chess Club")])

    posted: list[list[str]] = []
    original = load.ConvexLoader.post_observations

    def spy(self, records, **kwargs):
        posted.append([record.source_type for record in records])
        return original(self, records, **kwargs)

    monkeypatch.setattr(load.ConvexLoader, "post_observations", spy)
    report = run_sync(settings=settings, dry_run=True, stages=["load"], limit=1)
    assert report.ok
    assert posted == [["su_directory"]]
    assert report.stages[0].skipped == 1


def test_stage_metrics_travel_only_when_there_are_some() -> None:
    from camsocs_pipeline.pipeline.report import StageReport

    plain = StageReport("load")
    assert "metrics" not in plain.to_payload()
    resolve = StageReport("resolve")
    resolve.metrics.update(quarantineHeld=8, quarantineReview=18)
    assert resolve.to_payload()["metrics"] == {"quarantineHeld": 8, "quarantineReview": 18}


# --- groups (decision D5: the VPS runs `sync --group events` daily, `full` weekly) ----------


def stage_all(store, *directories: str, run_key: str = "20261003T020000Z-aaaaaa") -> None:
    from datetime import UTC, datetime

    from camsocs_pipeline.models.observation import IdentityHints, Observation

    for directory in directories:
        record = Observation(
            source_type="su_profile" if directory.startswith("_") else directory,
            source_key="1",
            source_url="https://example.org/",
            retrieved_at=datetime(2026, 10, 3, tzinfo=UTC),
            entity_type="organisation",
            identity=IdentityHints(name="CU Chess Club"),
        )
        store.write(directory, run_key, [record])


def test_the_real_groups_name_registry_stages_and_the_events_group_ends_with_load() -> None:
    from camsocs_pipeline.staging.store import RESOLVED

    for group in GROUPS.values():
        resolve_stages(group.stages or None)  # every name is a registry stage
    assert set(GROUPS) == {"events", "full"}
    assert GROUPS["full"].stages == () and GROUPS["full"].derive
    events = [stage.name for stage in resolve_stages(GROUPS["events"].stages)]
    assert events[0] == "term_dates" and events[-2:] == ["load", "report"]
    # Every events source but the University's (which fetches nothing, §10)
    # runs daily; no harvest, resolve, enrich or classify stage does.
    fetching = {s.name for s in STAGES if s.fetches} - {"enrich", "uni_events"}
    assert fetching <= set(events)
    assert {"inbox", "instagram", "termcards"} <= set(events)
    assert not {"su_directory", "resolve", "enrich", "classify"} & set(events)
    assert set(GROUPS["events"].needs) == {RESOLVED, "society_website", "su_profile"}


def test_an_unknown_group_is_an_error() -> None:
    with pytest.raises(ValueError, match="Known: events, full"):
        resolve_group("daily")


def test_a_group_runs_its_stages_in_registry_order(make_settings) -> None:
    group = StageGroup("pair", stages=("load", "fetch"))
    report = run_sync(settings=make_settings(), dry_run=True, group=group, registry=registry())
    assert [stage.name for stage in report.stages] == ["fetch", "load"]
    assert report.command == "sync --group pair"


def test_stages_and_a_group_together_are_refused(make_settings) -> None:
    with pytest.raises(ValueError, match="not both"):
        run_sync(
            settings=make_settings(),
            dry_run=True,
            stages=["fetch"],
            group=StageGroup("pair", stages=("fetch",)),
            registry=registry(),
        )


def test_a_group_stops_before_any_stage_when_its_inputs_were_never_staged(
    make_settings, net
) -> None:
    from camsocs_pipeline.staging.store import RESOLVED, StagingStore

    routes = mock_convex(net)
    settings = make_settings(convex_http_url=SITE, pipeline_api_key="test-key")
    stage_all(StagingStore(settings.staging_dir), "society_website")
    called: list[str] = []
    group = StageGroup("daily", stages=("fetch",), needs=(RESOLVED, "society_website", "termcard"))

    with pytest.raises(ValueError, match="holds no _resolved, termcard yet") as raised:
        run_sync(
            settings=settings,
            group=group,
            registry=registry(fetch=lambda ctx: called.append("fetch")),
        )
    assert "--group full" in str(raised.value)
    assert called == []
    assert not routes["health"].called, "no request before the inputs are checked"


def test_stale_inputs_still_serve_with_a_warning(make_settings, net) -> None:
    from datetime import UTC, datetime, timedelta

    from camsocs_pipeline.staging.store import RESOLVED, StagingStore

    routes = mock_convex(net)
    settings = make_settings(convex_http_url=SITE, pipeline_api_key="test-key")
    store = StagingStore(settings.staging_dir)
    stage_all(store, RESOLVED, run_key="20260920T020000Z-aaaaaa")
    stage_all(store, "society_website", run_key="20261004T020000Z-bbbbbb")
    group = StageGroup(
        "daily",
        stages=("fetch",),
        needs=(RESOLVED, "society_website"),
        stale_after=timedelta(days=8),
    )

    report = run_sync(
        settings=settings,
        group=group,
        registry=registry(),
        now=datetime(2026, 10, 10, 4, 30, tzinfo=UTC),
    )

    assert report.ok
    assert report.warnings == [
        "_resolved was last staged 20 days ago (2026-09-20); "
        "the full group has not refreshed it since"
    ]
    finish = json.loads(routes["finish"].calls[0].request.content)
    assert finish["warnings"] == report.warnings
    start = json.loads(routes["start"].calls[0].request.content)
    assert start["command"] == "sync --group daily"


def test_a_staging_file_is_dated_by_its_run_key(tmp_path) -> None:
    from datetime import UTC, datetime

    path = tmp_path / "20261009T165718Z-71904a--enrich.jsonl"
    path.write_text("")
    assert staged_at(path) == datetime(2026, 10, 9, 16, 57, 18, tzinfo=UTC)
    other = tmp_path / "manual.jsonl"
    other.write_text("")
    assert staged_at(other).year >= 2026


def test_the_full_group_needs_nothing_staged(make_settings) -> None:
    from camsocs_pipeline.staging.store import StagingStore

    assert group_inputs(GROUPS["full"], StagingStore(make_settings().staging_dir)) == []


def test_the_summary_payload_has_one_line_per_stage_and_the_coverage(make_settings) -> None:
    def measured(ctx: StageContext) -> None:
        ctx.report.metrics.update(listed=793, counterparts=168, upcomingEvents=533)
        ctx.report.notes.append("a long note that stays in the log")

    stages = [Stage("fetch", ok_stage), Stage("report", measured)]
    report = run_sync(settings=make_settings(), dry_run=True, registry=stages)
    payload = report.summary_payload()

    assert payload["ok"] is True and payload["dryRun"] is True
    assert payload["summary"] == [
        "fetch: 1 new, 0 updated, 0 unchanged, 0 skipped",
        "report: nothing to do",
    ]
    assert payload["coverage"] == {"listed": 793, "counterparts": 168, "upcomingEvents": 533}
    assert all("notes" not in stage for stage in payload["stages"])
    json.dumps(payload)  # serialisable as it is
