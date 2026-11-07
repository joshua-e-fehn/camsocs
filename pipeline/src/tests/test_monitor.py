"""`camsocs monitor` (ENG-10, ENG-33): four production checks against
PostHog's query API and two status checks of the site, each `ok`, `failed`
or `unknown`, and a count of new listing requests. Only a failure that was
not already paged for, a site check's recovery or a new request exits
non-zero, and a PostHog outage never does. Every query is scoped to the
run's campus (D8); the scraper-health checks run in shadow (D9): printed,
never in the status file, never paging (canned rows: one breach and one pass
each).

A fake query client stands in for PostHog in the check tests; the HTTP client
and the command are tested against respx routes (never the network).
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Mapping
from datetime import UTC, datetime, timedelta
from itertools import pairwise
from pathlib import Path
from typing import Any

import httpx
import pytest
import respx
from click.testing import CliRunner

from camsocs_pipeline import monitor
from camsocs_pipeline.campuses import CAMBRIDGE
from camsocs_pipeline.cli import cli
from camsocs_pipeline.config import ConfigError, Settings
from camsocs_pipeline.models.vocab import LISTING_REQUEST_KINDS
from camsocs_pipeline.monitor import (
    CHECK_NAMES,
    ERROR_SPIKE_MAX,
    NOT_DRY_RUN,
    NOT_INTERNAL,
    REALERT_AFTER,
    REQUESTS_FIRST_WINDOW,
    REQUESTS_LAG,
    REQUESTS_MAX_WINDOW,
    SITE_ATTEMPTS,
    SITE_CHECK_NAMES,
    SITE_CHECKS,
    ZERO_RESULT_MIN_SEARCHES,
    Check,
    CheckResult,
    PostHogQueryClient,
    QueryFailed,
    RequestCount,
    assess,
    camel,
    campus_filter,
    check_site,
    check_sites,
    checks_for,
    count_requests,
    requests_query,
    requests_window,
    run_checks,
    run_shadow_checks,
    shadow_checks_for,
    site_client,
)
from tests.campus_zz import ZZ, registered

HOST = "https://eu.posthog.test"
PROJECT = "4242"
QUERY_URL = f"{HOST}/api/projects/{PROJECT}/query/"
#: Not a real key; assembled so no key-shaped literal sits in the repo.
KEY = "phx" + "_" + "monitor-test-key-not-real"
NOW = datetime(2026, 11, 1, 12, 0, tzinfo=UTC)

#: Rows for a query, or a function of the query's text giving them (the
#: requests query, whose answer echoes its window's bounds).
Rows = list[list[Any]] | Callable[[str], list[list[Any]]]


def requests_row(total: int, **kinds: int) -> Callable[[str], list[list[Any]]]:
    """The requests query's answer: the total, a count per kind, then the
    window's two bounds as PostHog reads them back (`toDateTime` echoed)."""

    def answer(query: str) -> list[list[Any]]:
        bounds = re.findall(r"toDateTime\('([^']+)'\)", query)[:2]
        return [[total, *(kinds.get(kind, 0) for kind in LISTING_REQUEST_KINDS), *bounds]]

    return answer


#: Rows that pass every check: 3 exceptions, 1 recent harvest (2 h ago),
#: 40 searches of which 4 found nothing, 120 pageviews, no new request; and
#: every shadow check (D9) healthy: a daily stage yielding as usual, fetching
#: cleanly, a run well inside its limit, few model errors and fallbacks.
HEALTHY: dict[str, Rows] = {
    "error_spike": [[3]],
    "stale_harvest": [[1, 120]],
    "zero_result_rate": [[40, 4]],
    "pageview_heartbeat": [[120]],
    "listing_requests": requests_row(0),
    "stale_harvest_events": [[1, 120]],
    "stale_harvest_full": [[1, 3000]],
    "yield_drop": [
        ["calendar_feeds", 60, 100],
        ["calendar_feeds", 1500, 90],
        ["calendar_feeds", 2900, 110],
        ["calendar_feeds", 4300, 100],
    ],
    "stage_freshness": [["calendar_feeds", 600]],
    "fetch_error_rate": [["calendar_feeds", 100, 3]],
    "rate_limited": [["calendar_feeds", 2]],
    "robots_block_jump": [["calendar_feeds", 60, 1], ["calendar_feeds", 1500, 1]],
    "run_duration": [["events", 1800]],
    "llm_error_rate": [[100, 2]],
    "llm_fallback_rate": [[80, 5]],
}


def rows_for(answer: Rows, query: str) -> list[list[Any]]:
    return answer(query) if callable(answer) else answer


