"""`camsocs monitor` (ENG-10): four production checks against PostHog's query
API, each `ok`, `failed` or `unknown`; only a failure that was not already
paged for exits non-zero, and a PostHog outage never does.

A fake query client stands in for PostHog in the check tests; the HTTP client
and the command are tested against respx routes (never the network).
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
import respx
from click.testing import CliRunner

from camsocs_pipeline.cli import cli
from camsocs_pipeline.config import ConfigError
from camsocs_pipeline.monitor import (
    CHECK_NAMES,
    ERROR_SPIKE_MAX,
    NOT_INTERNAL,
    REALERT_AFTER,
    ZERO_RESULT_MIN_SEARCHES,
    CheckResult,
    PostHogQueryClient,
    QueryFailed,
    assess,
    run_checks,
)

HOST = "https://eu.posthog.test"
PROJECT = "4242"
QUERY_URL = f"{HOST}/api/projects/{PROJECT}/query/"
#: Not a real key; assembled so no key-shaped literal sits in the repo.
KEY = "phx" + "_" + "monitor-test-key-not-real"
NOW = datetime(2026, 11, 1, 12, 0, tzinfo=UTC)

#: Rows that pass every check: 3 exceptions, 1 recent harvest (2 h ago),
#: 40 searches of which 4 found nothing, 120 pageviews.
HEALTHY: dict[str, list[list[Any]]] = {
    "error_spike": [[3]],
    "stale_harvest": [[1, 120]],
    "zero_result_rate": [[40, 4]],
    "pageview_heartbeat": [[120]],
}


class FakeQueryClient:
    """Answers each check's query by the check's name (the query `name`)."""

    def __init__(self, answers: Mapping[str, list[list[Any]] | Exception]) -> None:
        self.answers = {**HEALTHY, **answers}
        self.queries: list[tuple[str, str]] = []

    def hogql(self, query: str, *, name: str) -> list[list[Any]]:
        self.queries.append((name, query))
        answer = self.answers[name.removeprefix("camsocs monitor ")]
        if isinstance(answer, Exception):
            raise answer
        return answer


def results(**answers: list[list[Any]] | Exception) -> dict[str, CheckResult]:
    return {r.name: r for r in run_checks(FakeQueryClient(answers))}


# --- the checks -----------------------------------------------------------------------------


def test_healthy_numbers_pass_every_check() -> None:
    found = results()
    assert list(found) == list(CHECK_NAMES)
    assert {r.status for r in found.values()} == {"ok"}
    assert found["stale_harvest"].detail == {"hoursSinceLastSuccess": 2.0}
    assert found["zero_result_rate"].value == 0.1


def test_every_query_counts_production_events_only() -> None:
    client = FakeQueryClient({})
    run_checks(client)
    assert len(client.queries) == len(CHECK_NAMES)
    for _name, query in client.queries:
        assert "properties.environment = 'production'" in query
        assert query.startswith("SELECT count")
        # Counts only: no property is selected, so none can be printed.
        assert "SELECT properties" not in query
        # Visitor-side checks leave out internal traffic (the Claude browser),
        # as the dashboards' test-account filter does; the harvester has none.
        assert (NOT_INTERNAL in query) == (_name != "camsocs monitor stale_harvest"), _name


@pytest.mark.parametrize(
    "answers, failing",
    [
        ({"error_spike": [[ERROR_SPIKE_MAX + 1]]}, "error_spike"),
        ({"stale_harvest": [[0, 31 * 60]]}, "stale_harvest"),
        ({"stale_harvest": [[0, None]]}, "stale_harvest"),
        ({"zero_result_rate": [[40, 21]]}, "zero_result_rate"),
        ({"pageview_heartbeat": [[0]]}, "pageview_heartbeat"),
    ],
)
def test_each_check_fails_past_its_threshold(answers: dict, failing: str) -> None:
    found = results(**answers)
    assert [name for name, r in found.items() if r.status == "failed"] == [failing]


def test_the_thresholds_are_strict() -> None:
    found = results(error_spike=[[ERROR_SPIKE_MAX]], zero_result_rate=[[40, 20]])
    assert found["error_spike"].status == "ok"
    assert found["zero_result_rate"].status == "ok", "exactly half is not above half"


def test_a_high_zero_result_rate_over_too_few_searches_is_not_a_failure() -> None:
    few = ZERO_RESULT_MIN_SEARCHES - 1
    found = results(zero_result_rate=[[few, few]])
    assert found["zero_result_rate"].status == "ok"
    assert found["zero_result_rate"].value == 1.0
    assert results(zero_result_rate=[[0, 0]])["zero_result_rate"].status == "ok"


@pytest.mark.parametrize(
    "answer, reason",
    [
        (QueryFailed("HTTP 503"), "HTTP 503"),
        (QueryFailed("ConnectTimeout"), "ConnectTimeout"),
        ([], "malformed answer"),
        ([[1, 2, 3]], "malformed answer"),
        ([["twelve"]], "malformed answer"),
        ([[True]], "malformed answer"),
    ],
)
def test_a_query_that_fails_makes_its_check_unknown(answer: Any, reason: str) -> None:
    found = results(error_spike=answer)
    assert found["error_spike"].status == "unknown"
    assert found["error_spike"].reason == reason
    assert found["error_spike"].value is None
    assert {r.status for name, r in found.items() if name != "error_spike"} == {"ok"}


def test_result_lines_carry_names_counts_and_thresholds_only() -> None:
    found = results(error_spike=[[34]], pageview_heartbeat=QueryFailed("HTTP 429"))
    assert found["error_spike"].line() == "error_spike: failed, 34 (fails when > 20, last 1 h)"
    assert found["pageview_heartbeat"].line() == (
        "pageview_heartbeat: unknown (HTTP 429; fails when < 1, last 48 h) — not paged"
    )


# --- paging -----------------------------------------------------------------------------------


def failing(*names: str) -> list[CheckResult]:
    answers: dict[str, Any] = {
        "error_spike": [[50]],
        "stale_harvest": [[0, None]],
        "pageview_heartbeat": [[0]],
    }
    return run_checks(FakeQueryClient({name: answers[name] for name in names}))


def paged_for(*names: str, at: datetime) -> dict[str, Any]:
    return {"alertedChecks": list(names), "lastAlertAt": at.strftime("%Y-%m-%dT%H:%M:%SZ")}


def test_a_new_failure_pages() -> None:
    verdict = assess(failing("error_spike"), {}, now=NOW)
    assert verdict.page and verdict.failed == ["error_spike"]
    payload = verdict.status_payload("0" * 32)
    assert payload["paged"] is True and payload["result"] == "failed"
    assert payload["alertedChecks"] == ["error_spike"]
    assert payload["lastAlertAt"] == "2026-11-01T12:00:00Z"
    assert payload["invocationId"] == "0" * 32


def test_the_same_failure_within_the_reminder_interval_does_not_page_again() -> None:
    previous = paged_for("stale_harvest", at=NOW - timedelta(hours=2))
    verdict = assess(failing("stale_harvest"), previous, now=NOW)
    assert not verdict.page
    payload = verdict.status_payload()
    assert payload["result"] == "failed" and payload["failedChecks"] == ["stale_harvest"]
    assert payload["lastAlertAt"] == "2026-11-01T10:00:00Z", "the page it refers to"


def test_a_failure_reminds_after_the_interval() -> None:
    previous = paged_for("stale_harvest", at=NOW - REALERT_AFTER)
    assert assess(failing("stale_harvest"), previous, now=NOW).page


def test_another_check_failing_pages_at_once() -> None:
    previous = paged_for("stale_harvest", at=NOW - timedelta(minutes=30))
    verdict = assess(failing("stale_harvest", "error_spike"), previous, now=NOW)
    assert verdict.page and verdict.alerted == ["error_spike", "stale_harvest"]


def test_recovery_forgets_the_last_page() -> None:
    previous = paged_for("error_spike", at=NOW - timedelta(minutes=30))
    verdict = assess(run_checks(FakeQueryClient({})), previous, now=NOW)
    assert not verdict.page and verdict.alerted == [] and verdict.last_alert_at is None
    assert assess(failing("error_spike"), verdict.status_payload(), now=NOW).page


def test_a_posthog_blip_during_a_lasting_failure_does_not_page_twice() -> None:
    first = assess(failing("stale_harvest"), {}, now=NOW - timedelta(hours=2))
    assert first.page
    blip = {"stale_harvest": QueryFailed("HTTP 503")}
    second = assess(
        run_checks(FakeQueryClient(blip)), first.status_payload(), now=NOW - timedelta(hours=1)
    )
    assert not second.page and second.result == "unknown"
    assert second.alerted == ["stale_harvest"], "an unknown check is not a recovery"
    assert second.last_alert_at == NOW - timedelta(hours=2)
    third = assess(failing("stale_harvest"), second.status_payload(), now=NOW)
    assert not third.page


def test_a_check_that_recovers_and_fails_again_pages_while_another_still_fails() -> None:
    first = assess(failing("error_spike", "stale_harvest"), {}, now=NOW - timedelta(hours=2))
    assert first.page
    second = assess(failing("stale_harvest"), first.status_payload(), now=NOW - timedelta(hours=1))
    assert not second.page and second.alerted == ["stale_harvest"]
    third = assess(failing("error_spike", "stale_harvest"), second.status_payload(), now=NOW)
    assert third.page and third.alerted == ["error_spike", "stale_harvest"]


def test_a_new_page_keeps_a_paged_check_that_is_unknown_in_memory() -> None:
    first = assess(failing("stale_harvest"), {}, now=NOW - timedelta(hours=2))
    mixed = run_checks(
        FakeQueryClient({"stale_harvest": QueryFailed("HTTP 503"), "error_spike": [[50]]})
    )
    second = assess(mixed, first.status_payload(), now=NOW - timedelta(hours=1))
    assert second.page and second.alerted == ["error_spike", "stale_harvest"]
    assert not assess(
        failing("error_spike", "stale_harvest"), second.status_payload(), now=NOW
    ).page


def test_unknown_checks_never_page() -> None:
    down = {name: QueryFailed("ConnectError") for name in CHECK_NAMES}
    verdict = assess(run_checks(FakeQueryClient(down)), {}, now=NOW)
    assert not verdict.page and verdict.result == "unknown"
    assert verdict.unknown == list(CHECK_NAMES)


@pytest.mark.parametrize(
    "previous",
    [
        {"alertedChecks": "error_spike", "lastAlertAt": "2026-11-01T11:00:00Z"},
        {"alertedChecks": ["error_spike"], "lastAlertAt": "yesterday"},
        {"alertedChecks": ["error_spike"], "lastAlertAt": "2026-11-02T11:00:00Z"},
    ],
)
def test_a_status_file_that_makes_no_sense_pages(previous: dict) -> None:
    assert assess(failing("error_spike"), previous, now=NOW).page


# --- the HTTP client --------------------------------------------------------------------------


def client() -> PostHogQueryClient:
    return PostHogQueryClient(HOST, PROJECT, KEY)


def test_the_client_posts_a_fresh_hogql_query_with_the_bearer_key(net: respx.MockRouter) -> None:
    route = net.post(QUERY_URL).respond(200, json={"results": [[7]], "columns": ["count()"]})
    with client() as posthog:
        assert posthog.hogql("SELECT count() FROM events", name="probe") == [[7]]
    request = route.calls.last.request
    assert request.headers["Authorization"] == f"Bearer {KEY}"
    assert json.loads(request.content) == {
        "query": {"kind": "HogQLQuery", "query": "SELECT count() FROM events"},
        "name": "probe",
        "refresh": "force_blocking",
    }


@pytest.mark.parametrize(
    "response, reason",
    [
        (httpx.Response(500, text="ClickHouse said: SELECT secret FROM x"), "HTTP 500"),
        (httpx.Response(429, json={"detail": "budget"}), "HTTP 429"),
        (httpx.Response(200, text="<html>"), "malformed answer"),
        (httpx.Response(200, json={"results": "nope"}), "malformed answer"),
        (httpx.ConnectError("no route to host"), "ConnectError"),
        (httpx.ReadTimeout("slow"), "ReadTimeout"),
    ],
)
def test_the_client_reports_a_failure_by_status_or_class_only(
    net: respx.MockRouter, response: Any, reason: str
) -> None:
    net.post(QUERY_URL).mock(side_effect=[response])
    with client() as posthog, pytest.raises(QueryFailed) as raised:
        posthog.hogql("SELECT 1", name="probe")
    assert str(raised.value) == reason


def test_a_project_id_that_is_not_a_number_is_a_config_error() -> None:
    with pytest.raises(ConfigError, match="numeric"):
        PostHogQueryClient(HOST, "camsocs", KEY)


# --- the command --------------------------------------------------------------------------------


def answer_by_name(answers: Mapping[str, Any]):
    """A respx side effect answering each check's query by its name."""

    def respond(request: httpx.Request) -> httpx.Response:
        name = json.loads(request.content)["name"].removeprefix("camsocs monitor ")
        rows = {**HEALTHY, **answers}[name]
        if isinstance(rows, int):
            return httpx.Response(rows, text="server trouble with SELECT secret")
        return httpx.Response(200, json={"results": rows})

    return respond


