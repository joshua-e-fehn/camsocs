"""Production checks: `camsocs monitor` (ENG-10, ENG-33).

The personal API key the VPS host has can read the project but has no
`alert:write` or `hog_function:write` scope, so PostHog's own alerts are not
used. Instead the VPS runs this command hourly (`camsocs-monitor.timer`,
docs/ops-vps.md "Monitor"): four HogQL counts through the query API
(`POST /api/projects/<id>/query/`, research-api §4), each compared with a
threshold below, two status checks of the site, and a count of new listing
requests. A failed check (or news: a request, a recovery) exits non-zero,
which the unit's `OnFailure=` turns into the same Slack alert a failed
harvest sends.

Checks (production events only: `environment = 'production'`, set by the
browser client, the server senders and the VPS harvester):

- `error_spike` — more than `ERROR_SPIKE_MAX` `$exception` events (browser and
  server) in the last `ERROR_SPIKE_MINUTES` minutes;
- `stale_harvest` — no `harvest_run_finished` with status `success` or
  `partial` (dry runs excluded) in the last `HARVEST_STALE_HOURS` hours: the
  daily events run is overdue or failing (telemetry.py sends the event);
- `zero_result_rate` — over the last `ZERO_RESULT_HOURS` hours, with at least
  `ZERO_RESULT_MIN_SEARCHES` `search_performed` events, the share of
  `search_zero_results` among them is above `ZERO_RESULT_MAX_RATE` (search is
  broken, or the index is empty);
- `pageview_heartbeat` — no `$pageview` at all in `HEARTBEAT_HOURS` hours:
  the site, the `/relay` proxy or the consent-gated client is broken. Only
  visitors who accepted analytics send pageviews, so a quiet vacation can
  trip it too; the window is long for that reason.

From outside, without PostHog (ENG-33):

- `site_home`, `site_societies` — `https://camsocs.uk/` and one listing page
  must answer a `HEAD` with 200 within `SITE_TIMEOUT` seconds, asked once more
  after `SITE_RETRY_PAUSE` seconds. Only the status code is looked at: a
  `HEAD` has no body, so no page text (the home page lists talk titles) ever
  reaches the host, the journal or Slack. A redirect is a failure too. These
  checks also page once when they are `ok` again after a page (`recovered`).

**New listing requests (ENG-33).** Not a check: each run counts the
`listing_request_received` events (Convex sends one per stored claim,
correction, removal, objection or addition, with its `kind` only) since the
previous run, and pages when there is at least one, with the count of each
kind. The window is on PostHog's ingestion time (`created_at`, when its
ingestion processed the event), not the event's `timestamp`: an event that
waits in an ingestion backlog arrives with an old `timestamp` but a new
`created_at`, so a window counted before it arrived does not lose it. The
window runs from the previous run's `requestsCountedUntil` (the status file)
to `REQUESTS_LAG` before now, so consecutive windows meet exactly: an event
is counted by one run only, and one written to ClickHouse up to the lag after
PostHog processed it is still counted. A query PostHog does not answer, or
one whose window bounds it could not read, leaves the cursor where it was, so
the next run counts those hours too. Without a status file the window is the
last `REQUESTS_FIRST_WINDOW`; it never reaches back more than
`REQUESTS_MAX_WINDOW`.

What is never announced: a request whose capture failed (Convex logs it and
carries on, so PostHog never has it), one written to ClickHouse more than
`REQUESTS_LAG` after PostHog processed it, and one whose DM Slack refused
(the cursor has moved on; `journalctl -u camsocs-alert@monitor` shows the
refusal). The inbox, `/dashboard/requests`, is the record to trust.

**What is printed.** Structured facts only: the check's name, its counts, its
threshold and window. The queries select counts, never event properties, and
a failed query is reported by the exception's class name or the HTTP status,
never the response body. The status file (`--status-json`) holds the same.

**PostHog trouble never pages.** A query that fails (network, timeout, HTTP
error, rate limit, malformed answer) makes its check `unknown`: logged as a
warning, written to the status file, and *not* a failure — the run still
exits 0 when nothing else failed, so a PostHog outage does not flood Slack.
The cost is that a lasting misconfiguration (a revoked key: HTTP 401) is only
visible in the journal and the status file, not in Slack.

**Reminders, not repeats.** With `--status-json` the previous run's file says
which checks were last paged for and when. A check still failing within
`REALERT_AFTER` of that page exits 0 (the status file still says `failed`);
a new failing check, or the same one after `REALERT_AFTER`, pages again. A
stale harvest therefore DMs every six hours, not every hour. Without the file
every failure pages. New listing requests and a site check's recovery page
on their own (exit 1, the same alert path); they never repeat a page for a
check that is still failing within `REALERT_AFTER` (the alert names it as
still failing instead).

Without `POSTHOG_PERSONAL_API_KEY` and `POSTHOG_PROJECT_ID` the command says
so and exits 0: a laptop, CI and a host without the key check nothing (the
site checks neither).
"""