class FakeQueryClient:
    """Answers each check's query by the check's name (the query `name`)."""

    def __init__(self, answers: Mapping[str, Rows | Exception]) -> None:
        self.answers = {**HEALTHY, **answers}
        self.queries: list[tuple[str, str]] = []

    def hogql(self, query: str, *, name: str) -> list[list[Any]]:
        self.queries.append((name, query))
        answer = self.answers[name.removeprefix("camsocs monitor ")]
        if isinstance(answer, Exception):
            raise answer
        return rows_for(answer, query)


def results(**answers: Rows | Exception) -> dict[str, CheckResult]:
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


# --- new listing requests (ENG-33) -------------------------------------------------------


def test_the_requests_query_counts_production_requests_by_kind_between_two_instants() -> None:
    query = requests_query(NOW - timedelta(hours=1), NOW)
    assert query.startswith("SELECT count(), countIf(properties.kind = 'claim')")
    assert query.count("countIf(") == len(LISTING_REQUEST_KINDS)
    assert "event LIKE 'listing_request_received'" in query
    assert "properties.environment = 'production'" in query
    # On ingestion time, so a backlog cannot slip a request into a window
    # already counted; the event's own time only narrows the scan.
    assert "created_at > toDateTime('2026-11-01T11:00:00Z')" in query
    assert "created_at <= toDateTime('2026-11-01T12:00:00Z')" in query
    assert "timestamp > now() - INTERVAL 31 DAY" in query
    assert "timestamp > toDateTime" not in query and "timestamp <= toDateTime" not in query
    # The bounds come back too, so a bound PostHog could not read is seen.
    assert ", toDateTime('2026-11-01T11:00:00Z'), toDateTime('2026-11-01T12:00:00Z') FROM" in query
    # Counts only: no property is selected, so none can be printed.
    assert "SELECT properties" not in query and "GROUP BY" not in query


def test_requests_are_counted_by_kind_and_a_kind_the_vocabulary_lacks_as_other() -> None:
    client = FakeQueryClient({"listing_requests": requests_row(4, claim=1, remove=2)})
    found = count_requests(client, NOW - timedelta(hours=1), NOW)
    assert found.status == "ok" and found.total == 4
    assert dict(found.by_kind) == {"claim": 1, "remove": 2, "other": 1}
    assert found.counted_until == NOW
    assert found.line() == (
        "listing_requests: 4 new (claim 1, remove 2, other 1), "
        "2026-11-01T11:00:00Z to 2026-11-01T12:00:00Z"
    )
    assert found.to_json()["byKind"] == {"claim": 1, "remove": 2, "other": 1}


@pytest.mark.parametrize(
    "answer, reason",
    [
        (QueryFailed("HTTP 503"), "HTTP 503"),
        ([], "malformed answer"),
        ([[1, 1]], "malformed answer"),
        ([[0, 0, 0, 0, 0, 0]], "malformed answer"),
        (lambda query: [["1", *requests_row(0)(query)[0][1:]]], "malformed answer"),
        # toDateTime of a string PostHog could not parse is NULL: every row
        # misses, and the 0 it counts is not to be believed.
        ([[0, 0, 0, 0, 0, 0, None, "2026-11-01T12:00:00Z"]], "malformed answer"),
        ([[0, 0, 0, 0, 0, 0, "2026-11-01T11:00:00Z", None]], "malformed answer"),
        # Read as another instant (a timezone taken wrongly).
        (
            [[0, 0, 0, 0, 0, 0, "2026-11-01T11:00:00+01:00", "2026-11-01T12:00:00Z"]],
            "malformed answer",
        ),
    ],
)
def test_requests_posthog_cannot_count_are_left_for_the_next_run(answer: Any, reason: str) -> None:
    since = NOW - timedelta(hours=1)
    found = count_requests(FakeQueryClient({"listing_requests": answer}), since, NOW)
    assert found.status == "unknown" and found.reason == reason
    assert found.counted_until == since, "the cursor stays where it was"
    assert found.to_json()["total"] is None


@pytest.mark.parametrize(
    "start, end",
    [
        ("2026-11-01T11:00:00+00:00", "2026-11-01T12:00:00.000000Z"),
        ("2026-11-01T12:00:00+01:00", "2026-11-01T13:00:00+01:00"),
        # No offset: the project's own timezone, which cannot be compared.
        ("2026-11-01 11:00:00", "2026-11-01 12:00:00"),
    ],
)
def test_bounds_read_back_in_any_form_of_the_same_instant_are_believed(
    start: str, end: str
) -> None:
    answer = [[1, 1, 0, 0, 0, 0, start, end]]
    found = count_requests(
        FakeQueryClient({"listing_requests": answer}), NOW - timedelta(hours=1), NOW
    )
    assert found.status == "ok" and dict(found.by_kind) == {"claim": 1}


def test_an_empty_window_asks_posthog_nothing() -> None:
    client = FakeQueryClient({})
    found = count_requests(client, NOW, NOW)
    assert found.status == "ok" and found.total == 0 and not client.queries


