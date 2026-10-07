"""The stage runner: guards, gating, dry runs, and the run log round-trip."""

from __future__ import annotations

import json

import httpx
import pytest
import respx

import camsocs_pipeline.pipeline.load as load
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


def registry(**overrides):
    stages = dict.fromkeys(STAGE_ORDER, ok_stage)
    stages.update(overrides)
    return stages


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


def test_resolve_stages_keeps_canonical_order_and_rejects_unknown() -> None:
    assert resolve_stages(None) == list(STAGE_ORDER)
    assert resolve_stages(["load", "fetch", "fetch"]) == ["fetch", "load"]
    with pytest.raises(ValueError, match="fecth"):
        resolve_stages(["fecth"])


def test_dry_run_needs_no_credentials_and_writes_nothing(make_settings) -> None:
    # No CONVEX_HTTP_URL, no key, and no respx routes: any request would raise.
    settings = make_settings()

    report = run_sync(settings=settings, dry_run=True)

    assert report.ok
    assert report.dry_run
    assert [stage.name for stage in report.stages] == list(STAGE_ORDER)
    assert not settings.state_path.exists(), "a dry run leaves no state behind"


def test_scaffold_stages_say_they_are_not_implemented(make_settings) -> None:
    report = run_sync(settings=make_settings(), dry_run=True)
    assert all("not implemented yet" in stage.notes[0] for stage in report.stages)


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
    assert statuses["extract"] == "ok", "stages after a non-gating failure still run"
    finish = json.loads(routes["finish"].calls[0].request.content)
    parse = next(stage for stage in finish["stages"] if stage["name"] == "parse")
    assert parse["error"] == "RuntimeError: source down"
    assert load_state(settings.state_path).last_run_ok is False


def test_a_failed_discover_gates_every_later_stage(make_settings) -> None:
    report = run_sync(
        settings=make_settings(), dry_run=True, registry=registry(discover=failing_stage)
    )

    statuses = [stage.status for stage in report.stages]
    assert statuses == ["failed"] + ["not_run"] * (len(STAGE_ORDER) - 1)


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