from __future__ import annotations

import json
import logging
import re
import time
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal, Protocol

import httpx

from camsocs_pipeline.campuses.cam import SITE_CHECKS as CAMBRIDGE_SITE_CHECKS
from camsocs_pipeline.config import ABOUT_URL, ConfigError, Settings
from camsocs_pipeline.models.vocab import LISTING_REQUEST_KINDS

logger = logging.getLogger(__name__)

#: `error_spike`: more than this many production `$exception` events …
ERROR_SPIKE_MAX = 20
#: … within this many minutes.
ERROR_SPIKE_MINUTES = 60
#: `stale_harvest`: a successful (or partial) production run must have
#: finished within this many hours. The daily events run starts 04:30 London
#: and is limited to 2 h, so 26 h allows one late run but not a missed one.
HARVEST_STALE_HOURS = 26
#: `zero_result_rate`: the window, …
ZERO_RESULT_HOURS = 24
#: … the share of searches with no result above which the check fails, …
ZERO_RESULT_MAX_RATE = 0.5
#: … and the searches needed before the rate means anything.
ZERO_RESULT_MIN_SEARCHES = 20
#: `pageview_heartbeat`: at least one production `$pageview` within this many hours.
HEARTBEAT_HOURS = 48
#: A check still failing within this long of its last page does not page again.
REALERT_AFTER = timedelta(hours=6)
#: Seconds one query may take (PostHog's own limit is far shorter).
QUERY_TIMEOUT = 30.0

#: The site checks: a name and a public page that must answer 200 (ENG-33).
#: Cambridge's, defined with its campus profile (`campuses/cam.py`).
SITE_CHECKS: tuple[tuple[str, str], ...] = CAMBRIDGE_SITE_CHECKS
#: Seconds one site request may take, …
SITE_TIMEOUT = 10.0
#: … how often it is asked in all, …
SITE_ATTEMPTS = 2
#: … and the seconds between the two.
SITE_RETRY_PAUSE = 5.0
SITE_USER_AGENT = f"camsocs-monitor/0.1 (+{ABOUT_URL})"

#: New listing requests: the server-side event (`convex/analytics.ts`), …
REQUESTS_EVENT = "listing_request_received"
#: … its name in the output and the status file, …
REQUESTS_NAME = "listing_requests"
#: … how long before the run a window ends: a processed event is written to
#: ClickHouse within seconds as a rule, and one up to `REQUESTS_LAG` late is
#: still counted (by the next run); the window is on ingestion time, so a
#: backlog before processing needs no lag (`requests_query`), …
REQUESTS_LAG = timedelta(minutes=2)
#: … the window when no earlier run left a cursor, …
REQUESTS_FIRST_WINDOW = timedelta(hours=1)
#: … and the furthest a window reaches back (a monitor off for weeks); …
REQUESTS_MAX_WINDOW = timedelta(days=30)
#: … the events' own time is bounded a day further back, so ClickHouse reads
#: only the recent partitions.
REQUESTS_SCAN_DAYS = REQUESTS_MAX_WINDOW.days + 1