def cursor(at: datetime) -> dict[str, Any]:
    return {"requestsCountedUntil": at.strftime("%Y-%m-%dT%H:%M:%SZ")}


def test_without_a_cursor_the_window_is_the_last_hour_before_the_lag() -> None:
    for previous in ({}, {"requestsCountedUntil": "yesterday"}, {"requestsCountedUntil": 3}):
        assert requests_window(previous, now=NOW) == (
            NOW - REQUESTS_LAG - REQUESTS_FIRST_WINDOW,
            NOW - REQUESTS_LAG,
        )


def test_a_window_starts_where_the_last_one_ended_and_never_reaches_back_a_month() -> None:
    last = NOW - timedelta(minutes=83)
    assert requests_window(cursor(last), now=NOW) == (last, NOW - REQUESTS_LAG)
    long_ago = NOW - timedelta(days=90)
    since, until = requests_window(cursor(long_ago), now=NOW)
    assert until - since == REQUESTS_MAX_WINDOW


def test_a_cursor_after_the_window_counts_nothing_twice() -> None:
    ahead = NOW + timedelta(hours=1)
    since, until = requests_window(cursor(ahead), now=NOW)
    assert since == until == ahead
    found = count_requests(FakeQueryClient({}), since, until)
    assert found.counted_until == ahead


def test_consecutive_runs_count_every_instant_exactly_once() -> None:
    """Runs at uneven gaps (a missed hour, a run by hand), one of them
    without an answer from PostHog: the counted windows meet end to end."""
    previous: dict[str, Any] = {}
    counted: list[tuple[datetime, datetime]] = []
    at = NOW
    runs = [(0, None), (45, None), (75, QueryFailed("HTTP 503")), (60, None), (52, None)]
    for gap, answer in runs:
        at += timedelta(minutes=gap)
        client = FakeQueryClient({"listing_requests": answer} if answer else {})
        found = count_requests(client, *requests_window(previous, now=at))
        verdict = assess(run_checks(client), previous, now=at, requests=found)
        if found.status == "ok":
            counted.append((found.since, found.until))
        previous = verdict.status_payload()
    for (_start, end), (start, _end) in pairwise(counted):
        assert start == end
    assert counted[-1][1] == at - REQUESTS_LAG


def test_a_new_request_pages_with_its_counts_and_none_does_not() -> None:
    found = RequestCount("ok", NOW - timedelta(hours=1), NOW, {"remove": 1})
    verdict = assess(run_checks(FakeQueryClient({})), {}, now=NOW, requests=found)
    assert verdict.page and not verdict.checks_page and verdict.result == "ok"
    assert verdict.reasons() == ["new listing requests: 1"]
    payload = verdict.status_payload()
    assert payload["paged"] is True and payload["checksPaged"] is False
    assert payload["requests"]["total"] == 1 and payload["requests"]["byKind"] == {"remove": 1}
    assert payload["requestsCountedUntil"] == "2026-11-01T12:00:00Z"
    quiet = RequestCount("ok", NOW - timedelta(hours=1), NOW)
    assert not assess(run_checks(FakeQueryClient({})), {}, now=NOW, requests=quiet).page


def test_requests_posthog_did_not_count_never_page_but_are_reported_unknown() -> None:
    since = NOW - timedelta(hours=1)
    found = RequestCount("unknown", since, NOW, {}, "HTTP 503")
    verdict = assess(run_checks(FakeQueryClient({})), {}, now=NOW, requests=found)
    assert not verdict.page and verdict.unknown == ["listing_requests"]
    assert verdict.status_payload()["requestsCountedUntil"] == "2026-11-01T11:00:00Z"


def test_a_request_does_not_repeat_the_page_of_a_check_still_failing() -> None:
    previous = paged_for("stale_harvest", at=NOW - timedelta(hours=2))
    found = RequestCount("ok", NOW - timedelta(hours=1), NOW, {"claim": 2})
    verdict = assess(failing("stale_harvest"), previous, now=NOW, requests=found)
    assert verdict.page and not verdict.checks_page
    assert verdict.alerted == ["stale_harvest"]
    assert verdict.last_alert_at == NOW - timedelta(hours=2), "the reminder clock is unchanged"
    assert "still failing: stale_harvest" in "\n".join(monitor.summary(verdict))


# --- the site checks (ENG-33) -------------------------------------------------------------


HOME, SOCIETIES = (url for _name, url in SITE_CHECKS)


def no_pause(_seconds: float) -> None:
    pass


def site(net: respx.MockRouter, *answers: Any, url: str = HOME) -> CheckResult:
    route = net.head(url).mock(side_effect=list(answers))
    with site_client() as client:
        found = check_site(client, "site_home", url, pause=no_pause)
    assert route.call_count == len(answers)
    return found


