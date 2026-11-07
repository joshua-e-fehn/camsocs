"""Run telemetry (ENG-8): off without a key, counts only, never in the way.

A fake client stands in for `posthog.Posthog` throughout: the real one posts
with `requests`, which respx cannot see (conftest refuses its transport).
"""

from __future__ import annotations

import json
import threading
import time
from typing import Any

import pytest
import respx
from click.testing import CliRunner

import camsocs_pipeline.pipeline.load as load
import camsocs_pipeline.pipeline.sync as sync_module
import camsocs_pipeline.telemetry as telemetry_module
from camsocs_pipeline.cli import cli
from camsocs_pipeline.config import Settings
from camsocs_pipeline.pipeline.context import Stage, StageContext
from camsocs_pipeline.pipeline.report import RunReport
from camsocs_pipeline.pipeline.sync import run_sync
from camsocs_pipeline.telemetry import (
    AI_SPAN,
    AI_TRACE,
    ALLOWED,
    CLOSE_TIMEOUT,
    DISTINCT_ID,
    FLUSH_TIMEOUT,
    FORBIDDEN_AI_KEYS,
    RUN_FINISHED,
    RUN_STARTED,
    SOURCE_FETCHED,
    STAGE_COMPLETED,
    HarvestTelemetry,
    clean_properties,
)

SITE = "https://happy-otter-123.convex.site"
KEY = "phc_test_project_token_not_real"
#: Free text a stage may put in its error and notes; must never be sent.
SCRAPED = "Talk title by Dr Example at https://example.org/talk/123"


@pytest.fixture(autouse=True)
def _no_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(load.time, "sleep", lambda _seconds: None)


class FakeClient:
    """Records what `posthog.Posthog` would have been asked to do."""

    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.events: list[tuple[str, dict[str, Any]]] = []
        self.flushes: list[float | None] = []
        self.shutdowns = 0

    def capture(self, event: str, **kwargs: Any) -> str | None:
        if self.fail:
            raise RuntimeError("capture exploded")
        self.events.append((event, kwargs))
        return "uuid"

    def flush(self, timeout_seconds: float | None = 10) -> None:
        self.flushes.append(timeout_seconds)
        if self.fail:
            raise RuntimeError("flush exploded")

    def shutdown(self) -> None:
        self.shutdowns += 1
        if self.fail:
            raise RuntimeError("shutdown exploded")

    def named(self, event: str) -> list[dict[str, Any]]:
        return [kwargs["properties"] for name, kwargs in self.events if name == event]


def ok_stage(ctx: StageContext) -> None:
    ctx.report.inserted += 2
    ctx.report.updated += 1
    ctx.report.metrics["quarantineHeld"] = 3
    ctx.report.notes.append(SCRAPED)


def failing_stage(ctx: StageContext) -> None:
    ctx.report.notes.append(SCRAPED)
    raise RuntimeError(SCRAPED)


def registry(**overrides):
    names = ("discover", "parse", "resolve", "load")
    return [
        Stage(name, overrides.get(name, ok_stage), requires=("resolve",) if name == "load" else ())
        for name in names
    ]


def telemetry(client: FakeClient, **kwargs: Any) -> HarvestTelemetry:
    return HarvestTelemetry(client, environment="production", revision="0123456789ab", **kwargs)


def assert_safe(client: FakeClient) -> None:
    """Every event: the fixed personless id, allow-listed keys, no free text."""
    for event, kwargs in client.events:
        assert set(kwargs) == {"distinct_id", "properties"}
        assert kwargs["distinct_id"] == DISTINCT_ID
        properties = kwargs["properties"]
        assert properties["$process_person_profile"] is False
        assert properties["environment"] == "production"
        assert set(properties) <= ALLOWED[event], set(properties) - ALLOWED[event]
        for forbidden in ("error", "notes", "warnings", "title", "url", "message"):
            assert forbidden not in properties
        assert not FORBIDDEN_AI_KEYS & set(properties)
        assert properties["campus"] == "cam"
        dumped = json.dumps(properties)
        assert "example.org" not in dumped and "Talk title" not in dumped
        assert "http" not in dumped and KEY not in dumped