Status = Literal["ok", "failed", "unknown"]
#: How a check's value fails: above (`gt`) or below (`lt`) its threshold, or
#: any value but it (`ne`: a site check's status code).
Comparison = Literal["gt", "lt", "ne"]

_PROJECT_ID = re.compile(r"\d{1,12}")

#: Leaves out the in-app Claude browser, which the project's internal/test
#: filter (the dashboards' `filterTestAccounts`) also hides: an agent's QA
#: session on camsocs.uk must neither page as an error spike nor keep the
#: heartbeat alive. Server events carry no `$browser`, so they still count.
NOT_INTERNAL = " AND ifNull(properties.$browser, '') != 'Claude'"

#: The HogQL of each check. Counts only; `properties.environment` restricts
#: them to production. Event names are compared exactly ('$exception' and
#: '$pageview' were verified against the live project on 2026-11-01).
ERROR_SPIKE_QUERY = (
    "SELECT count() FROM events WHERE event = '$exception'"
    " AND properties.environment = 'production'"
    + NOT_INTERNAL
    + f" AND timestamp > now() - INTERVAL {ERROR_SPIKE_MINUTES} MINUTE"
)
STALE_HARVEST_QUERY = (
    f"SELECT countIf(timestamp > now() - INTERVAL {HARVEST_STALE_HOURS} HOUR),"
    " if(count() = 0, NULL, dateDiff('minute', max(timestamp), now()))"
    " FROM events WHERE event = 'harvest_run_finished'"
    " AND properties.environment = 'production'"
    " AND properties.status IN ('success', 'partial')"
    " AND ifNull(toString(properties.dryRun), '') != 'true'"
    " AND timestamp > now() - INTERVAL 30 DAY"
)
ZERO_RESULT_QUERY = (
    "SELECT countIf(event = 'search_performed'), countIf(event = 'search_zero_results')"
    " FROM events WHERE event IN ('search_performed', 'search_zero_results')"
    " AND properties.environment = 'production'"
    + NOT_INTERNAL
    + f" AND timestamp > now() - INTERVAL {ZERO_RESULT_HOURS} HOUR"
)
HEARTBEAT_QUERY = (
    "SELECT count() FROM events WHERE event = '$pageview'"
    " AND properties.environment = 'production'"
    + NOT_INTERNAL
    + f" AND timestamp > now() - INTERVAL {HEARTBEAT_HOURS} HOUR"
)


def requests_query(since: datetime, until: datetime) -> str:
    """New listing requests PostHog ingested in `(since, until]`: the total,
    a count of each kind (`LISTING_REQUEST_KINDS` order), then the two bounds
    as PostHog read them. Counts only, never a property.

    The window is on `created_at`, the time PostHog's ingestion processed the
    event, not `timestamp` (when PostHog received it: Convex sends none), so
    an ingestion backlog cannot slip an event into a window already counted;
    `timestamp` only narrows the scan to the last `REQUESTS_SCAN_DAYS`. The
    bounds are absolute UTC instants, so the host's and PostHog's clocks need
    not agree for consecutive windows to meet. HogQL's `toDateTime` of a
    string it cannot parse is NULL, which would make every row miss and the
    count a silent 0; the bounds are selected too, so `count_requests` can
    refuse that answer. The event is matched with LIKE: the launch audit saw
    an exact `event =` count 0 for some events PostHog had, and `_`, LIKE's
    one-character wildcard, still matches only this name among the project's
    events."""
    kinds = "".join(f", countIf(properties.kind = '{kind}')" for kind in LISTING_REQUEST_KINDS)
    start, end = f"toDateTime('{_iso(since)}')", f"toDateTime('{_iso(until)}')"
    return (
        f"SELECT count(){kinds}, {start}, {end}"
        f" FROM events WHERE event LIKE '{REQUESTS_EVENT}'"
        " AND properties.environment = 'production'"
        f" AND created_at > {start} AND created_at <= {end}"
        f" AND timestamp > now() - INTERVAL {REQUESTS_SCAN_DAYS} DAY"
    )