def test_the_site_checks_ask_the_home_and_a_listing_page() -> None:
    assert SITE_CHECKS == (
        ("site_home", "https://camsocs.uk/"),
        ("site_societies", "https://camsocs.uk/societies"),
    )
    assert SITE_CHECK_NAMES == ("site_home", "site_societies")


def test_a_page_that_answers_200_passes_with_one_head_request(net: respx.MockRouter) -> None:
    found = site(net, httpx.Response(200))
    assert found.status == "ok" and found.value == 200 and found.detail == {"attempts": 1}
    request = net.calls.last.request
    assert request.method == "HEAD", "a HEAD has no body: no page text ever arrives"
    assert request.headers["User-Agent"].startswith("camsocs-monitor/")
    assert found.line() == "site_home: ok, 200 (fails when != 200), attempts 1"


def test_one_failure_is_asked_again_once(net: respx.MockRouter) -> None:
    paused: list[float] = []
    route = net.head(HOME).mock(side_effect=[httpx.ConnectTimeout("slow"), httpx.Response(200)])
    with site_client() as client:
        found = check_site(client, "site_home", HOME, pause=paused.append)
    assert found.status == "ok" and found.detail == {"attempts": 2}
    assert route.call_count == SITE_ATTEMPTS and paused == [monitor.SITE_RETRY_PAUSE]


@pytest.mark.parametrize(
    "answer, value, reason",
    [
        (httpx.Response(503, text="<h1>talk titles</h1>"), 503, "HTTP 503"),
        (httpx.Response(308, headers={"Location": "https://elsewhere.example/"}), 308, "HTTP 308"),
        (httpx.ConnectError("no route to host"), 0, "ConnectError"),
        (httpx.ReadTimeout("slow"), 0, "ReadTimeout"),
    ],
)
def test_a_page_that_fails_twice_fails_by_status_or_class_only(
    net: respx.MockRouter, answer: Any, value: int, reason: str
) -> None:
    found = site(net, answer, answer)
    assert found.status == "failed" and found.value == value and found.reason == reason
    assert found.announce_recovery
    line = found.line()
    assert line == f"site_home: failed, {value} (fails when != 200), attempts 2; {reason}"
    assert "talk" not in line and "elsewhere" not in line
    assert found.to_json()["windowHours"] is None


def site_results(**down: bool) -> list[CheckResult]:
    def answer(name: str) -> CheckResult:
        ok = not down.get(name)
        return CheckResult(
            name, "ok" if ok else "failed", 200 if ok else 503, 200, "ne", None,
            {"attempts": 1 if ok else 2}, None if ok else "HTTP 503", announce_recovery=True,
        )  # fmt: skip

    return [*run_checks(FakeQueryClient({})), *(answer(name) for name in SITE_CHECK_NAMES)]


def test_a_site_outage_pages_once_then_its_recovery_pages_once() -> None:
    hour = timedelta(hours=1)
    down = assess(site_results(site_home=True), {}, now=NOW)
    assert down.page and down.alerted == ["site_home"] and down.recovered == []
    still = assess(site_results(site_home=True), down.status_payload(), now=NOW + hour)
    assert not still.page
    back = assess(site_results(), still.status_payload(), now=NOW + 2 * hour)
    assert back.page and back.recovered == ["site_home"] and not back.checks_page
    assert back.alerted == [] and back.reasons() == ["recovered: site_home"]
    assert back.status_payload()["recoveredChecks"] == ["site_home"]
    again = assess(site_results(), back.status_payload(), now=NOW + 3 * hour)
    assert not again.page and again.recovered == []


def test_only_a_site_check_announces_its_recovery() -> None:
    previous = paged_for("error_spike", "site_societies", at=NOW - timedelta(minutes=30))
    verdict = assess(site_results(), previous, now=NOW)
    assert verdict.recovered == ["site_societies"]


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
        query = json.loads(request.content)["query"]["query"]
        return httpx.Response(200, json={"results": rows_for(rows, query)})

    return respond


def invoke(settings, *args: str):
    return CliRunner().invoke(cli, ["monitor", *args], obj={"settings": settings})


@pytest.fixture
def configured(make_settings, net: respx.MockRouter, monkeypatch: pytest.MonkeyPatch):
    """Settings with the key; the site answers 200 unless a test says otherwise."""
    monkeypatch.setattr(monitor, "SITE_RETRY_PAUSE", 0)
    for _name, url in SITE_CHECKS:
        net.head(url).respond(200)
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
    assert [c["name"] for c in written["checks"]] == [*CHECK_NAMES, *SITE_CHECK_NAMES]
    assert "monitor: site_home: ok, 200" in result.output
    assert "monitor: listing_requests: none new" in result.output
    assert written["requests"]["status"] == "ok" and written["requestsCountedUntil"]
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