# --- off without a key -------------------------------------------------------


def test_without_a_key_no_client_is_built_and_nothing_happens(make_settings) -> None:
    def factory(_settings: Settings) -> FakeClient:
        raise AssertionError("no client without POSTHOG_KEY")

    disabled = HarvestTelemetry.from_settings(make_settings(), client_factory=factory)

    assert not disabled.enabled
    report = run_sync(
        settings=make_settings(), dry_run=True, registry=registry(), telemetry=disabled
    )
    disabled.close()
    assert report.ok


def test_a_blank_key_counts_as_unset(make_settings) -> None:
    assert not make_settings(posthog_key="  ").posthog_configured
    assert make_settings(posthog_key=KEY).posthog_configured


def test_settings_default_to_the_eu_host_and_development(
    make_settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = make_settings()
    assert settings.posthog_host == "https://eu.i.posthog.com"
    assert settings.posthog_env == "development"
    monkeypatch.setenv("POSTHOG_KEY", KEY)
    monkeypatch.setenv("POSTHOG_HOST", "https://eu.i.posthog.com/")
    monkeypatch.setenv("POSTHOG_ENV", "production")
    settings = Settings(_env_file=None)
    assert settings.posthog_configured and KEY not in repr(settings)
    assert settings.posthog_host == "https://eu.i.posthog.com"
    assert settings.posthog_env == "production"


def test_from_settings_builds_a_client_with_the_environment(make_settings) -> None:
    client = FakeClient()
    built = HarvestTelemetry.from_settings(
        make_settings(posthog_key=KEY, posthog_env="production"), client_factory=lambda _s: client
    )
    assert built.enabled
    built.run_started(RunReport("k", "sync"), group=None, stages=["discover"])
    assert client.named(RUN_STARTED)[0]["environment"] == "production"


def test_the_real_client_is_configured_for_eu_and_short_timeouts(
    make_settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    import posthog

    seen: dict[str, Any] = {}

    class Recorder:
        def __init__(self, key: str, **kwargs: Any) -> None:
            seen.update(kwargs, key=key)

    monkeypatch.setattr(posthog, "Posthog", Recorder)
    HarvestTelemetry.from_settings(make_settings(posthog_key=f" {KEY} ", posthog_host=""))

    assert seen["key"] == KEY
    assert seen["host"] == "https://eu.i.posthog.com"
    assert seen["disable_geoip"] is True
    assert seen["timeout"] <= 5 and seen["max_retries"] <= 1
    assert seen["before_send"] is telemetry_module._strip_sdk_context


def test_the_real_client_sends_no_os_or_python_version(make_settings) -> None:
    """The SDK merges its system context into every event; `before_send`
    (which runs after that merge) takes the host's OS and Python out."""
    client = telemetry_module._posthog_client(make_settings(posthog_key=KEY))
    seen: list[dict[str, Any]] = []
    hook = client.before_send
    client.before_send = lambda message: seen.append(hook(message)) or seen[-1]
    client.send = False  # build the wire message, queue nothing
    try:
        client.capture("probe", distinct_id=DISTINCT_ID, properties={"stage": "load"})
    finally:
        client.shutdown()

    (message,) = seen
    properties = message["properties"]
    assert properties["stage"] == "load" and properties["$geoip_disable"] is True
    for key in ("$os", "$os_version", "$os_distro", "$python_runtime", "$python_version"):
        assert key not in properties


# --- what is sent ------------------------------------------------------------


def test_a_run_sends_start_each_stage_and_finish_with_counts_only(make_settings, net) -> None:
    net.get(f"{SITE}/api/pipeline/health").respond(200, json={"ok": True})
    net.post(f"{SITE}/api/pipeline/runs/start").respond(200, json={"runKey": "x"})
    net.post(f"{SITE}/api/pipeline/runs/finish").respond(200, json={"runKey": "x"})
    settings = make_settings(convex_http_url=SITE, pipeline_api_key="test-key")
    client = FakeClient()

    report = run_sync(
        settings=settings,
        registry=registry(resolve=failing_stage),
        telemetry=telemetry(client),
    )

    assert not report.ok
    assert [name for name, _ in client.events] == [
        RUN_STARTED,
        *[STAGE_COMPLETED, AI_SPAN] * 4,
        RUN_FINISHED,
        AI_TRACE,
    ]
    assert_safe(client)

    (started,) = client.named(RUN_STARTED)
    assert started["runKey"] == report.run_key
    assert started["command"] == "sync" and started["dryRun"] is False
    assert started["requestedStages"] == ["discover", "parse", "resolve", "load"]
    assert started["pipelineVersion"] and started["revision"] == "0123456789ab"

    stages = {props["stage"]: props for props in client.named(STAGE_COMPLETED)}
    assert stages["discover"]["status"] == "ok"
    assert stages["discover"]["inserted"] == 2 and stages["discover"]["updated"] == 1
    assert stages["discover"]["metrics"] == {"quarantineHeld": 3}
    assert stages["discover"]["durationS"] >= 0
    assert "errorType" not in stages["discover"]
    assert stages["resolve"]["status"] == "failed"
    assert stages["resolve"]["errorType"] == "RuntimeError"
    assert stages["load"]["status"] == "not_run"

    (finished,) = client.named(RUN_FINISHED)
    assert finished["status"] == "partial", "as deriveRunStatus: some stages ok"
    assert finished["stagesOk"] == 2 and finished["stagesFailed"] == 1
    assert finished["stagesNotRun"] == 1 and finished["failedStages"] == ["resolve"]
    assert finished["inserted"] == 4 and finished["runError"] is False
    assert "errorType" not in finished, "stage failures are not a run-level exception"


def test_a_successful_dry_run_reports_ok_and_the_coverage(make_settings) -> None:
    def report_stage(ctx: StageContext) -> None:
        ctx.report.metrics.update(listed=10, counterparts=2, upcomingEvents=7)

    client = FakeClient()
    run_sync(
        settings=make_settings(),
        dry_run=True,
        registry=[Stage("discover", ok_stage), Stage("report", report_stage)],
        telemetry=telemetry(client),
    )

    assert_safe(client)
    (finished,) = client.named(RUN_FINISHED)
    assert finished["status"] == "success" and finished["dryRun"] is True
    assert finished["coverage"] == {"listed": 10, "counterparts": 2, "upcomingEvents": 7}


def test_a_failed_health_check_still_finishes_the_run_with_the_class_name(
    make_settings, net: respx.MockRouter
) -> None:
    net.get(f"{SITE}/api/pipeline/health").respond(401, json={"error": SCRAPED})
    settings = make_settings(convex_http_url=SITE, pipeline_api_key="test-key")
    client = FakeClient()

    with pytest.raises(load.ConvexAuthError):
        run_sync(settings=settings, registry=registry(), telemetry=telemetry(client))

    assert_safe(client)
    (finished,) = client.named(RUN_FINISHED)
    assert finished["status"] == "failed"
    assert finished["errorType"] == "ConvexAuthError"
    assert client.named(STAGE_COMPLETED) == []


def test_clean_properties_drops_unknown_keys_and_free_text() -> None:
    cleaned = clean_properties(
        STAGE_COMPLETED,
        {
            "stage": "talks_cam",
            "status": "ok",
            "error": SCRAPED,
            "notes": [SCRAPED],
            "errorType": "https://example.org/x",
            "metrics": {"talks": 4, "bad key!": 1, "flag": True, "title": "x"},
            "inserted": 3,
            "skipped": None,
        },
    )
    assert cleaned == {
        "stage": "talks_cam",
        "status": "ok",
        "metrics": {"talks": 4},
        "inserted": 3,
    }


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("stage", "Quantum gravity and the black hole information paradox"),
        ("errorType", "Joshua Fehn"),
        ("status", "Dr Example"),
        ("group", "my secret group"),
        ("runKey", "Talk title 2026"),
    ],
)
def test_title_like_strings_are_dropped_from_every_identifier(key: str, value: str) -> None:
    assert clean_properties(STAGE_COMPLETED, {key: value}) == {}