class QueryFailed(Exception):
    """A query did not answer. The message is a class name or an HTTP status
    (safe to print and to write to the status file), never PostHog's body."""


class QueryClient(Protocol):
    """Runs one HogQL query and returns its rows."""

    def hogql(self, query: str, *, name: str) -> list[list[Any]]: ...


class PostHogQueryClient:
    """The query API with a personal key (research-api §4). One `httpx`
    client, like every other caller in the pipeline (respx-testable)."""

    def __init__(
        self,
        host: str,
        project_id: str,
        key: str,
        *,
        client: httpx.Client | None = None,
    ) -> None:
        if not _PROJECT_ID.fullmatch(project_id):
            raise ConfigError("POSTHOG_PROJECT_ID must be the project's numeric id.")
        self._url = f"{host.rstrip('/')}/api/projects/{project_id}/query/"
        self._headers = {"Authorization": f"Bearer {key}"}
        self._client = client or httpx.Client(timeout=QUERY_TIMEOUT)

    @classmethod
    def from_settings(cls, settings: Settings) -> PostHogQueryClient:
        return cls(
            settings.posthog_app_host,
            settings.posthog_project_id,
            settings.posthog_personal_api_key.get_secret_value().strip(),
        )

    def hogql(self, query: str, *, name: str) -> list[list[Any]]:
        body = {
            "query": {"kind": "HogQLQuery", "query": query},
            "name": name,
            # Fresh numbers: a cached answer could hide an outage for hours.
            "refresh": "force_blocking",
        }
        try:
            response = self._client.post(self._url, json=body, headers=self._headers)
        except httpx.HTTPError as error:
            raise QueryFailed(type(error).__name__) from None
        if response.status_code != 200:
            raise QueryFailed(f"HTTP {response.status_code}")
        try:
            results = response.json()["results"]
        except (ValueError, KeyError, TypeError):
            raise QueryFailed("malformed answer") from None
        if not isinstance(results, list) or not all(isinstance(row, list) for row in results):
            raise QueryFailed("malformed answer")
        return results

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> PostHogQueryClient:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()


@dataclass(frozen=True)
class CheckResult:
    """One check's outcome: numbers and names only."""

    name: str
    status: Status
    value: int | float | None
    threshold: int | float
    op: Comparison
    #: The window the value counts over; `None` for a site check.
    window_hours: float | None
    detail: Mapping[str, int | float | None] = field(default_factory=dict)
    #: Why the check is `unknown`, or why a site check failed: an exception
    #: class name or `HTTP 503`.
    reason: str | None = None
    #: Whether being `ok` again after a page pages once more (the site checks).
    announce_recovery: bool = False

    def line(self) -> str:
        """`error_spike: ok, 3 (fails when > 20, last 1 h)`."""
        sign = {"gt": ">", "lt": "<", "ne": "!="}[self.op]
        window = f", last {self.window_hours:g} h" if self.window_hours is not None else ""
        rule = f"fails when {sign} {self.threshold}{window}"
        if self.status == "unknown":
            return f"{self.name}: unknown ({self.reason}; {rule}) — not paged"
        extra = "".join(f", {key} {value}" for key, value in self.detail.items())
        why = f"; {self.reason}" if self.status == "failed" and self.reason else ""
        return f"{self.name}: {self.status}, {self.value} ({rule}){extra}{why}"

    def to_json(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "status": self.status,
            "value": self.value,
            "threshold": self.threshold,
            "op": self.op,
            "windowHours": self.window_hours,
            "detail": dict(self.detail),
            "reason": self.reason,
        }