def test_new_requests_exit_one_and_the_next_run_counts_from_where_this_one_stopped(
    configured, net: respx.MockRouter, tmp_path: Path
) -> None:
    route = net.post(QUERY_URL).mock(
        side_effect=answer_by_name({"listing_requests": requests_row(2, claim=1, object=1)})
    )
    status = tmp_path / "status-monitor.json"

    first = invoke(configured, "--status-json", str(status))
    assert first.exit_code == 1
    assert "new listing requests: 2" in first.output
    assert "listing_requests: 2 new (claim 1, object 1)" in first.output
    written = json.loads(status.read_text())
    assert written["result"] == "ok" and written["paged"] is True
    assert written["checksPaged"] is False

    invoke(configured, "--status-json", str(status))
    windows = [
        json.loads(call.request.content)["query"]["query"]
        for call in route.calls
        if json.loads(call.request.content)["name"] == "camsocs monitor listing_requests"
    ]
    assert len(windows) == 2
    first_until = written["requestsCountedUntil"]
    assert f"created_at <= toDateTime('{first_until}')" in windows[0]
    assert f"created_at > toDateTime('{first_until}')" in windows[1]


def test_the_site_down_pages_and_its_recovery_pages_once(
    configured, net: respx.MockRouter, tmp_path: Path
) -> None:
    net.post(QUERY_URL).mock(side_effect=answer_by_name({}))
    status = tmp_path / "status-monitor.json"
    net.head(SOCIETIES).mock(side_effect=[httpx.Response(502)] * 4 + [httpx.Response(200)] * 2)

    down = invoke(configured, "--status-json", str(status))
    assert down.exit_code == 1 and "check failed: site_societies" in down.output
    assert "site_societies: failed, 502" in down.output
    assert invoke(configured, "--status-json", str(status)).exit_code == 0, "still down"

    back = invoke(configured, "--status-json", str(status))
    assert back.exit_code == 1 and "recovered: site_societies" in back.output
    assert json.loads(status.read_text())["recoveredChecks"] == ["site_societies"]
    assert invoke(configured, "--status-json", str(status)).exit_code == 0


def test_the_site_checks_run_in_order(net: respx.MockRouter) -> None:
    for _name, url in SITE_CHECKS:
        net.head(url).respond(200)
    with site_client() as client:
        found = check_sites(client, pause=no_pause)
    assert [r.name for r in found] == list(SITE_CHECK_NAMES)
    assert [str(call.request.url) for call in net.calls] == [HOME, SOCIETIES]


# --- one campus per run (D8) -------------------------------------------------------------------


CAM_CLAUSE = " AND ifNull(properties.campus, 'cam') = 'cam'"


def all_queries(profile=CAMBRIDGE) -> dict[str, str]:
    queries = {c.name: c.query for c in (*checks_for(profile), *shadow_checks_for(profile))}
    queries["listing_requests"] = requests_query(NOW - timedelta(hours=1), NOW, profile.id)
    return queries


def test_cambridges_paging_queries_are_the_old_ones_with_the_campus_clause() -> None:
    """The four paging checks count exactly what they counted before the
    seam: the only change is the campus clause, true of every event so far."""
    production = " AND properties.environment = 'production'"
    before = {
        "error_spike": "SELECT count() FROM events WHERE event = '$exception'"
        + production + NOT_INTERNAL
        + " AND timestamp > now() - INTERVAL 60 MINUTE",
        "stale_harvest": "SELECT countIf(timestamp > now() - INTERVAL 26 HOUR),"
        " if(count() = 0, NULL, dateDiff('minute', max(timestamp), now()))"
        " FROM events WHERE event = 'harvest_run_finished'" + production
        + " AND properties.status IN ('success', 'partial')"
        " AND ifNull(toString(properties.dryRun), '') != 'true'"
        " AND timestamp > now() - INTERVAL 30 DAY",
        "zero_result_rate": "SELECT countIf(event = 'search_performed'),"
        " countIf(event = 'search_zero_results')"
        " FROM events WHERE event IN ('search_performed', 'search_zero_results')"
        + production + NOT_INTERNAL + " AND timestamp > now() - INTERVAL 24 HOUR",
        "pageview_heartbeat": "SELECT count() FROM events WHERE event = '$pageview'"
        + production + NOT_INTERNAL + " AND timestamp > now() - INTERVAL 48 HOUR",
    }  # fmt: skip
    for check in cambridge_checks():
        assert check.query.replace(CAM_CLAUSE, "", 1) == before[check.name], check.name
        assert check.query.count(CAM_CLAUSE) == 1


def cambridge_checks() -> tuple[Check, ...]:
    """`monitor.CHECKS`, after checking it is Cambridge's paging checks."""
    assert checks_for(CAMBRIDGE) == monitor.CHECKS
    return monitor.CHECKS


