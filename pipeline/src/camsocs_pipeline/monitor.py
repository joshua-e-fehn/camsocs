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

**One campus per run (decision D8).** Every query adds
``AND ifNull(properties.campus, 'cam') = '<campus>'`` (events sent before the
campus property existed are Cambridge's), and the site checks are the
campus profile's `Branding.monitor_urls`. For Cambridge the counts and the
URLs are what they were before the seam. The status file names the campus
and its site (`campus`, `site`), which the alert reads.

**Shadow checks (decision D9).** The scraper-health checks below are built
with the others but listed in `SHADOW_CHECKS`: each run computes them after
the status file is written, prints them (``shadow …`` lines, and under
``shadowChecks`` with ``--json``) and never writes them to the status file,
so they never page and the installed alert never sees them. A check leaves
shadow mode by deleting its name from `SHADOW_CHECKS` (a one-line reviewed
change, after 14 days of baseline and Joshua's sign-off). They share one time
budget (`SHADOW_BUDGET_S`), so they cannot push the run past its unit's
limit, and none of them can fail the run. Harvest queries leave out dry runs.
A stage's numbers come from its `harvest_stage_completed` (`metrics` carries
the fetch counters, L6); a multi-row check's value is its number of breaches,
and its detail names at most `MAX_DETAIL` breaching stages (camelCased: the
alert's count names have no underscore) with their numbers:

- `stale_harvest_events`, `stale_harvest_full` — no successful (or partial)
  run of that group within `STALE_GROUP_HOURS` (26 h, 198 h);
- `yield_drop` — a stage's latest ok run yielded (inserted + updated +
  unchanged) less than `YIELD_DROP_RATIO` of the median of at least
  `YIELD_MIN_RUNS` earlier ok runs in its window (7 days for a stage of the
  daily group, 28 for a weekly-only one) with that median at least
  `YIELD_MIN_MEDIAN`, or nothing where the median was above zero;
- `stage_freshness` — more than `FRESHNESS_HOURS` (50 h daily, 198 h weekly)
  since a stage's last ok run with a yield above zero;
- `fetch_error_rate` — a stage's latest run in `FETCH_WINDOW_HOURS` that
  fetched had at least `FETCH_MIN_REQUESTS` requests, of which more than
  `FETCH_ERROR_MAX_RATE` unreachable or HTTP errors (a 5xx answer is one of
  the two, never counted again: `fetchUnreachable + fetchHttpError`);
- `rate_limited` — more than `RATE_LIMITED_MAX` 429 answers in one stage run;
- `robots_block_jump` — a stage's latest run had at least
  `ROBOTS_JUMP_MIN` robots.txt blocks and more than `ROBOTS_JUMP_FACTOR`
  times the mean of its runs in the 7 days before;
- `run_duration` — a run took more than `RUN_DURATION_SHARE` of its group's
  time limit (`GROUP_TIME_LIMIT_S`, camsocs-harvest.sh);
- `llm_error_rate` — more than `LLM_ERROR_MAX_RATE` of at least
  `LLM_MIN_GENERATIONS` `$ai_generation` events in 24 h were errors;
- `llm_fallback_rate` — more than `LLM_FALLBACK_MAX_RATE` of at least
  `LLM_MIN_GENERATIONS` bulk generations needed the strong model.
"""

from __future__ import annotations

import json
import logging
import re
import statistics
import time
from collections import defaultdict
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal, Protocol

import httpx

from camsocs_pipeline.campuses.cam import CAMBRIDGE
from camsocs_pipeline.campuses.cam import SITE_CHECKS as CAMBRIDGE_SITE_CHECKS
from camsocs_pipeline.campuses.profile import CampusProfile
from camsocs_pipeline.config import ABOUT_URL, ConfigError, Settings
from camsocs_pipeline.models.vocab import LISTING_REQUEST_KINDS
from camsocs_pipeline.stages import groups as campus_groups
from camsocs_pipeline.stages import registry

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

# --- shadow checks (decision D9; module docstring) ---------------------------------------

#: `stale_harvest_events` / `_full`: a successful (or partial) run of the group
#: within this many hours (the daily run plus slack; a week plus a day and a
#: half for the Sunday run, which may take 6 h).
STALE_GROUP_HOURS: Mapping[str, int] = {"events": 26, "full": 198}
#: `yield_drop`: the latest yield below this share of the median …
YIELD_DROP_RATIO = 0.25
#: … of at least this many earlier ok runs …
YIELD_MIN_RUNS = 3
#: … whose median is at least this (smaller medians fail only on a zero) …
YIELD_MIN_MEDIAN = 5
#: … within this many days: a stage of the daily group, a weekly-only stage.
YIELD_WINDOW_DAYS: Mapping[str, int] = {"events": 7, "full": 28}
#: `stage_freshness`: hours since a stage's last productive ok run.
FRESHNESS_HOURS: Mapping[str, int] = {"events": 50, "full": 198}
#: How far back `stage_freshness` looks: a stage with no productive run in
#: this many days is not judged (it may never produce one: `report`).
FRESHNESS_SCAN_DAYS = 35
#: `fetch_error_rate`, `rate_limited`, `robots_block_jump`, `run_duration`
#: judge runs that finished within this many hours (so a weekly run is
#: judged for a day after it, not for a week).
FETCH_WINDOW_HOURS = 26
#: `fetch_error_rate`: the share of failed requests above which a stage run
#: fails, …
FETCH_ERROR_MAX_RATE = 0.3
#: … and the requests it needs before the share means anything.
FETCH_MIN_REQUESTS = 20
#: `rate_limited`: more 429 answers than this in one stage run.
RATE_LIMITED_MAX = 10
#: `robots_block_jump`: more than this many times the 7-day mean …
ROBOTS_JUMP_FACTOR = 2
#: … and at least this many blocks in the latest run.
ROBOTS_JUMP_MIN = 5
#: The mean is over a stage's runs in this many days before its latest.
ROBOTS_JUMP_DAYS = 7
#: `run_duration`: the runner's time limit per group (camsocs-harvest.sh:
#: `CAMSOCS_TIMEOUT_EVENTS` 2h, `CAMSOCS_TIMEOUT_FULL` 6h) …
GROUP_TIME_LIMIT_S: Mapping[str, int] = {"events": 7200, "full": 21600}
#: … and the share of it a run may take.
RUN_DURATION_SHARE = 0.8
#: `llm_error_rate`, `llm_fallback_rate`: the window, …
LLM_HOURS = 24
#: … the generations needed before a rate means anything, …
LLM_MIN_GENERATIONS = 20
#: … the error share and the fallback share (of bulk requests) that fail.
LLM_ERROR_MAX_RATE = 0.2
LLM_FALLBACK_MAX_RATE = 0.3
#: Breaching stages a multi-row check names in its detail (the alert shows 4).
MAX_DETAIL = 4
#: Seconds all shadow checks together may take; the rest are `unknown`.
SHADOW_BUDGET_S = 120.0
#: Rows a multi-row query returns at most (runs of every stage in 28 days).
MAX_ROWS = 5000

#: The checks that are computed and printed but never written to the status
#: file, so they never page (decision D9). Promotion deletes a name here.
SHADOW_CHECKS: tuple[str, ...] = (
    "stale_harvest_events",
    "stale_harvest_full",
    "yield_drop",
    "stage_freshness",
    "fetch_error_rate",
    "rate_limited",
    "robots_block_jump",
    "run_duration",
    "llm_error_rate",
    "llm_fallback_rate",
)

#: A campus id as it may appear in a query (`campuses.PROFILES` keys).
_CAMPUS = re.compile(r"[a-z]{2,8}")


def campus_filter(campus: str) -> str:
    """The clause every query adds: events of `campus` only, where an event
    sent before the campus property existed is Cambridge's. The id is
    shape-checked, so nothing else can reach the query."""
    if not _CAMPUS.fullmatch(campus):
        raise ConfigError(f"Not a campus id: {campus!r}")
    return f" AND ifNull(properties.campus, 'cam') = '{campus}'"


#: Every harvest query leaves out dry runs (`dryRun` is a boolean property;
#: PostHog may store it as text).
NOT_DRY_RUN = " AND ifNull(toString(properties.dryRun), '') != 'true'"

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

#: Production events only.
PRODUCTION = " AND properties.environment = 'production'"


#: The HogQL of each check, for a campus. Counts only; `properties.environment`
#: restricts them to production. Event names are compared exactly ('$exception'
#: and '$pageview' were verified against the live project on 2026-11-01).
def error_spike_query(campus: str = "cam") -> str:
    return (
        "SELECT count() FROM events WHERE event = '$exception'"
        + PRODUCTION
        + campus_filter(campus)
        + NOT_INTERNAL
        + f" AND timestamp > now() - INTERVAL {ERROR_SPIKE_MINUTES} MINUTE"
    )


def stale_harvest_query(
    campus: str = "cam", *, hours: int = HARVEST_STALE_HOURS, group: str | None = None
) -> str:
    """Successful (or partial) production runs: how many in the last `hours`,
    and the minutes since the latest in 30 days; of one `group` when given."""
    if group is not None and not re.fullmatch(r"[a-z][a-z0-9_]{0,31}", group):
        raise ConfigError(f"Not a group name: {group!r}")
    of_group = f" AND properties.group = '{group}'" if group is not None else ""
    return (
        f"SELECT countIf(timestamp > now() - INTERVAL {hours} HOUR),"
        " if(count() = 0, NULL, dateDiff('minute', max(timestamp), now()))"
        " FROM events WHERE event = 'harvest_run_finished'"
        + PRODUCTION
        + campus_filter(campus)
        + " AND properties.status IN ('success', 'partial')"
        + NOT_DRY_RUN
        + of_group
        + " AND timestamp > now() - INTERVAL 30 DAY"
    )


def zero_result_query(campus: str = "cam") -> str:
    return (
        "SELECT countIf(event = 'search_performed'), countIf(event = 'search_zero_results')"
        " FROM events WHERE event IN ('search_performed', 'search_zero_results')"
        + PRODUCTION
        + campus_filter(campus)
        + NOT_INTERNAL
        + f" AND timestamp > now() - INTERVAL {ZERO_RESULT_HOURS} HOUR"
    )


def heartbeat_query(campus: str = "cam") -> str:
    return (
        "SELECT count() FROM events WHERE event = '$pageview'"
        + PRODUCTION
        + campus_filter(campus)
        + NOT_INTERNAL
        + f" AND timestamp > now() - INTERVAL {HEARTBEAT_HOURS} HOUR"
    )


#: Cambridge's queries.
ERROR_SPIKE_QUERY = error_spike_query()
STALE_HARVEST_QUERY = stale_harvest_query()
ZERO_RESULT_QUERY = zero_result_query()
HEARTBEAT_QUERY = heartbeat_query()


def requests_query(since: datetime, until: datetime, campus: str = "cam") -> str:
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
        + PRODUCTION
        + campus_filter(campus)
        + f" AND created_at > {start} AND created_at <= {end}"
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
    #: A shadow check (decision D9): printed, never in the status file.
    shadow: bool = False

    def line(self) -> str:
        """`error_spike: ok, 3 (fails when > 20, last 1 h)`; a shadow check's
        line starts with ``shadow`` and never says it pages."""
        sign = {"gt": ">", "lt": "<", "ne": "!="}[self.op]
        window = f", last {self.window_hours:g} h" if self.window_hours is not None else ""
        rule = f"fails when {sign} {self.threshold}{window}"
        prefix = "shadow " if self.shadow else ""
        if self.status == "unknown":
            return f"{prefix}{self.name}: unknown ({self.reason}; {rule}) — not paged"
        extra = "".join(f", {key} {value}" for key, value in self.detail.items())
        why = f"; {self.reason}" if self.status == "failed" and self.reason else ""
        never = " — shadow, never pages" if self.shadow and self.status == "failed" else ""
        return f"{prefix}{self.name}: {self.status}, {self.value} ({rule}){extra}{why}{never}"

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


#: How a check's answer becomes its value and detail: from the single row,
#: or (`Check.many`) from every row.
Measure = Callable[[Sequence[Any]], tuple[int | float, dict[str, int | float | None]]]


@dataclass(frozen=True)
class Check:
    """A HogQL query, how its answer becomes a value (and detail counts), and
    the threshold the value is compared with.

    A single-row check reads one row of counts. A multi-row check (`many`)
    reads any number of rows of `width` columns, one per stage or group, and
    its value is the number of breaches (it fails above 0); its detail names
    the breaching stages (`MAX_DETAIL`) with their numbers."""

    name: str
    query: str
    #: Columns of each row.
    width: int
    measure: Measure
    threshold: int | float
    op: Comparison
    window_hours: float
    #: Whether the detail holds enough data to judge (the zero-result rate
    #: needs a minimum of searches); otherwise the check is `ok`.
    judged: Callable[[Mapping[str, int | float | None]], bool] = lambda _detail: True
    #: Any number of rows, measured together (a multi-row check).
    many: bool = False
    #: Printed, never written to the status file (decision D9).
    shadow: bool = False

    def run(self, client: QueryClient) -> CheckResult:
        """The check's result; `unknown` when the query fails or answers
        something that is not the rows of counts it asked for."""
        try:
            rows = client.hogql(self.query, name=f"camsocs monitor {self.name}")
            if self.many:
                if len(rows) > MAX_ROWS or any(len(row) != self.width for row in rows):
                    raise QueryFailed("malformed answer")
                value, detail = self.measure(rows)
            else:
                if len(rows) != 1 or len(rows[0]) != self.width:
                    raise QueryFailed("malformed answer")
                value, detail = self.measure(rows[0])
        except QueryFailed as error:
            return self._result("unknown", None, {}, str(error))
        failed = value > self.threshold if self.op == "gt" else value < self.threshold
        status: Status = "failed" if failed and self.judged(detail) else "ok"
        return self._result(status, value, detail)

    def skipped(self, reason: str) -> CheckResult:
        """This check's result when it was not asked (`reason`)."""
        return self._result("unknown", None, {}, reason)

    def _result(
        self,
        status: Status,
        value: int | float | None,
        detail: Mapping[str, int | float | None],
        reason: str | None = None,
    ) -> CheckResult:
        return CheckResult(
            self.name,
            status,
            value,
            self.threshold,
            self.op,
            self.window_hours,
            detail,
            reason,
            shadow=self.shadow,
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


def _paging_checks(campus: str) -> tuple[Check, ...]:
    """The checks that page (ENG-10), for `campus`."""
    return (
        Check(
            "error_spike",
            error_spike_query(campus),
            1,
            _count,
            ERROR_SPIKE_MAX,
            "gt",
            ERROR_SPIKE_MINUTES / 60,
        ),
        # Fails below one successful run in the window.
        Check(
            "stale_harvest",
            stale_harvest_query(campus),
            2,
            _harvest,
            1,
            "lt",
            HARVEST_STALE_HOURS,
        ),
        Check(
            "zero_result_rate",
            zero_result_query(campus),
            2,
            _zero_rate,
            ZERO_RESULT_MAX_RATE,
            "gt",
            ZERO_RESULT_HOURS,
            _enough_searches,
        ),
        Check("pageview_heartbeat", heartbeat_query(campus), 1, _count, 1, "lt", HEARTBEAT_HOURS),
    )


# --- the scraper-health checks (decision D9) ---------------------------------------------


def camel(name: str) -> str:
    """`website_events` → `websiteEvents`: a stage or group name as the
    alert's count names allow (no underscore)."""
    head, *rest = name.split("_")
    return head + "".join(part[:1].upper() + part[1:] for part in rest)


#: A stage or group name as PostHog may return it; anything else is skipped.
_STAGE_NAME = re.compile(r"[a-z][a-z0-9_]{0,39}")


@dataclass(frozen=True)
class StageCadence:
    """What the scraper-health checks know of a campus's stages: their
    registry order, and which run daily (in the `events` group) rather than
    only weekly."""

    order: tuple[str, ...]
    daily: frozenset[str]

    @classmethod
    def of(cls, profile: CampusProfile) -> StageCadence:
        scheduled = campus_groups(profile)
        events = scheduled.get("events")
        return cls(
            tuple(stage.name for stage in registry(profile)),
            frozenset(events.stages) if events is not None else frozenset(),
        )

    def cadence(self, stage: str) -> Literal["events", "full"]:
        return "events" if stage in self.daily else "full"

    def known(self, stage: object) -> str | None:
        """`stage` when it is a stage of this campus, else None."""
        if isinstance(stage, str) and _STAGE_NAME.fullmatch(stage) and stage in self.order:
            return stage
        return None

    def detail(self, breaches: Mapping[str, int | float]) -> dict[str, int | float | None]:
        """The breaching stages in registry order, at most `MAX_DETAIL`."""
        ordered = [stage for stage in self.order if stage in breaches]
        return {camel(stage): breaches[stage] for stage in ordered[:MAX_DETAIL]}


def _optional(value: object) -> int | float | None:
    """A count that may be NULL (a run without that number)."""
    return None if value is None else _number(value)


def _harvest_where(campus: str) -> str:
    """Production, this campus, no dry runs."""
    return PRODUCTION + campus_filter(campus) + NOT_DRY_RUN


#: A stage run's yield: inserted + updated + unchanged (the `yield` property
#: since L6; computed from the counts for runs sent before it).
YIELD = (
    "ifNull(toFloat(properties.yield), toFloat(properties.inserted)"
    " + toFloat(properties.updated) + toFloat(properties.unchanged))"
)
STAGE = "toString(properties.stage)"


def _metric(name: str) -> str:
    """A fetch counter of a stage run (`metrics`, L6); NULL when the run
    fetched nothing or was sent before the counters existed."""
    return f"toFloat(properties.metrics.{name})"


def _runs_by_stage(
    rows: Sequence[Sequence[Any]], cadence: StageCadence
) -> dict[str, list[tuple[float, float]]]:
    """`(stage, minutes ago, number)` rows → per known stage, its runs as
    `(minutes ago, number)`, latest first; rows with a NULL number skipped."""
    runs: dict[str, list[tuple[float, float]]] = defaultdict(list)
    for stage, minutes, number in rows:
        known = cadence.known(stage)
        value = _optional(number)
        if known is None or value is None:
            continue
        runs[known].append((_number(minutes), value))
    for found in runs.values():
        found.sort(key=lambda run: run[0])
    return runs


def _yield_drop(cadence: StageCadence) -> Measure:
    def measure(rows: Sequence[Any]) -> tuple[int | float, dict[str, int | float | None]]:
        breaches: dict[str, int | float] = {}
        for stage, runs in _runs_by_stage(rows, cadence).items():
            window = YIELD_WINDOW_DAYS[cadence.cadence(stage)] * 24 * 60
            (_latest_at, latest), *earlier = runs
            prior = [value for minutes, value in earlier if minutes <= window]
            if len(prior) < YIELD_MIN_RUNS:
                continue
            median = statistics.median(prior)
            dropped = median >= YIELD_MIN_MEDIAN and latest < YIELD_DROP_RATIO * median
            if dropped or (latest == 0 and median > 0):
                breaches[stage] = latest
        return len(breaches), cadence.detail(breaches)

    return measure


def _stage_freshness(cadence: StageCadence) -> Measure:
    def measure(rows: Sequence[Any]) -> tuple[int | float, dict[str, int | float | None]]:
        breaches: dict[str, int | float] = {}
        for stage, minutes in rows:
            known = cadence.known(stage)
            if known is None:
                continue
            hours = round(_number(minutes) / 60, 1)
            if hours > FRESHNESS_HOURS[cadence.cadence(known)]:
                breaches[known] = hours
        return len(breaches), cadence.detail(breaches)

    return measure


def _fetch_error_rate(cadence: StageCadence) -> Measure:
    def measure(rows: Sequence[Any]) -> tuple[int | float, dict[str, int | float | None]]:
        breaches: dict[str, int | float] = {}
        for stage, requests, errors in rows:
            known = cadence.known(stage)
            asked, failed = _optional(requests) or 0, _optional(errors) or 0
            if known is None or asked < FETCH_MIN_REQUESTS:
                continue
            rate = round(failed / asked, 3)
            if rate > FETCH_ERROR_MAX_RATE:
                breaches[known] = rate
        return len(breaches), cadence.detail(breaches)

    return measure


def _rate_limited(cadence: StageCadence) -> Measure:
    def measure(rows: Sequence[Any]) -> tuple[int | float, dict[str, int | float | None]]:
        breaches: dict[str, int | float] = {}
        for stage, too_many in rows:
            known = cadence.known(stage)
            count = _optional(too_many) or 0
            if known is not None and count > RATE_LIMITED_MAX:
                breaches[known] = count
        return len(breaches), cadence.detail(breaches)

    return measure


def _robots_block_jump(cadence: StageCadence) -> Measure:
    def measure(rows: Sequence[Any]) -> tuple[int | float, dict[str, int | float | None]]:
        breaches: dict[str, int | float] = {}
        for stage, runs in _runs_by_stage(rows, cadence).items():
            (latest_at, latest), *earlier = runs
            if latest_at > FETCH_WINDOW_HOURS * 60:
                continue  # no run of this stage to judge today
            reach = latest_at + ROBOTS_JUMP_DAYS * 24 * 60
            prior = [value for minutes, value in earlier if minutes <= reach]
            if not prior:
                continue
            mean = sum(prior) / len(prior)
            if latest >= ROBOTS_JUMP_MIN and latest > ROBOTS_JUMP_FACTOR * mean:
                breaches[stage] = latest
        return len(breaches), cadence.detail(breaches)

    return measure


def _run_duration(rows: Sequence[Any]) -> tuple[int | float, dict[str, int | float | None]]:
    breaches: dict[str, int | float] = {}
    for group, duration in rows:
        seconds = _optional(duration)
        limit = GROUP_TIME_LIMIT_S.get(group) if isinstance(group, str) else None
        if limit is not None and seconds is not None and seconds > RUN_DURATION_SHARE * limit:
            breaches[group] = round(seconds)
    ordered = [group for group in GROUP_TIME_LIMIT_S if group in breaches]
    return len(breaches), {camel(group): breaches[group] for group in ordered[:MAX_DETAIL]}


def _rate(
    total_name: str, part_name: str
) -> Callable[[Sequence[Any]], tuple[int | float, dict[str, int | float | None]]]:
    def measure(row: Sequence[Any]) -> tuple[int | float, dict[str, int | float | None]]:
        total, part = _number(row[0]), _number(row[1])
        rate = round(part / total, 3) if total else 0.0
        return rate, {total_name: total, part_name: part}

    return measure


def _enough(name: str) -> Callable[[Mapping[str, int | float | None]], bool]:
    def judged(detail: Mapping[str, int | float | None]) -> bool:
        return (detail.get(name) or 0) >= LLM_MIN_GENERATIONS

    return judged


def _scraper_checks(profile: CampusProfile) -> tuple[Check, ...]:
    """The scraper-health checks of `profile` (module docstring), in the
    order they run and are printed."""
    campus = profile.id
    cadence = StageCadence.of(profile)
    where = _harvest_where(campus)
    stages = "FROM events WHERE event = 'harvest_stage_completed'" + where
    generations = "FROM events WHERE event = '$ai_generation'" + where
    recent = f" AND timestamp > now() - INTERVAL {FETCH_WINDOW_HOURS} HOUR"
    ran = " AND properties.status != 'not_run'"
    scheduled = campus_groups(profile)
    stale = tuple(
        Check(
            f"stale_harvest_{group}",
            stale_harvest_query(campus, hours=hours, group=group),
            2,
            _harvest,
            1,
            "lt",
            hours,
        )
        for group, hours in STALE_GROUP_HOURS.items()
        if group in scheduled
    )
    yield_days = max(YIELD_WINDOW_DAYS.values())
    return (
        *stale,
        Check(
            "yield_drop",
            f"SELECT {STAGE}, dateDiff('minute', timestamp, now()), {YIELD} {stages}"
            f" AND properties.status = 'ok' AND timestamp > now() - INTERVAL {yield_days} DAY"
            f" ORDER BY timestamp DESC LIMIT {MAX_ROWS}",
            3,
            _yield_drop(cadence),
            0,
            "gt",
            yield_days * 24,
            many=True,
        ),
        Check(
            "stage_freshness",
            f"SELECT {STAGE}, dateDiff('minute', max(timestamp), now()) {stages}"
            f" AND properties.status = 'ok' AND {YIELD} > 0"
            f" AND timestamp > now() - INTERVAL {FRESHNESS_SCAN_DAYS} DAY"
            f" GROUP BY {STAGE} LIMIT {MAX_ROWS}",
            2,
            _stage_freshness(cadence),
            0,
            "gt",
            FRESHNESS_SCAN_DAYS * 24,
            many=True,
        ),
        Check(
            "fetch_error_rate",
            # Both numbers from one row, the newest run that fetched: a run
            # without counters is left out, so `requests` and `errors` never
            # come from two runs. Every non-retried 5xx is already an HTTP
            # error (and a retried one unreachable), so 5xx is not added.
            f"SELECT {STAGE}, argMax({_metric('fetchRequests')}, timestamp),"
            f" argMax(ifNull({_metric('fetchUnreachable')}, 0)"
            f" + ifNull({_metric('fetchHttpError')}, 0), timestamp)"
            f" {stages}{ran}{recent} AND {_metric('fetchRequests')} IS NOT NULL"
            f" GROUP BY {STAGE} LIMIT {MAX_ROWS}",
            3,
            _fetch_error_rate(cadence),
            0,
            "gt",
            FETCH_WINDOW_HOURS,
            many=True,
        ),
        Check(
            "rate_limited",
            f"SELECT {STAGE}, max({_metric('fetchTooMany')})"
            f" {stages}{ran}{recent} GROUP BY {STAGE} LIMIT {MAX_ROWS}",
            2,
            _rate_limited(cadence),
            0,
            "gt",
            FETCH_WINDOW_HOURS,
            many=True,
        ),
        Check(
            "robots_block_jump",
            f"SELECT {STAGE}, dateDiff('minute', timestamp, now()),"
            f" {_metric('fetchRobotsBlocked')} {stages}{ran}"
            f" AND timestamp > now() - INTERVAL {ROBOTS_JUMP_DAYS + 2} DAY"
            f" ORDER BY timestamp DESC LIMIT {MAX_ROWS}",
            3,
            _robots_block_jump(cadence),
            0,
            "gt",
            FETCH_WINDOW_HOURS,
            many=True,
        ),
        Check(
            "run_duration",
            "SELECT toString(properties.group), max(toFloat(properties.durationS))"
            " FROM events WHERE event = 'harvest_run_finished'"
            + where
            + recent
            + " GROUP BY toString(properties.group)"
            + f" LIMIT {MAX_ROWS}",
            2,
            _run_duration,
            0,
            "gt",
            FETCH_WINDOW_HOURS,
            many=True,
        ),
        Check(
            "llm_error_rate",
            "SELECT count(), countIf(toString(properties.$ai_is_error) = 'true') "
            + generations
            + f" AND timestamp > now() - INTERVAL {LLM_HOURS} HOUR",
            2,
            _rate("generations", "errors"),
            LLM_ERROR_MAX_RATE,
            "gt",
            LLM_HOURS,
            _enough("generations"),
        ),
        Check(
            "llm_fallback_rate",
            "SELECT countIf(properties.tier = 'bulk'),"
            " countIf(toString(properties.fallback) = 'true') "
            + generations
            + f" AND timestamp > now() - INTERVAL {LLM_HOURS} HOUR",
            2,
            _rate("bulkGenerations", "fallbacks"),
            LLM_FALLBACK_MAX_RATE,
            "gt",
            LLM_HOURS,
            _enough("bulkGenerations"),
        ),
    )


def _catalogue(profile: CampusProfile) -> tuple[Check, ...]:
    """Every check of `profile`, each marked shadow or not by `SHADOW_CHECKS`."""
    built = (*_paging_checks(profile.id), *_scraper_checks(profile))
    return tuple(replace(check, shadow=check.name in SHADOW_CHECKS) for check in built)


def checks_for(profile: CampusProfile = CAMBRIDGE) -> tuple[Check, ...]:
    """The checks that page for `profile`, in the order they run."""
    return tuple(check for check in _catalogue(profile) if not check.shadow)


def shadow_checks_for(profile: CampusProfile = CAMBRIDGE) -> tuple[Check, ...]:
    """The shadow checks of `profile`, in the order they run."""
    return tuple(check for check in _catalogue(profile) if check.shadow)


#: Cambridge's paging checks, in the order they run and are printed.
CHECKS: tuple[Check, ...] = checks_for(CAMBRIDGE)
CHECK_NAMES = tuple(check.name for check in CHECKS)


def run_checks(client: QueryClient, checks: Iterable[Check] = CHECKS) -> list[CheckResult]:
    """Every check; a query that fails makes its check `unknown`, never an error."""
    return [check.run(client) for check in checks]


def run_shadow_checks(
    client: QueryClient,
    checks: Iterable[Check],
    *,
    budget_s: float = SHADOW_BUDGET_S,
    clock: Callable[[], float] = time.monotonic,
) -> list[CheckResult]:
    """The shadow checks, within `budget_s` seconds together: a check not
    started in time is `unknown` (``time budget``). Nothing here raises: an
    unexpected error makes that check `unknown` by its class name, so a
    shadow check can never fail the run."""
    start = clock()
    found: list[CheckResult] = []
    for check in checks:
        if clock() - start > budget_s:
            found.append(check.skipped("time budget"))
            continue
        try:
            found.append(check.run(client))
        except Exception as error:  # a shadow check must never fail the run
            logger.warning("monitor: shadow check %s raised %s", check.name, type(error).__name__)
            found.append(check.skipped(type(error).__name__))
    return found


# --- the site, from outside (ENG-33) -------------------------------------------------------


def site_client(about_url: str = ABOUT_URL) -> httpx.Client:
    """The client the site checks use: no redirects followed (one is a
    failure); its user agent points at the campus's about page (Cambridge's:
    `SITE_USER_AGENT`)."""
    agent = SITE_USER_AGENT if about_url == ABOUT_URL else f"camsocs-monitor/0.1 (+{about_url})"
    return httpx.Client(timeout=SITE_TIMEOUT, follow_redirects=False, headers={"User-Agent": agent})


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


def count_requests(
    client: QueryClient, since: datetime, until: datetime, campus: str = "cam"
) -> RequestCount:
    """This window's new requests of `campus` by kind; `unknown` when PostHog
    does not answer, or answers with a bound it did not read as this window's
    (never an error). An empty window asks nothing."""
    if since >= until:
        return RequestCount("ok", since, until)
    width = 1 + len(LISTING_REQUEST_KINDS) + 2
    try:
        rows = client.hogql(
            requests_query(since, until, campus), name=f"camsocs monitor {REQUESTS_NAME}"
        )
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
    #: The campus checked and its public site (the alert's inbox link).
    campus: str = "cam"
    site: str | None = None
    #: The shadow checks' results: printed, never in the status file (D9).
    shadow: list[CheckResult] = field(default_factory=list)

    def with_shadow(self, results: Sequence[CheckResult]) -> Assessment:
        """This verdict with the shadow checks' results (paging unchanged)."""
        return replace(self, shadow=list(results))

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
        """The status file (`--status-json`); the Slack alert reads it. The
        shadow checks are never in it."""
        return {
            "kind": "monitor",
            "campus": self.campus,
            "site": self.site,
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

    def json_payload(self, invocation_id: str | None = None) -> dict[str, Any]:
        """What ``--json`` prints: the status file plus the shadow checks."""
        return {
            **self.status_payload(invocation_id),
            "shadowChecks": [result.to_json() for result in self.shadow],
        }


def assess(
    results: list[CheckResult],
    previous: Mapping[str, Any],
    *,
    now: datetime,
    requests: RequestCount | None = None,
    campus: str = "cam",
    site: str | None = None,
) -> Assessment:
    """Whether `results` page, given the previous run's status file
    (`previous`, `{}` when there is none): failures that were not already
    paged for within `REALERT_AFTER` do, as do a paged site check that is
    `ok` again and any new listing request (`requests`).

    A paged check is forgotten only once it is seen `ok` again: a run where
    PostHog did not answer for it (`unknown`) keeps the page in memory, so a
    query blip during a lasting failure does not page twice, and a check that
    recovered and fails again counts as new and pages at once.

    A shadow result passed here by mistake is left out: it never pages."""
    results = [r for r in results if not r.shadow]
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
    return Assessment(
        results, now, page, sorted(alerting), at, back, requests, campus=campus, site=site
    )


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
    for result in assessment.shadow:
        yield result.line()


__all__ = [
    "CHECKS",
    "CHECK_NAMES",
    "ERROR_SPIKE_MAX",
    "ERROR_SPIKE_MINUTES",
    "FETCH_ERROR_MAX_RATE",
    "FETCH_MIN_REQUESTS",
    "FETCH_WINDOW_HOURS",
    "FRESHNESS_HOURS",
    "FRESHNESS_SCAN_DAYS",
    "GROUP_TIME_LIMIT_S",
    "HARVEST_STALE_HOURS",
    "HEARTBEAT_HOURS",
    "LLM_ERROR_MAX_RATE",
    "LLM_FALLBACK_MAX_RATE",
    "LLM_HOURS",
    "LLM_MIN_GENERATIONS",
    "MAX_DETAIL",
    "NOT_DRY_RUN",
    "NOT_INTERNAL",
    "RATE_LIMITED_MAX",
    "REALERT_AFTER",
    "REQUESTS_FIRST_WINDOW",
    "REQUESTS_LAG",
    "REQUESTS_MAX_WINDOW",
    "REQUESTS_NAME",
    "REQUESTS_SCAN_DAYS",
    "ROBOTS_JUMP_DAYS",
    "ROBOTS_JUMP_FACTOR",
    "ROBOTS_JUMP_MIN",
    "RUN_DURATION_SHARE",
    "SHADOW_BUDGET_S",
    "SHADOW_CHECKS",
    "SITE_ATTEMPTS",
    "SITE_CHECKS",
    "SITE_CHECK_NAMES",
    "SITE_RETRY_PAUSE",
    "SITE_TIMEOUT",
    "STALE_GROUP_HOURS",
    "YIELD_DROP_RATIO",
    "YIELD_MIN_MEDIAN",
    "YIELD_MIN_RUNS",
    "YIELD_WINDOW_DAYS",
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
    "StageCadence",
    "assess",
    "camel",
    "campus_filter",
    "check_site",
    "check_sites",
    "checks_for",
    "count_requests",
    "error_spike_query",
    "heartbeat_query",
    "read_status",
    "requests_query",
    "requests_window",
    "run_checks",
    "run_shadow_checks",
    "safe_invocation_id",
    "shadow_checks_for",
    "site_client",
    "stale_harvest_query",
    "summary",
    "zero_result_query",
]