def _number(value: object) -> int | float:
    """A count from a result row; anything else is a malformed answer."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise QueryFailed("malformed answer")
    return value


Measure = Callable[[Sequence[Any]], tuple[int | float, dict[str, int | float | None]]]


@dataclass(frozen=True)
class Check:
    """A HogQL query returning one row, how that row becomes a value (and
    detail counts), and the threshold the value is compared with."""

    name: str
    query: str
    #: Columns of the query's single row.
    width: int
    measure: Measure
    threshold: int | float
    op: Comparison
    window_hours: float
    #: Whether the detail holds enough data to judge (the zero-result rate
    #: needs a minimum of searches); otherwise the check is `ok`.
    judged: Callable[[Mapping[str, int | float | None]], bool] = lambda _detail: True

    def run(self, client: QueryClient) -> CheckResult:
        """The check's result; `unknown` when the query fails or answers
        something that is not one row of counts."""
        try:
            rows = client.hogql(self.query, name=f"camsocs monitor {self.name}")
            if len(rows) != 1 or len(rows[0]) != self.width:
                raise QueryFailed("malformed answer")
            value, detail = self.measure(rows[0])
        except QueryFailed as error:
            return self._result("unknown", None, {}, str(error))
        failed = value > self.threshold if self.op == "gt" else value < self.threshold
        status: Status = "failed" if failed and self.judged(detail) else "ok"
        return self._result(status, value, detail)

    def _result(
        self,
        status: Status,
        value: int | float | None,
        detail: Mapping[str, int | float | None],
        reason: str | None = None,
    ) -> CheckResult:
        return CheckResult(
            self.name, status, value, self.threshold, self.op, self.window_hours, detail, reason
        )


def _count(row: Sequence[Any]) -> tuple[int | float, dict[str, int | float | None]]:
    return _number(row[0]), {}


def _harvest(row: Sequence[Any]) -> tuple[int | float, dict[str, int | float | None]]:
    recent, minutes = row
    since = None if minutes is None else round(_number(minutes) / 60, 1)
    return _number(recent), {"hoursSinceLastSuccess": since}


def _zero_rate(row: Sequence[Any]) -> tuple[int | float, dict[str, int | float | None]]:
    searches, zero = _number(row[0]), _number(row[1])
    rate = round(zero / searches, 3) if searches else 0.0
    return rate, {"searches": searches, "zeroResults": zero}


def _enough_searches(detail: Mapping[str, int | float | None]) -> bool:
    return (detail.get("searches") or 0) >= ZERO_RESULT_MIN_SEARCHES


#: Every check, in the order they run and are printed.
CHECKS: tuple[Check, ...] = (
    Check(
        "error_spike",
        ERROR_SPIKE_QUERY,
        1,
        _count,
        ERROR_SPIKE_MAX,
        "gt",
        ERROR_SPIKE_MINUTES / 60,
    ),
    # Fails below one successful run in the window.
    Check("stale_harvest", STALE_HARVEST_QUERY, 2, _harvest, 1, "lt", HARVEST_STALE_HOURS),
    Check(
        "zero_result_rate",
        ZERO_RESULT_QUERY,
        2,
        _zero_rate,
        ZERO_RESULT_MAX_RATE,
        "gt",
        ZERO_RESULT_HOURS,
        _enough_searches,
    ),
    Check("pageview_heartbeat", HEARTBEAT_QUERY, 1, _count, 1, "lt", HEARTBEAT_HOURS),
)
CHECK_NAMES = tuple(check.name for check in CHECKS)


def run_checks(client: QueryClient, checks: Iterable[Check] = CHECKS) -> list[CheckResult]:
    """Every check; a query that fails makes its check `unknown`, never an error."""
    return [check.run(client) for check in checks]


# --- the site, from outside (ENG-33) -------------------------------------------------------


def site_client() -> httpx.Client:
    """The client the site checks use: no redirects followed (one is a failure)."""
    return httpx.Client(
        timeout=SITE_TIMEOUT, follow_redirects=False, headers={"User-Agent": SITE_USER_AGENT}
    )


def check_site(
    client: httpx.Client, name: str, url: str, *, pause: Callable[[float], None] = time.sleep
) -> CheckResult:
    """`ok` when `url` answers a `HEAD` with 200, at the first or the second
    try. A `HEAD` has no body, so the page's text never arrives; a failure is
    reported by its status code or the exception's class name only."""
    status, reason, attempts = 0, None, 0
    while attempts < SITE_ATTEMPTS:
        if attempts:
            pause(SITE_RETRY_PAUSE)
        attempts += 1
        try:
            status = client.head(url).status_code
        except httpx.HTTPError as error:
            status, reason = 0, type(error).__name__
        else:
            reason = None if status == 200 else f"HTTP {status}"
        if status == 200:
            break
    return CheckResult(
        name,
        "ok" if status == 200 else "failed",
        status,
        200,
        "ne",
        None,
        {"attempts": attempts},
        reason,
        announce_recovery=True,
    )