def test_the_paging_checks_are_unchanged_and_the_new_ones_are_all_shadow() -> None:
    assert CHECK_NAMES == ("error_spike", "stale_harvest", "zero_result_rate", "pageview_heartbeat")
    assert [c.name for c in checks_for(CAMBRIDGE)] == list(CHECK_NAMES)
    assert not any(c.shadow for c in checks_for(CAMBRIDGE))
    shadow = shadow_checks_for(CAMBRIDGE)
    assert tuple(c.name for c in shadow) == monitor.SHADOW_CHECKS
    assert set(monitor.SHADOW_CHECKS) == {
        "stale_harvest_events", "stale_harvest_full", "yield_drop", "stage_freshness",
        "fetch_error_rate", "rate_limited", "robots_block_jump", "run_duration",
        "llm_error_rate", "llm_fallback_rate",
    }  # fmt: skip
    assert all(c.shadow for c in shadow)


def test_every_query_is_scoped_to_the_campus_and_every_harvest_query_leaves_out_dry_runs() -> None:
    for name, query in all_queries().items():
        assert query.count(CAM_CLAUSE) == 1, name
        assert "properties.environment = 'production'" in query, name
        if "harvest_" in query or "$ai_generation" in query:
            assert NOT_DRY_RUN in query, name


def test_a_second_campus_queries_its_own_events_and_checks_its_own_site() -> None:
    with registered():
        queries = all_queries(ZZ)
        for name, query in queries.items():
            assert " AND ifNull(properties.campus, 'cam') = 'zz'" in query, name
            assert "= 'cam'" not in query, name
        # zz schedules both groups, so both stale checks exist for it too.
        assert {"stale_harvest_events", "stale_harvest_full"} <= set(queries)
    assert ZZ.branding.monitor_urls == (("site_home", "https://zz.localhost/"),)


@pytest.mark.parametrize("campus", ["CAM", "c", "cam'--", "toolongname", ""])
def test_a_campus_id_of_any_other_shape_never_reaches_a_query(campus: str) -> None:
    with pytest.raises(ConfigError):
        campus_filter(campus)


def test_the_status_file_names_the_campus_and_its_site() -> None:
    verdict = assess(
        run_checks(FakeQueryClient({})), {}, now=NOW, campus="cam", site="https://camsocs.uk"
    )
    payload = verdict.status_payload()
    assert payload["campus"] == "cam" and payload["site"] == "https://camsocs.uk"
    # The alert builds the inbox link from `site`: the same as Cambridge's.
    assert f"{payload['site']}/dashboard/requests" == CAMBRIDGE.branding.requests_inbox
    assert f"{ZZ.branding.site_url}/dashboard/requests" == ZZ.branding.requests_inbox


# --- shadow checks (D9) ---------------------------------------------------------------------


def shadow(**answers: Rows | Exception) -> dict[str, CheckResult]:
    client = FakeQueryClient(answers)
    return {r.name: r for r in run_shadow_checks(client, shadow_checks_for(CAMBRIDGE))}


def runs(stage: str, *pairs: tuple[float, float | None]) -> list[list[Any]]:
    """`(minutes ago, number)` runs of one stage as the query returns them."""
    return [[stage, minutes, number] for minutes, number in pairs]


DAY = 24 * 60


def test_healthy_numbers_pass_every_shadow_check() -> None:
    found = shadow()
    assert list(found) == list(monitor.SHADOW_CHECKS)
    assert {r.status for r in found.values()} == {"ok"}, {
        n: r.line() for n, r in found.items() if r.status != "ok"
    }
    assert all(r.shadow for r in found.values())


@pytest.mark.parametrize(
    "name, rows, detail",
    [
        ("stale_harvest_events", [[0, 30 * 60]], {"hoursSinceLastSuccess": 30.0}),
        ("stale_harvest_full", [[0, None]], {"hoursSinceLastSuccess": None}),
        # A daily stage's latest yield under a quarter of its median (100).
        (
            "yield_drop",
            runs("calendar_feeds", (60, 10), (DAY, 100), (2 * DAY, 90), (3 * DAY, 110)),
            {"calendarFeeds": 10},
        ),
        # Nothing at all where the median was small but above zero.
        (
            "yield_drop",
            runs("website_events", (60, 0), (DAY, 3), (2 * DAY, 2), (3 * DAY, 3)),
            {"websiteEvents": 0},
        ),
        # A weekly-only stage judged on its 28 days.
        (
            "yield_drop",
            runs("su_directory", (60, 50), (7 * DAY, 400), (14 * DAY, 410), (21 * DAY, 390)),
            {"suDirectory": 50},
        ),
        ("stage_freshness", [["calendar_feeds", 51 * 60]], {"calendarFeeds": 51.0}),
        ("stage_freshness", [["su_directory", 199 * 60]], {"suDirectory": 199.0}),
        ("fetch_error_rate", [["calendar_feeds", 100, 31]], {"calendarFeeds": 0.31}),
        ("rate_limited", [["website_events", 11]], {"websiteEvents": 11}),
        (
            "robots_block_jump",
            runs("enrich", (60, 6), (DAY, 1), (3 * DAY, 2)),
            {"enrich": 6},
        ),
        ("run_duration", [["events", 5761]], {"events": 5761}),
        ("run_duration", [["full", 21000]], {"full": 21000}),
        ("llm_error_rate", [[100, 21]], {"generations": 100, "errors": 21}),
        ("llm_fallback_rate", [[100, 31]], {"bulkGenerations": 100, "fallbacks": 31}),
    ],
)
def test_each_shadow_check_fails_past_its_threshold(name: str, rows: Rows, detail: dict) -> None:
    found = shadow(**{name: rows})
    assert [n for n, r in found.items() if r.status == "failed"] == [name]
    assert dict(found[name].detail) == detail
    assert found[name].line().endswith("— shadow, never pages")