def test_a_run_where_every_stage_failed_is_failed(make_settings) -> None:
    client = FakeClient()
    run_sync(
        settings=make_settings(),
        dry_run=True,
        registry=[Stage("discover", failing_stage)],
        telemetry=telemetry(client),
    )
    assert client.named(RUN_FINISHED)[0]["status"] == "failed"


# --- never in the way ---------------------------------------------------------


def test_a_client_that_raises_never_reaches_the_run(make_settings) -> None:
    client = FakeClient(fail=True)
    tracked = telemetry(client)

    report = run_sync(
        settings=make_settings(), dry_run=True, registry=registry(), telemetry=tracked
    )
    tracked.close()

    assert report.ok
    assert client.flushes == [FLUSH_TIMEOUT] and client.shutdowns == 1


def test_a_client_that_cannot_be_built_turns_telemetry_off(make_settings) -> None:
    def factory(_settings: Settings) -> FakeClient:
        raise ValueError("bad host")

    built = HarvestTelemetry.from_settings(make_settings(posthog_key=KEY), client_factory=factory)
    assert not built.enabled


def test_unexpected_report_shapes_are_swallowed() -> None:
    client = FakeClient()
    tracked = telemetry(client)
    tracked.run_finished(object())  # type: ignore[arg-type]
    tracked.stage_completed(None, duration_s=1.0)  # type: ignore[arg-type]
    assert client.events == []