def check_sites(
    client: httpx.Client,
    checks: Iterable[tuple[str, str]] = SITE_CHECKS,
    *,
    pause: Callable[[float], None] = time.sleep,
) -> list[CheckResult]:
    """Every site check, in `SITE_CHECKS` order."""
    return [check_site(client, name, url, pause=pause) for name, url in checks]


SITE_CHECK_NAMES = tuple(name for name, _url in SITE_CHECKS)


# --- new listing requests (ENG-33) -------------------------------------------------------


@dataclass(frozen=True)
class RequestCount:
    """New `listing_request_received` events in `(since, until]`: how many of
    each kind, nothing else (no request is identified)."""

    status: Literal["ok", "unknown"]
    since: datetime
    until: datetime
    #: Kinds with at least one request; `other` for a kind the vocabulary lacks.
    by_kind: Mapping[str, int] = field(default_factory=dict)
    reason: str | None = None

    @property
    def total(self) -> int:
        return sum(self.by_kind.values())

    @property
    def counted_until(self) -> datetime:
        """Where the next run's window starts: this window's end once it was
        counted, its start when PostHog did not answer."""
        return self.until if self.status == "ok" else self.since

    def line(self) -> str:
        """`listing_requests: 2 new (claim 1, remove 1), 2026-11-01T10:50:00Z to …`."""
        span = f"{_iso(self.since)} to {_iso(self.until)}"
        if self.status == "unknown":
            return f"{REQUESTS_NAME}: unknown ({self.reason}; {span}) — counted next run"
        if not self.total:
            return f"{REQUESTS_NAME}: none new, {span}"
        kinds = ", ".join(f"{kind} {count}" for kind, count in self.by_kind.items())
        return f"{REQUESTS_NAME}: {self.total} new ({kinds}), {span}"

    def to_json(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "since": _iso(self.since),
            "until": _iso(self.until),
            "total": self.total if self.status == "ok" else None,
            "byKind": dict(self.by_kind),
            "reason": self.reason,
        }


def requests_window(previous: Mapping[str, Any], *, now: datetime) -> tuple[datetime, datetime]:
    """The window this run counts: from the previous run's cursor
    (`requestsCountedUntil`) to `REQUESTS_LAG` before `now`. No usable cursor:
    the last `REQUESTS_FIRST_WINDOW`; never more than `REQUESTS_MAX_WINDOW`. A
    cursor after the window's end (the clock went back) gives an empty window
    there, so nothing is counted twice."""
    until = now - REQUESTS_LAG
    cursor = _instant(previous.get("requestsCountedUntil"))
    if cursor is None:
        return until - REQUESTS_FIRST_WINDOW, until
    if cursor >= until:
        return cursor, cursor
    return max(cursor, until - REQUESTS_MAX_WINDOW), until