@pytest.mark.parametrize(
    "name, rows",
    [
        ("stale_harvest_events", [[1, 25 * 60]]),
        # A small median: a low yield that is not zero is not a drop.
        ("yield_drop", runs("website_events", (60, 1), (DAY, 4), (2 * DAY, 4), (3 * DAY, 4))),
        # Fewer than three earlier runs in the window: not judged.
        ("yield_drop", runs("calendar_feeds", (60, 0), (DAY, 100), (2 * DAY, 100))),
        # A daily stage's runs older than 7 days do not count.
        (
            "yield_drop",
            runs("calendar_feeds", (60, 0), (DAY, 100), (8 * DAY, 100), (9 * DAY, 100)),
        ),
        # Exactly a quarter is not below a quarter.
        (
            "yield_drop",
            runs("calendar_feeds", (60, 25), (DAY, 100), (2 * DAY, 100), (3 * DAY, 100)),
        ),
        # A stage this campus does not have, or a name of the wrong shape.
        ("yield_drop", runs("old_stage", (60, 0), (DAY, 100), (2 * DAY, 100), (3 * DAY, 100))),
        ("stage_freshness", [["Jane Example", 900 * 60]]),
        # A weekly-only stage may go 198 hours.
        ("stage_freshness", [["su_directory", 51 * 60]]),
        ("fetch_error_rate", [["calendar_feeds", 100, 30]]),
        ("fetch_error_rate", [["calendar_feeds", 19, 19]]),
        ("fetch_error_rate", [["calendar_feeds", None, None]]),
        ("rate_limited", [["website_events", 10]]),
        ("robots_block_jump", runs("enrich", (60, 4), (DAY, 0))),
        ("robots_block_jump", runs("enrich", (60, 7), (DAY, 3), (2 * DAY, 4))),
        # The latest run is older than a day: nothing to judge today.
        ("robots_block_jump", runs("enrich", (2 * DAY, 9), (3 * DAY, 0))),
        # No earlier run (or only runs before the counters existed).
        ("robots_block_jump", runs("enrich", (60, 9), (DAY, None))),
        ("run_duration", [["events", 5760], ["full", 17280], ["talks", 99999]]),
        ("llm_error_rate", [[19, 19]]),
        ("llm_fallback_rate", [[19, 19]]),
        ("llm_fallback_rate", [[100, 30]]),
    ],
)
def test_each_shadow_check_passes_short_of_its_threshold(name: str, rows: Rows) -> None:
    assert shadow(**{name: rows})[name].status == "ok"


def test_a_multi_row_check_counts_breaches_and_names_four_stages_in_registry_order() -> None:
    stages = ["website_events", "su_directory", "calendar_feeds", "colleges", "enrich", "inbox"]
    found = shadow(rate_limited=[[stage, 50] for stage in stages])["rate_limited"]
    assert found.status == "failed" and found.value == 6
    assert list(found.detail) == ["suDirectory", "colleges", "enrich", "calendarFeeds"]
    assert all("_" not in key for key in found.detail), "the alert's count names have none"


def test_stage_names_are_camelcased_for_the_alert() -> None:
    assert camel("website_events") == "websiteEvents"
    assert camel("enrich") == "enrich"
    assert camel("su_whatson") == "suWhatson"


@pytest.mark.parametrize(
    "answer, reason",
    [
        (QueryFailed("HTTP 429"), "HTTP 429"),
        ([["calendar_feeds", 60]], "malformed answer"),
        ([["calendar_feeds", "an hour", 3]], "malformed answer"),
        ([["calendar_feeds", 60, 100]] * (monitor.MAX_ROWS + 1), "malformed answer"),
        (KeyError("surprise"), "KeyError"),
    ],
)
def test_a_shadow_check_posthog_cannot_answer_is_unknown(answer: Any, reason: str) -> None:
    found = shadow(yield_drop=answer)["yield_drop"]
    assert found.status == "unknown" and found.reason == reason
    assert found.line().startswith("shadow yield_drop: unknown")