def invoke(settings, *args: str):
    return CliRunner().invoke(cli, ["monitor", *args], obj={"settings": settings})


@pytest.fixture
def configured(make_settings):
    return make_settings(
        posthog_personal_api_key=KEY, posthog_project_id=PROJECT, posthog_app_host=HOST
    )


def test_without_a_key_the_monitor_checks_nothing_and_succeeds(
    make_settings, net: respx.MockRouter
) -> None:
    result = invoke(make_settings(posthog_project_id=PROJECT))
    assert result.exit_code == 0, result.output
    assert "not set; nothing checked" in result.output
    assert not net.calls


def test_all_checks_passing_exit_zero_and_write_the_status(
    configured, net: respx.MockRouter, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("INVOCATION_ID", "a" * 32)
    net.post(QUERY_URL).mock(side_effect=answer_by_name({}))
    status = tmp_path / "status-monitor.json"

    result = invoke(configured, "--status-json", str(status))

    assert result.exit_code == 0, result.output
    assert "monitor: error_spike: ok, 3" in result.output
    written = json.loads(status.read_text())
    assert written["result"] == "ok" and written["invocationId"] == "a" * 32
    assert [c["name"] for c in written["checks"]] == list(CHECK_NAMES)
    assert KEY not in result.output and KEY not in status.read_text()


def test_a_failing_check_exits_one_then_waits_for_the_reminder(
    configured, net: respx.MockRouter, tmp_path: Path
) -> None:
    net.post(QUERY_URL).mock(side_effect=answer_by_name({"pageview_heartbeat": [[0]]}))
    status = tmp_path / "status-monitor.json"

    first = invoke(configured, "--status-json", str(status))
    assert first.exit_code == 1
    assert "check failed: pageview_heartbeat" in first.output
    assert json.loads(status.read_text())["paged"] is True

    second = invoke(configured, "--status-json", str(status))
    assert second.exit_code == 0, second.output
    assert "still failing: pageview_heartbeat" in second.output
    assert json.loads(status.read_text())["paged"] is False


def test_without_a_status_file_every_failure_pages(configured, net: respx.MockRouter) -> None:
    net.post(QUERY_URL).mock(side_effect=answer_by_name({"error_spike": [[99]]}))
    assert invoke(configured).exit_code == 1
    assert invoke(configured).exit_code == 1


def test_a_posthog_outage_warns_but_exits_zero(configured, net: respx.MockRouter) -> None:
    net.post(QUERY_URL).mock(side_effect=answer_by_name(dict.fromkeys(CHECK_NAMES, 503)))
    result = invoke(configured)
    assert result.exit_code == 0, result.output
    assert "not checked, PostHog did not answer" in result.output
    assert "SELECT secret" not in result.output, "never PostHog's body"


def test_status_shows_the_personal_key_only_as_set(configured) -> None:
    result = CliRunner().invoke(cli, ["status"], obj={"settings": configured})
    assert result.exit_code == 0, result.output
    assert "PostHog personal key:" in result.output and "set (monitor)" in result.output
    assert KEY not in result.output