def test_close_returns_by_its_deadline_when_shutdown_hangs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The SDK's shutdown drains with no timeout (a slow host, a 429 with
    Retry-After); close() must still return within CLOSE_TIMEOUT."""
    assert CLOSE_TIMEOUT <= FLUSH_TIMEOUT + 1
    deadline = 0.3
    monkeypatch.setattr(telemetry_module, "CLOSE_TIMEOUT", deadline)
    release = threading.Event()

    class HangingClient(FakeClient):
        def shutdown(self) -> None:
            super().shutdown()
            release.wait(60)

    client = HangingClient()
    tracked = telemetry(client)
    started = time.monotonic()
    try:
        tracked.close()
        elapsed = time.monotonic() - started
    finally:
        release.set()

    assert deadline <= elapsed < deadline + 1
    assert client.flushes == [FLUSH_TIMEOUT] and client.shutdowns == 1
    assert not tracked.enabled


def test_close_is_idempotent_and_disables(make_settings) -> None:
    client = FakeClient()
    tracked = telemetry(client)
    tracked.close()
    tracked.close()
    tracked.run_aborted(RuntimeError("x"), group=None, command="sync")
    assert client.flushes == [FLUSH_TIMEOUT] and client.shutdowns == 1
    assert client.events == [] and not tracked.enabled


# --- the CLI owns the client: flushed on success and on every failure ----------


@pytest.fixture
def fake_client(monkeypatch: pytest.MonkeyPatch) -> FakeClient:
    client = FakeClient()
    monkeypatch.setattr(telemetry_module, "_posthog_client", lambda _settings: client)
    monkeypatch.setattr(telemetry_module, "_revision", lambda: "0123456789ab")
    return client


def invoke(settings: Settings, *args: str):
    return CliRunner().invoke(cli, list(args), obj={"settings": settings})


def test_the_cli_flushes_after_a_successful_run(
    make_settings, fake_client, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sync_module, "STAGES", [Stage("discover", ok_stage)])

    result = invoke(make_settings(posthog_key=KEY), "sync", "--dry-run")

    assert result.exit_code == 0, result.output
    assert fake_client.flushes == [FLUSH_TIMEOUT] and fake_client.shutdowns == 1
    assert [name for name, _ in fake_client.events] == [
        RUN_STARTED,
        STAGE_COMPLETED,
        AI_SPAN,
        RUN_FINISHED,
        AI_TRACE,
    ]
    assert fake_client.named(RUN_FINISHED)[0]["status"] == "success"


def test_the_cli_flushes_after_a_failing_stage(
    make_settings, fake_client, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sync_module, "STAGES", [Stage("boom", failing_stage)])

    result = invoke(make_settings(posthog_key=KEY), "sync", "--dry-run")

    assert result.exit_code == 1
    assert fake_client.flushes == [FLUSH_TIMEOUT] and fake_client.shutdowns == 1
    finished = fake_client.named(RUN_FINISHED)
    assert len(finished) == 1, "the ClickException does not send a second finish"
    assert finished[0]["status"] == "failed" and finished[0]["failedStages"] == ["boom"]
    assert SCRAPED not in json.dumps([kwargs for _, kwargs in fake_client.events])


@pytest.mark.parametrize(
    ("args", "error_type"),
    [
        (("sync", "--dry-run", "--stages", "nope"), "ValueError"),
        (("sync", "--group", "events", "--dry-run"), "ValueError"),
        (("sync",), "ConfigError"),
    ],
)
def test_a_run_that_never_started_is_reported_failed_and_flushed(
    make_settings, fake_client, args: tuple[str, ...], error_type: str
) -> None:
    result = invoke(make_settings(posthog_key=KEY), *args)

    assert result.exit_code == 1
    assert fake_client.flushes == [FLUSH_TIMEOUT] and fake_client.shutdowns == 1
    (finished,) = fake_client.named(RUN_FINISHED)
    assert finished["status"] == "failed" and finished["errorType"] == error_type
    assert set(finished) <= ALLOWED[RUN_FINISHED]


def test_an_unknown_group_is_not_sent(make_settings, fake_client) -> None:
    result = invoke(make_settings(posthog_key=KEY), "sync", "--group", "Dr Example", "--dry-run")

    assert result.exit_code == 1
    (finished,) = fake_client.named(RUN_FINISHED)
    assert "group" not in finished and finished["command"] == "sync"
    assert finished["errorType"] == "ValueError"
    assert "Example" not in json.dumps([kwargs for _, kwargs in fake_client.events])


def test_status_shows_the_posthog_key_only_as_set(make_settings) -> None:
    result = invoke(make_settings(posthog_key=KEY), "status")
    assert result.exit_code == 0, result.output
    assert KEY not in result.output
    assert "PostHog key:" in result.output and "https://eu.i.posthog.com" in result.output


def test_status_shows_a_blank_posthog_key_as_unset(make_settings) -> None:
    result = invoke(make_settings(posthog_key="   "), "status")
    assert result.exit_code == 0, result.output
    assert "(unset) (run telemetry)" in result.output


# --- campus, pillars, fetches (L6) ---------------------------------------------


def test_registry_vocabularies_are_mirrored() -> None:
    from camsocs_pipeline.pipeline.context import PHASES, PILLARS

    assert set(PHASES) == telemetry_module._PHASES
    assert set(PILLARS) == telemetry_module._PILLARS


def test_a_stage_reports_its_pillar_phase_yield_and_the_time_limit(
    make_settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(telemetry_module.TIME_LIMIT_ENV, "7200")
    client = FakeClient()
    run_sync(
        settings=make_settings(),
        dry_run=True,
        registry=[Stage("discover", ok_stage, phase="harvest", pillar="societies")],
        telemetry=telemetry(client),
    )

    assert_safe(client)
    (started,) = client.named(RUN_STARTED)
    assert started["timeLimitS"] == 7200 and started["campus"] == "cam"
    (stage,) = client.named(STAGE_COMPLETED)
    assert stage["pillar"] == "societies" and stage["phase"] == "harvest"
    assert stage["yield"] == 3, "inserted + updated + unchanged"
    assert client.named(SOURCE_FETCHED) == [], "a stage that fetched nothing sends none"


@pytest.mark.parametrize("value", ["", "soon", "-5", "1e9", "99999999"])
def test_a_time_limit_that_is_not_whole_seconds_is_left_out(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    monkeypatch.setenv(telemetry_module.TIME_LIMIT_ENV, value)
    client = FakeClient()
    telemetry(client).run_started(RunReport("k", "sync"), group=None, stages=[])
    assert "timeLimitS" not in client.named(RUN_STARTED)[0]


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("campus", "ox"),  # not a registered campus
        ("campus", "Cambridge"),
        ("pillar", "people"),
        ("phase", "scrape"),
        ("hostClass", "www.example.org"),
        ("hostClass", "https://example.org/x"),
    ],
)
def test_unknown_campuses_pillars_and_host_like_classes_are_dropped(key: str, value: str) -> None:
    assert clean_properties(SOURCE_FETCHED, {key: value}) == {}
    assert clean_properties(STAGE_COMPLETED, {key: value}) == {}


def test_a_stage_that_fetched_sends_one_event_per_host_class(make_settings, net) -> None:
    from camsocs_pipeline.sources.base import PoliteClient
    from camsocs_pipeline.sources.policy import SOCIETY_WEBSITE

    net.get("https://soc.example.org/robots.txt").respond(404)
    net.get("https://soc.example.org/events").respond(200, text="<p>events</p>")
    net.get("https://linktr.ee/robots.txt").respond(404)
    net.get("https://linktr.ee/somesoc").respond(404)

    def fetching(ctx: StageContext) -> None:
        with PoliteClient(
            user_agent="camsocs-test", cache_dir=ctx.settings.cache_dir, min_interval=0.0
        ) as client:
            client.fetch("https://soc.example.org/events", purpose=SOCIETY_WEBSITE)
            client.fetch("https://linktr.ee/somesoc")
        ctx.report.inserted += 1

    client = FakeClient()
    report = run_sync(
        settings=make_settings(),
        dry_run=True,
        registry=[Stage("website_events", fetching, phase="events", pillar="events")],
        telemetry=telemetry(client),
    )

    assert_safe(client)
    fetched = {props["hostClass"]: props for props in client.named(SOURCE_FETCHED)}
    assert set(fetched) == {"society_website", "linktree"}
    assert fetched["society_website"]["fetchRequests"] == 1
    assert fetched["society_website"]["fetchFetched"] == 1
    assert fetched["society_website"]["fetchStatus2xx"] == 1, "robots.txt is not a fetch"
    assert fetched["linktree"]["fetchNotFound"] == 1
    for props in fetched.values():
        assert props["stage"] == "website_events" and props["pillar"] == "events"
        assert props["campus"] == "cam" and props["durationS"] >= 0
    dumped = json.dumps(client.events)
    for host_or_path in ("example.org", "linktr.ee", "somesoc", "/events"):
        assert host_or_path not in dumped

    (stage,) = report.stages
    assert stage.metrics["fetchRequests"] == 2 and stage.metrics["hostsContacted"] == 2
    assert stage.to_payload()["durationMs"] >= 0
    (completed,) = client.named(STAGE_COMPLETED)
    assert completed["metrics"]["fetchRequests"] == 2
    for name in completed["metrics"]:
        assert telemetry_module._NAME.fullmatch(name) and name[0] not in "_$"