def test_the_shadow_checks_share_one_time_budget() -> None:
    ticks = iter(range(0, 10_000, 50))
    found = run_shadow_checks(
        FakeQueryClient({}),
        shadow_checks_for(CAMBRIDGE),
        budget_s=120,
        clock=lambda: float(next(ticks)),
    )
    # Started at 0; asked at 50 and 100 s; the third would start at 150 s.
    assert [r.status for r in found[:2]] == ["ok", "ok"]
    assert {r.reason for r in found[2:]} == {"time budget"}
    assert len(found) == len(monitor.SHADOW_CHECKS)


def test_shadow_results_never_page_and_never_reach_the_status_file() -> None:
    bad = shadow(stage_freshness=[["calendar_feeds", 99 * 60]], llm_error_rate=QueryFailed("x"))
    verdict = assess(run_checks(FakeQueryClient({})), {}, now=NOW).with_shadow(list(bad.values()))
    assert not verdict.page and verdict.result == "ok" and verdict.unknown == []
    payload = verdict.status_payload()
    assert "shadowChecks" not in payload
    assert [c["name"] for c in payload["checks"]] == list(CHECK_NAMES)
    printed = verdict.json_payload()
    assert [c["name"] for c in printed["shadowChecks"]] == list(monitor.SHADOW_CHECKS)
    assert "shadow stage_freshness: failed" in "\n".join(monitor.summary(verdict))
    # Even passed to `assess` by mistake, a shadow failure does not page.
    mixed = assess([*run_checks(FakeQueryClient({})), *bad.values()], {}, now=NOW)
    assert not mixed.page and mixed.failed == []


def test_the_command_prints_shadow_checks_but_writes_and_pages_only_the_others(
    configured, net: respx.MockRouter, tmp_path: Path
) -> None:
    net.post(QUERY_URL).mock(
        side_effect=answer_by_name({"run_duration": [["events", 7000]], "rate_limited": 503})
    )
    status = tmp_path / "status-monitor.json"

    result = invoke(configured, "--status-json", str(status))

    assert result.exit_code == 0, result.output
    assert "monitor: shadow run_duration: failed, 1" in result.output
    assert "monitor: shadow rate_limited: unknown (HTTP 503" in result.output
    assert "not checked" not in result.output, "a shadow unknown is no warning"
    written = json.loads(status.read_text())
    assert written["result"] == "ok" and written["paged"] is False
    assert written["campus"] == "cam" and written["site"] == "https://camsocs.uk"
    assert [c["name"] for c in written["checks"]] == [*CHECK_NAMES, *SITE_CHECK_NAMES]
    assert "shadowChecks" not in written


def test_the_command_prints_json_with_the_shadow_checks(
    configured, net: respx.MockRouter, tmp_path: Path
) -> None:
    net.post(QUERY_URL).mock(side_effect=answer_by_name({"yield_drop": [["inbox", 60, 0]]}))
    status = tmp_path / "status-monitor.json"

    result = invoke(configured, "--status-json", str(status), "--json")

    assert result.exit_code == 0, result.output
    printed = json.loads(result.stdout)
    assert printed["campus"] == "cam" and printed["kind"] == "monitor"
    assert [c["name"] for c in printed["shadowChecks"]] == list(monitor.SHADOW_CHECKS)
    assert [c["name"] for c in printed["checks"]] == [*CHECK_NAMES, *SITE_CHECK_NAMES]
    assert "shadowChecks" not in json.loads(status.read_text())
    assert KEY not in result.output


def test_a_zz_run_checks_its_own_site_and_scopes_its_queries(
    net: respx.MockRouter, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(monitor, "SITE_RETRY_PAUSE", 0)
    home = net.head("https://zz.localhost/").respond(200)
    route = net.post(QUERY_URL).mock(side_effect=answer_by_name({}))
    status = tmp_path / "status-monitor.json"
    with registered():
        settings = Settings(
            _env_file=None,
            campus="zz",
            posthog_personal_api_key=KEY,
            posthog_project_id=PROJECT,
            posthog_app_host=HOST,
        )
        result = invoke(settings, "--status-json", str(status))
    assert result.exit_code == 0, result.output
    assert home.call_count == 1
    assert "site_societies" not in result.output
    queries = [json.loads(call.request.content)["query"]["query"] for call in route.calls]
    assert queries and all("ifNull(properties.campus, 'cam') = 'zz'" in q for q in queries)
    written = json.loads(status.read_text())
    assert written["campus"] == "zz" and written["site"] == "https://zz.localhost"
    assert home.calls.last.request.headers["User-Agent"] == (
        "camsocs-monitor/0.1 (+https://zz.localhost/about)"
    )