def count_requests(client: QueryClient, since: datetime, until: datetime) -> RequestCount:
    """This window's new requests by kind; `unknown` when PostHog does not
    answer, or answers with a bound it did not read as this window's (never
    an error). An empty window asks nothing."""
    if since >= until:
        return RequestCount("ok", since, until)
    width = 1 + len(LISTING_REQUEST_KINDS) + 2
    try:
        rows = client.hogql(requests_query(since, until), name=f"camsocs monitor {REQUESTS_NAME}")
        if len(rows) != 1 or len(rows[0]) != width:
            raise QueryFailed("malformed answer")
        *counts, start, end = rows[0]
        _check_bound(start, since)
        _check_bound(end, until)
        total, *each = (int(_number(value)) for value in counts)
    except QueryFailed as error:
        return RequestCount("unknown", since, until, {}, str(error))
    by_kind = {kind: n for kind, n in zip(LISTING_REQUEST_KINDS, each, strict=True) if n > 0}
    if (other := total - sum(each)) > 0:
        by_kind["other"] = other
    return RequestCount("ok", since, until, by_kind)


def _check_bound(value: object, meant: datetime) -> None:
    """A window bound as PostHog read it: NULL (a string it could not parse)
    or another instant is a malformed answer. A time without an offset (the
    project's own timezone) cannot be compared, so it is let through."""
    if not isinstance(value, str) or not value:
        raise QueryFailed("malformed answer")
    read = _instant(value)
    # Compared as the query wrote it: whole seconds, UTC.
    if read is not None and _iso(read) != _iso(meant):
        raise QueryFailed("malformed answer")


