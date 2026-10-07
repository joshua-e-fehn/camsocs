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
    STAGE_ORDER,
    StageContext,
    resolve_stages,
    run_sync,
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
    settings = make_settings()

    report = run_sync(settings=settings, dry_run=True)

    assert report.ok, report.summary()
    assert report.dry_run
    assert [stage.name for stage in report.stages] == list(STAGE_ORDER)
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
    store = StagingStore(settings.staging_dir)
    store.write("su_directory", "r1", [observation])
    store.write(RESOLVED, "r1", [observation.model_copy(update={"entity_key": "org-cu-chess"})])

    report = run_sync(settings=settings, dry_run=True, stages=["load"])

    [load_report] = report.stages
    assert load_report.ok
    assert load_report.skipped == 1, "the unkeyed harvest record waits for resolve"
    assert "2 records from su_directory, _resolved; 1 awaiting resolve" in load_report.notes


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

    def spy(self, records, *, run_key=None):
        posted.append([record.source_type for record in records])
        return original(self, records, run_key=run_key)

    monkeypatch.setattr(load.ConvexLoader, "post_observations", spy)
    report = run_sync(settings=settings, dry_run=True, stages=["load"], limit=1)
    assert report.ok
    assert posted == [["su_directory"]]
    assert report.stages[0].skipped == 1