def _instant(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else None


def _iso(moment: datetime) -> str:
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass(frozen=True)
class Assessment:
    """The checks' verdict, and whether this run pages."""

    results: list[CheckResult]
    checked_at: datetime
    #: Whether the failing checks page this run (a new one, or a reminder).
    checks_page: bool
    #: The checks the latest page was about, and when it went out.
    alerted: list[str]
    last_alert_at: datetime | None
    #: Checks that announce their recovery, paged for and `ok` again now.
    recovered: list[str] = field(default_factory=list)
    #: This run's new listing requests (`None`: not counted).
    requests: RequestCount | None = None

    @property
    def new_requests(self) -> int:
        found = self.requests
        return found.total if found is not None and found.status == "ok" else 0

    @property
    def page(self) -> bool:
        """Whether this run pages: a failure due one, a recovery or a request."""
        return self.checks_page or bool(self.recovered) or self.new_requests > 0

    @property
    def failed(self) -> list[str]:
        return [r.name for r in self.results if r.status == "failed"]

    @property
    def unknown(self) -> list[str]:
        names = [r.name for r in self.results if r.status == "unknown"]
        if self.requests is not None and self.requests.status == "unknown":
            names.append(REQUESTS_NAME)
        return names

    def reasons(self) -> list[str]:
        """Why this run pages, for the command's error line."""
        found = [f"check failed: {', '.join(self.failed)}"] if self.checks_page else []
        if self.recovered:
            found.append(f"recovered: {', '.join(self.recovered)}")
        if self.new_requests:
            found.append(f"new listing requests: {self.new_requests}")
        return found

    @property
    def result(self) -> Status:
        if self.failed:
            return "failed"
        return "unknown" if self.unknown else "ok"

    def status_payload(self, invocation_id: str | None = None) -> dict[str, Any]:
        """The status file (`--status-json`); the Slack alert reads it."""
        return {
            "kind": "monitor",
            "checkedAt": _iso(self.checked_at),
            "invocationId": invocation_id,
            "result": self.result,
            "paged": self.page,
            "checksPaged": self.checks_page,
            "failedChecks": self.failed,
            "unknownChecks": self.unknown,
            "alertedChecks": self.alerted,
            "lastAlertAt": _iso(self.last_alert_at) if self.last_alert_at else None,
            "recoveredChecks": self.recovered,
            "checks": [r.to_json() for r in self.results],
            "requests": self.requests.to_json() if self.requests else None,
            "requestsCountedUntil": (_iso(self.requests.counted_until) if self.requests else None),
        }


def assess(
    results: list[CheckResult],
    previous: Mapping[str, Any],
    *,
    now: datetime,
    requests: RequestCount | None = None,
) -> Assessment:
    """Whether `results` page, given the previous run's status file
    (`previous`, `{}` when there is none): failures that were not already
    paged for within `REALERT_AFTER` do, as do a paged site check that is
    `ok` again and any new listing request (`requests`).

    A paged check is forgotten only once it is seen `ok` again: a run where
    PostHog did not answer for it (`unknown`) keeps the page in memory, so a
    query blip during a lasting failure does not page twice, and a check that
    recovered and fails again counts as new and pages at once."""
    failed = {r.name for r in results if r.status == "failed"}
    unknown = {r.name for r in results if r.status == "unknown"}
    alerted = previous.get("alertedChecks")
    before = {n for n in alerted if isinstance(n, str)} if isinstance(alerted, list) else set()
    last = _instant(previous.get("lastAlertAt"))
    held = before & (failed | unknown)
    back = sorted(before & {r.name for r in results if r.status == "ok" and r.announce_recovery})
    if not failed:
        page, alerting, at = False, held, last if held else None
    elif failed <= held and last is not None and timedelta(0) <= now - last < REALERT_AFTER:
        page, alerting, at = False, held, last
    else:
        page, alerting, at = True, failed | held, now
    return Assessment(results, now, page, sorted(alerting), at, back, requests)


def read_status(path: Path | None) -> dict[str, Any]:
    """The previous run's status file, or `{}` (missing or unreadable)."""
    if path is None:
        return {}
    try:
        data = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def safe_invocation_id(value: str | None) -> str | None:
    """systemd's `$INVOCATION_ID` (32 hex digits), else `None`."""
    return value if value and re.fullmatch(r"[0-9a-f]{32}", value) else None


def summary(assessment: Assessment) -> Iterable[str]:
    """The lines the command prints: one per check, then the verdict."""
    for result in assessment.results:
        yield result.line()
    if assessment.requests is not None:
        yield assessment.requests.line()
    if assessment.recovered:
        yield f"recovered: {', '.join(assessment.recovered)} — paged"
    if assessment.failed and not assessment.checks_page:
        yield (
            f"still failing: {', '.join(assessment.failed)} — paged at "
            f"{_iso(assessment.last_alert_at) if assessment.last_alert_at else '?'}, "
            f"reminds after {REALERT_AFTER.total_seconds() / 3600:g} h"
        )


__all__ = [
    "CHECKS",
    "CHECK_NAMES",
    "ERROR_SPIKE_MAX",
    "ERROR_SPIKE_MINUTES",
    "HARVEST_STALE_HOURS",
    "HEARTBEAT_HOURS",
    "NOT_INTERNAL",
    "REALERT_AFTER",
    "REQUESTS_FIRST_WINDOW",
    "REQUESTS_LAG",
    "REQUESTS_MAX_WINDOW",
    "REQUESTS_NAME",
    "REQUESTS_SCAN_DAYS",
    "SITE_ATTEMPTS",
    "SITE_CHECKS",
    "SITE_CHECK_NAMES",
    "SITE_RETRY_PAUSE",
    "SITE_TIMEOUT",
    "ZERO_RESULT_HOURS",
    "ZERO_RESULT_MAX_RATE",
    "ZERO_RESULT_MIN_SEARCHES",
    "Assessment",
    "Check",
    "CheckResult",
    "PostHogQueryClient",
    "QueryClient",
    "QueryFailed",
    "RequestCount",
    "assess",
    "check_site",
    "check_sites",
    "count_requests",
    "read_status",
    "requests_query",
    "requests_window",
    "run_checks",
    "safe_invocation_id",
    "site_client",
    "summary",
]
