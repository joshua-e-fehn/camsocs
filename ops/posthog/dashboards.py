#!/usr/bin/env python3
"""camsocs's PostHog dashboards as code (ENG-10; docs/deploy.md "PostHog").

    pixi run posthog-dashboards -- --dry-run    # print the JSON it would send; no key needed
    pixi run posthog-dashboards -- --validate   # run every insight's query once (read-only)
    pixi run posthog-dashboards -- --apply      # create or update the dashboards in PostHog

Five dashboards — Traffic, Content, Search, Reliability, Scraper health —
each a list of insights in PostHog's query format (research-api §1–2): trends as
``InsightVizNode`` → ``TrendsQuery``, tables and custom buckets as
``DataVisualizationNode`` → ``HogQLQuery``. Every insight excludes internal and
test traffic: ``filterTestAccounts: true`` on a trends query (the schema's
default is false), and ``{filters}`` with ``filterTestAccounts`` in HogQL.
The project's filter drops ``environment = development`` (local runs and
the dev deployment), Joshua's cohort and the in-app Claude browser.

**Harvest insights** (every insight over a ``harvest_*`` event, and the
scraper-health ones over the pipeline's ``$ai_*`` events) leave out dry runs
(``NOT_DRY_RUN``) and break down by campus (decision D8: ``CAMPUS``, where an
event sent before the property existed is Cambridge's): a trend by a HogQL
breakdown ``<campus> · <value>``, a table by a ``campus`` column. Their
names are unchanged, so ``--apply`` updates them in place.

**Idempotent, by name.** ``--apply`` finds each dashboard by its exact name
(creating it when missing), then each insight by its name among the
dashboard's tiles: an existing one is updated in place (name, description,
query, tags), a missing one is created on the dashboard. Nothing is deleted:
an insight tagged ``managed-by-code`` that the code no longer defines is
reported, for a person to remove in PostHog. Tiles are placed by PostHog.

**Privacy.** Insights break down by IDs, keys and enums only (``orgKey``,
``eventKey``, ``talkKey``, ``feed``, ``kind``, ``surface``, a stage, a model
id, a campus id, a host class): camsocs resolves names, PostHog never
receives them (docs/analytics.md).
Browser numbers count only visitors who accepted analytics.

**Credentials** come from the environment, never from a file here:
``POSTHOG_PERSONAL_API_KEY`` (a personal key scoped to the camsocs project:
``insight:write`` and ``dashboard:write`` for ``--apply``, ``query:read`` for
``--validate``; 1Password Mya vault, item ``PostHog``), ``POSTHOG_PROJECT_ID``
and ``POSTHOG_APP_HOST`` (default ``https://eu.posthog.com``). The key is
never printed. Standard library only.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

DEFAULT_APP_HOST = "https://eu.posthog.com"
#: On every dashboard and insight this script owns.
MANAGED_TAG = "managed-by-code"
#: The default window of an insight.
DATE_FROM = "-30d"
#: PostHog's limit on an insight's name and description.
MAX_TEXT = 400
CONSENTED = "Counts only visitors who accepted analytics (the banner), so it undercounts."
IDS_ONLY = (
    "IDs only: camsocs resolves the name (the key is the page's URL slug); "
    "PostHog never receives titles or names."
)
#: A HogQL expression naming where an exception came from (ENG-6): the
#: server sends as `camsocs-server` through posthog-node.
EXCEPTION_SOURCE = (
    "if(distinct_id = 'camsocs-server' OR properties.$lib = 'posthog-node', 'server', 'browser')"
)
#: A harvest event's campus (decision D8); one sent before the property
#: existed is Cambridge's. The monitor scopes its queries the same way.
CAMPUS = "ifNull(properties.campus, 'cam')"
#: Leaves out dry runs (`dryRun` is a boolean; PostHog may store it as text),
#: as the monitor's harvest queries do (`monitor.NOT_DRY_RUN`).
NOT_DRY_RUN = "ifNull(toString(properties.dryRun), '') != 'true'"
#: The runner's time limit per group (camsocs-harvest.sh
#: `CAMSOCS_TIMEOUT_EVENTS` / `_FULL`; `monitor.GROUP_TIME_LIMIT_S`).
GROUP_TIME_LIMIT_S: Mapping[str, int] = {"events": 7200, "full": 21600}
#: A stage run's yield: inserted + updated + unchanged (the `yield` property,
#: computed from the counts for runs sent before it; `monitor.YIELD`).
YIELD = (
    "ifNull(toFloat(properties.yield), toFloat(properties.inserted)"
    " + toFloat(properties.updated) + toFloat(properties.unchanged))"
)


@dataclass(frozen=True)
class Insight:
    name: str
    description: str
    query: Mapping[str, Any]


@dataclass(frozen=True)
class Dashboard:
    name: str
    description: str
    insights: tuple[Insight, ...]


# --- query builders -----------------------------------------------------------------------


def events(
    event: str,
    *,
    math: str = "total",
    math_property: str | None = None,
    name: str | None = None,
) -> dict[str, Any]:
    """One trends series (`EventsNode`)."""
    node: dict[str, Any] = {"kind": "EventsNode", "event": event, "name": event, "math": math}
    if math_property is not None:
        node["math_property"] = math_property
    if name is not None:
        node["custom_name"] = name
    return node


def trends(
    *series: dict[str, Any],
    interval: str = "day",
    date_from: str = DATE_FROM,
    breakdown: str | None = None,
    breakdown_type: str = "event",
    breakdown_limit: int = 25,
    display: str = "ActionsLineGraph",
    formula: tuple[str, str] | None = None,
    axis_format: str | None = None,
    where: Sequence[str] = (),
) -> dict[str, Any]:
    """An `InsightVizNode` around a `TrendsQuery`, test accounts excluded;
    `where` adds HogQL conditions every event must meet."""
    trends_filter: dict[str, Any] = {"display": display}
    if formula is not None:
        trends_filter["formulaNodes"] = [{"formula": formula[0], "custom_name": formula[1]}]
    if axis_format is not None:
        trends_filter["aggregationAxisFormat"] = axis_format
    source: dict[str, Any] = {
        "kind": "TrendsQuery",
        "series": list(series),
        "interval": interval,
        "dateRange": {"date_from": date_from, "date_to": None},
        "filterTestAccounts": True,
        "trendsFilter": trends_filter,
    }
    if where:
        source["properties"] = [{"type": "hogql", "key": condition} for condition in where]
    if breakdown is not None:
        source["breakdownFilter"] = {
            "breakdown": breakdown,
            "breakdown_type": breakdown_type,
            "breakdown_limit": breakdown_limit,
        }
    return {"kind": "InsightVizNode", "source": source}


def sql(
    query: str,
    *,
    date_from: str = DATE_FROM,
    display: str = "ActionsTable",
    x: str | None = None,
    y: Sequence[str] = (),
) -> dict[str, Any]:
    """A `DataVisualizationNode` around a `HogQLQuery`. The query must use
    `{filters}`, which applies the date range and the test-account filter."""
    if "{filters}" not in query:
        raise ValueError("a dashboard SQL insight must use {filters}")
    node: dict[str, Any] = {
        "kind": "DataVisualizationNode",
        "display": display,
        "source": {
            "kind": "HogQLQuery",
            "query": query,
            "filters": {"dateRange": {"date_from": date_from}, "filterTestAccounts": True},
        },
    }
    if x is not None:
        node["chartSettings"] = {
            "xAxis": {"column": x},
            "yAxis": [{"column": column} for column in y],
        }
    return node


def harvest_trends(*series: dict[str, Any], by: str, **options: Any) -> dict[str, Any]:
    """A trend over harvest events: dry runs left out, broken down by campus
    and the property `by` (``cam · success``)."""
    return trends(
        *series,
        breakdown=f"concat({CAMPUS}, ' · ', ifNull(toString(properties.{by}), ''))",
        breakdown_type="hogql",
        where=(NOT_DRY_RUN,),
        **options,
    )


def metric(name: str) -> str:
    """A counter of a stage run (`harvest_stage_completed` `metrics`,
    fetch_stats.py); NULL when the run fetched nothing or predates it."""
    return f"toFloat(properties.metrics.{name})"


def summed(name: str, alias: str) -> str:
    """The sum of a stage-run counter, 0 when no run had it."""
    return f"ifNull(sum({metric(name)}), 0) AS {alias}"


def stage_runs(*conditions: str) -> str:
    """The FROM/WHERE of a table over stage runs: no dry runs, `{filters}`."""
    extra = "".join(f" AND {condition}" for condition in conditions)
    return (
        f" FROM events WHERE event = 'harvest_stage_completed' AND {NOT_DRY_RUN}{extra}"
        " AND {filters}"
    )


# --- the dashboards -------------------------------------------------------------------------

TRAFFIC = Dashboard(
    "camsocs: Traffic",
    "Who visits camsocs.uk and from where. " + CONSENTED + " Managed in code "
    "(ops/posthog/dashboards.py): edits here are overwritten.",
    (
        Insight(
            "Unique visitors and pageviews per day",
            "Daily unique visitors (distinct browsers) and $pageview events, last 30 days. "
            + CONSENTED,
            trends(
                events("$pageview", math="dau", name="Unique visitors"),
                events("$pageview", name="Pageviews"),
            ),
        ),
        Insight(
            "Weekly visitors (Cambridge weeks, Thursday to Wednesday)",
            "Unique visitors and pageviews per week, weeks starting on Thursday like "
            "Cambridge term weeks, last 26 weeks. " + CONSENTED,
            sql(
                "SELECT toStartOfWeek(toTimeZone(timestamp, 'Europe/London') - INTERVAL 3 DAY, 1)"
                " + INTERVAL 3 DAY AS week_from_thursday,"
                " count(DISTINCT person_id) AS visitors, count() AS pageviews"
                " FROM events WHERE event = '$pageview' AND {filters}"
                " GROUP BY week_from_thursday ORDER BY week_from_thursday",
                date_from="-182d",
                display="ActionsBar",
                x="week_from_thursday",
                y=("visitors", "pageviews"),
            ),
        ),
        Insight(
            "Top pages",
            "Pageviews by path (query strings are stripped by the client), last 30 days. "
            + CONSENTED,
            trends(
                events("$pageview"),
                breakdown="$pathname",
                display="ActionsBarValue",
            ),
        ),
        Insight(
            "Referring domains (session entry)",
            "Sessions by the domain the visitor arrived from ($direct: typed or bookmarked), "
            "last 30 days. " + CONSENTED,
            trends(
                events("$pageview", math="unique_session", name="Sessions"),
                breakdown="$session_entry_referring_domain",
                display="ActionsBarValue",
            ),
        ),
        Insight(
            "Device type",
            "Unique visitors by device type (Desktop, Mobile, Tablet), last 30 days. " + CONSENTED,
            trends(
                events("$pageview", math="dau", name="Unique visitors"),
                breakdown="$device_type",
                display="ActionsPie",
            ),
        ),
    ),
)

CONTENT = Dashboard(
    "camsocs: Content",
    "What visitors open and follow, by ID. " + IDS_ONLY + " Browser events count consented "
    "visitors only; ICS fetches are server counts. Managed in code (ops/posthog/dashboards.py).",
    (
        Insight(
            "Top societies viewed (orgKey)",
            "society_viewed by orgKey, last 30 days. " + IDS_ONLY,
            trends(events("society_viewed"), breakdown="orgKey", display="ActionsBarValue"),
        ),
        Insight(
            "Top events viewed (eventKey)",
            "event_viewed by eventKey, last 30 days. " + IDS_ONLY,
            trends(events("event_viewed"), breakdown="eventKey", display="ActionsBarValue"),
        ),
        Insight(
            "Top talks viewed (talkKey)",
            "talk_viewed by talkKey, last 30 days. " + IDS_ONLY,
            trends(events("talk_viewed"), breakdown="talkKey", display="ActionsBarValue"),
        ),
        Insight(
            "Calendar subscribe clicks by feed",
            "calendar_subscribe_clicked by feed (talks, events, event, talk) per week, "
            "last 90 days. Consented visitors only.",
            trends(
                events("calendar_subscribe_clicked"),
                interval="week",
                date_from="-90d",
                breakdown="feed",
                display="ActionsStackedBar",
            ),
        ),
        Insight(
            "ICS feed fetches by feed (server)",
            "ics_feed_fetched by feed per day, counted on the server (camsocs-server, no "
            "consent needed). A lower bound: fetches served from the CDN cache are not counted.",
            trends(events("ics_feed_fetched"), breakdown="feed", display="ActionsStackedBar"),
        ),
        Insight(
            "Outbound link clicks by kind",
            "outbound_link_clicked by kind (website, social, source, other), last 30 days; "
            "no URL is sent. Consented visitors only.",
            trends(events("outbound_link_clicked"), breakdown="kind", display="ActionsPie"),
        ),
    ),
)

SEARCH = Dashboard(
    "camsocs: Search",
    "How search is used and how often it finds nothing. The query text is never sent: only "
    "its length and the result count. Consented visitors only. Managed in code "
    "(ops/posthog/dashboards.py).",
    (
        Insight(
            "Searches per day by surface",
            "search_performed per day, by the search box it came from, last 30 days.",
            trends(events("search_performed"), breakdown="surface", display="ActionsStackedBar"),
        ),
        Insight(
            "Zero-result rate",
            "search_zero_results as a percentage of search_performed per day, last 30 days. "
            "The monitor alerts above 50 % over 24 h with at least 20 searches.",
            trends(
                events("search_zero_results"),
                events("search_performed"),
                formula=("A / B * 100", "Zero-result rate"),
                axis_format="percentage",
            ),
        ),
        Insight(
            "Query length distribution",
            "search_performed by query length in characters (30 = 30 or more), last 30 days.",
            sql(
                "SELECT least(toInt(properties.queryLength), 30) AS query_length,"
                " count() AS searches"
                " FROM events WHERE event = 'search_performed' AND {filters}"
                " GROUP BY query_length ORDER BY query_length",
                display="ActionsBar",
                x="query_length",
                y=("searches",),
            ),
        ),
    ),
)

RELIABILITY = Dashboard(
    "camsocs: Reliability",
    "Errors, harvests and model calls. The hourly monitor (camsocs monitor, docs/ops-vps.md) "
    "alerts on the same events. Managed in code (ops/posthog/dashboards.py).",
    (
        Insight(
            "Exceptions per day: browser vs server",
            "$exception events per day: browser (consented visitors) or server "
            "(camsocs-server, posthog-node). The monitor alerts above 20 in an hour.",
            trends(
                events("$exception"),
                breakdown=EXCEPTION_SOURCE,
                breakdown_type="hogql",
                display="ActionsStackedBar",
            ),
        ),
        Insight(
            "Harvest runs by status",
            "harvest_run_finished per day by campus and status (success, partial, failed), "
            "production VPS runs, dry runs excluded. The monitor alerts after 26 h without a "
            "success or partial run.",
            harvest_trends(
                events("harvest_run_finished"), by="status", display="ActionsStackedBar"
            ),
        ),
        Insight(
            "Harvest stage duration per day (average, by stage)",
            "Average harvest_stage_completed durationS per day by campus and stage, dry runs "
            "excluded, last 30 days.",
            harvest_trends(
                events("harvest_stage_completed", math="avg", math_property="durationS"),
                by="stage",
                axis_format="duration",
            ),
        ),
        Insight(
            "Harvest stages (30 days)",
            "Per campus and stage: runs, failures, runs skipped, and durations (seconds) from "
            "harvest_stage_completed, dry runs excluded, last 30 days.",
            sql(
                f"SELECT {CAMPUS} AS campus, properties.stage AS stage, count() AS runs,"
                " countIf(properties.status = 'failed') AS failed,"
                " countIf(properties.status = 'not_run') AS not_run,"
                " round(avg(toFloat(properties.durationS)), 1) AS avg_s,"
                " round(quantile(0.9)(toFloat(properties.durationS)), 1) AS p90_s,"
                " round(max(toFloat(properties.durationS)), 1) AS max_s"
                + stage_runs()
                + " GROUP BY campus, stage ORDER BY avg_s DESC LIMIT 100"
            ),
        ),
        Insight(
            "LLM generations per day by model",
            "$ai_generation events (cliproxy requests) per day by model, last 30 days.",
            trends(events("$ai_generation"), breakdown="$ai_model", display="ActionsStackedBar"),
        ),
        Insight(
            "LLM tokens per day",
            "Input and output tokens the proxy reported, summed per day, last 30 days.",
            trends(
                events(
                    "$ai_generation", math="sum", math_property="$ai_input_tokens", name="Input"
                ),
                events(
                    "$ai_generation", math="sum", math_property="$ai_output_tokens", name="Output"
                ),
            ),
        ),
        Insight(
            "LLM calls by model and stage (30 days)",
            "Per model and stage: generations, errors, tokens and latency (seconds) from "
            "$ai_generation, last 30 days. No prompt or reply is ever sent.",
            sql(
                "SELECT properties.$ai_model AS model, properties.stage AS stage,"
                " count() AS generations,"
                " countIf(toString(properties.$ai_is_error) = 'true') AS errors,"
                " sum(toInt(properties.$ai_input_tokens)) AS input_tokens,"
                " sum(toInt(properties.$ai_output_tokens)) AS output_tokens,"
                " round(avg(toFloat(properties.$ai_latency)), 2) AS avg_latency_s,"
                " round(quantile(0.95)(toFloat(properties.$ai_latency)), 2) AS p95_latency_s"
                " FROM events WHERE event = '$ai_generation' AND {filters}"
                " GROUP BY model, stage ORDER BY generations DESC LIMIT 100"
            ),
        ),
        Insight(
            "Listing requests received by kind",
            "listing_request_received per week by kind, counted on the server when a request "
            "is stored (no form content), last 90 days.",
            trends(
                events("listing_request_received"),
                interval="week",
                date_from="-90d",
                breakdown="kind",
                display="ActionsStackedBar",
            ),
        ),
    ),
)

#: A run's time limit by its group, in HogQL (`GROUP_TIME_LIMIT_S`).
_LIMIT = (
    "multiIf("
    + ", ".join(
        f"run_group = '{group}', {seconds}" for group, seconds in GROUP_TIME_LIMIT_S.items()
    )
    + ", NULL)"
)

SCRAPER_HEALTH = Dashboard(
    "camsocs: Scraper health",
    "Is each campus's harvest still finding, fetching and finishing? Production runs by "
    "campus, dry runs excluded; stage names, host classes and counts only. The monitor's "
    "shadow checks (decision D9, docs/ops-vps.md) judge the same numbers. Managed in code "
    "(ops/posthog/dashboards.py).",
    (
        Insight(
            "Yield against the 7/28-day median",
            "Per campus and stage: the latest ok run's yield (inserted + updated + unchanged), "
            "the median of the ok runs of the last 7 days (28 for a stage with fewer than 3 "
            "runs in 7, a weekly-only one; the latest included), their ratio and the runs. "
            "The monitor's yield_drop flags a ratio below 0.25.",
            sql(
                "SELECT campus, stage, pillar, latest,"
                " if(runs_7d >= 3, median_7d, median_28d) AS median,"
                " if(median > 0, round(latest / median, 2), NULL) AS ratio,"
                " if(runs_7d >= 3, runs_7d, runs_28d) AS runs"
                f" FROM (SELECT {CAMPUS} AS campus, toString(properties.stage) AS stage,"
                " any(toString(properties.pillar)) AS pillar,"
                f" argMax({YIELD}, timestamp) AS latest,"
                " countIf(timestamp > now() - INTERVAL 7 DAY) AS runs_7d,"
                f" quantile(0.5)(if(timestamp > now() - INTERVAL 7 DAY, {YIELD}, NULL))"
                " AS median_7d,"
                f" quantile(0.5)({YIELD}) AS median_28d, count() AS runs_28d"
                + stage_runs("properties.status = 'ok'")
                + " GROUP BY campus, stage)"
                " ORDER BY ratio ASC NULLS LAST, campus, stage LIMIT 200",
                date_from="-28d",
            ),
        ),
        Insight(
            "Hours since the last productive run",
            "Per campus and stage: hours since its last ok run with a yield above zero, last "
            "35 days (a stage with none is not listed). The monitor's stage_freshness flags "
            "more than 50 h for a daily stage, 198 h for a weekly-only one.",
            sql(
                f"SELECT {CAMPUS} AS campus, toString(properties.stage) AS stage,"
                " any(toString(properties.pillar)) AS pillar,"
                " dateDiff('hour', max(timestamp), now()) AS hours_since_productive"
                + stage_runs("properties.status = 'ok'", f"{YIELD} > 0")
                + " GROUP BY campus, stage ORDER BY hours_since_productive DESC LIMIT 200",
                date_from="-35d",
            ),
        ),
        Insight(
            "Fetch outcomes per stage per day",
            "Per day, campus and stage: requests and how they ended (fetched, unchanged, not "
            "found, restricted, robots.txt blocked, unreachable, HTTP error) and cache hits, "
            "from the stage's fetch counters, last 14 days.",
            sql(
                f"SELECT toDate(timestamp) AS day, {CAMPUS} AS campus,"
                " toString(properties.stage) AS stage, "
                + ", ".join(
                    summed(name, alias)
                    for name, alias in (
                        ("fetchRequests", "requests"),
                        ("fetchFetched", "fetched"),
                        ("fetchUnchanged", "unchanged"),
                        ("fetchNotFound", "not_found"),
                        ("fetchRestricted", "restricted"),
                        ("fetchRobotsBlocked", "robots_blocked"),
                        ("fetchUnreachable", "unreachable"),
                        ("fetchHttpError", "http_error"),
                        ("fetchCacheHits", "cache_hits"),
                    )
                )
                + stage_runs()
                + " GROUP BY day, campus, stage HAVING requests > 0"
                " ORDER BY day DESC, requests DESC LIMIT 500",
                date_from="-14d",
            ),
        ),
        Insight(
            "HTTP status class by host class",
            "Per campus and host class (registry, university_main_site, society_website, "
            "linktree, …; never a host): answers by HTTP status class, 429s and unreachable "
            "requests, from harvest_source_fetched, last 30 days.",
            sql(
                f"SELECT {CAMPUS} AS campus, toString(properties.hostClass) AS host_class, "
                + ", ".join(
                    f"ifNull(sum(toFloat(properties.{name})), 0) AS {alias}"
                    for name, alias in (
                        ("fetchRequests", "requests"),
                        ("fetchStatus2xx", "status_2xx"),
                        ("fetchStatus3xx", "status_3xx"),
                        ("fetchStatus4xx", "status_4xx"),
                        ("fetchStatus5xx", "status_5xx"),
                        ("fetchTooMany", "too_many"),
                        ("fetchUnreachable", "unreachable"),
                    )
                )
                + " FROM events WHERE event = 'harvest_source_fetched'"
                f" AND {NOT_DRY_RUN} AND {{filters}}"
                " GROUP BY campus, host_class ORDER BY campus, requests DESC LIMIT 100"
            ),
        ),
        Insight(
            "Robots blocks and overrides per week",
            "Per week and campus: fetches robots.txt blocked, recorded overrides (a society's "
            "own pages, D3; a publisher's recorded permission, D3a) and hosts whose robots.txt "
            "could not be read, last 13 weeks. The monitor's robots_block_jump watches blocks.",
            sql(
                f"SELECT toStartOfWeek(timestamp, 1) AS week, {CAMPUS} AS campus, "
                + ", ".join(
                    summed(name, alias)
                    for name, alias in (
                        ("fetchRobotsBlocked", "robots_blocked"),
                        ("fetchOverrideSociety", "override_society"),
                        ("fetchOverridePermission", "override_permission"),
                        ("robotsHostsUnreachable", "robots_unreachable"),
                    )
                )
                + stage_runs()
                + " GROUP BY week, campus ORDER BY week DESC, campus LIMIT 200",
                date_from="-91d",
            ),
        ),
        Insight(
            "Retries, 429s and wait",
            "Per day and campus: request retries, 429 (too many requests) answers, refused "
            "non-public addresses and minutes spent waiting for a host's turn (Crawl-delay, "
            "one request in flight per host), last 30 days. The monitor's rate_limited flags "
            "more than 10 429s in one stage run.",
            sql(
                f"SELECT toDate(timestamp) AS day, {CAMPUS} AS campus, "
                + ", ".join(
                    summed(name, alias)
                    for name, alias in (
                        ("fetchRetries", "retries"),
                        ("fetchTooMany", "too_many"),
                        ("fetchAddressRefused", "address_refused"),
                    )
                )
                + f", round(ifNull(sum({metric('fetchWaitS')}), 0) / 60, 1) AS wait_min"
                + stage_runs()
                + " GROUP BY day, campus ORDER BY day DESC, campus LIMIT 200"
            ),
        ),
        Insight(
            "Run duration against the limit by group",
            "Per run: campus, group, its duration and the runner's time limit for the group "
            "(events 2 h, full 6 h), and the share used, last 30 days. The monitor's "
            "run_duration flags more than 0.8; a killed run sends no finish event.",
            sql(
                "SELECT finished, campus, run_group, duration_s,"
                f" {_LIMIT} AS limit_s, round(duration_s / limit_s, 2) AS share"
                " FROM (SELECT timestamp AS finished,"
                f" {CAMPUS} AS campus, toString(properties.group) AS run_group,"
                " round(toFloat(properties.durationS)) AS duration_s"
                " FROM events WHERE event = 'harvest_run_finished'"
                f" AND {NOT_DRY_RUN} AND {{filters}})"
                " ORDER BY finished DESC LIMIT 200"
            ),
        ),
        Insight(
            "Stage duration p50/p90 weekly",
            "Per week, campus and stage: median and 90th percentile of the stage's duration "
            "(seconds) and its runs, from harvest_stage_completed, last 13 weeks.",
            sql(
                f"SELECT toStartOfWeek(timestamp, 1) AS week, {CAMPUS} AS campus,"
                " toString(properties.stage) AS stage,"
                " round(quantile(0.5)(toFloat(properties.durationS)), 1) AS p50_s,"
                " round(quantile(0.9)(toFloat(properties.durationS)), 1) AS p90_s,"
                " count() AS runs"
                + stage_runs("properties.status != 'not_run'")
                + " GROUP BY week, campus, stage ORDER BY week DESC, p90_s DESC LIMIT 500",
                date_from="-91d",
            ),
        ),
        Insight(
            "LLM generations against cache hits",
            "Per day and campus: model requests the stages made against answers taken from the "
            "LLM cache (var/cache/llm), from the stages' counters, and the share served from "
            "the cache, last 30 days. No prompt or reply is ever sent.",
            sql(
                f"SELECT toDate(timestamp) AS day, {CAMPUS} AS campus, "
                + summed("llmGenerations", "generations")
                + ", "
                + summed("llmCacheHits", "cache_hits")
                + ", if(generations + cache_hits > 0,"
                " round(cache_hits / (generations + cache_hits), 3), NULL) AS cache_share"
                + stage_runs()
                + " GROUP BY day, campus ORDER BY day DESC, campus LIMIT 200"
            ),
        ),
        Insight(
            "Traces per run",
            "Per day and campus: harvest runs finished, LLM-analytics traces ($ai_trace, one "
            "per run key), stage spans and generations; traces per run should be 1. Dry runs "
            "excluded, last 30 days.",
            sql(
                f"SELECT toDate(timestamp) AS day, {CAMPUS} AS campus,"
                " count(DISTINCT if(event = 'harvest_run_finished', properties.runKey, NULL))"
                " AS runs,"
                " count(DISTINCT if(event = '$ai_trace', properties.$ai_trace_id, NULL))"
                " AS traces,"
                " if(runs > 0, round(traces / runs, 2), NULL) AS traces_per_run,"
                " countIf(event = '$ai_span') AS spans,"
                " countIf(event = '$ai_generation') AS generations"
                " FROM events WHERE event IN"
                " ('harvest_run_finished', '$ai_trace', '$ai_span', '$ai_generation')"
                f" AND {NOT_DRY_RUN} AND {{filters}}"
                " GROUP BY day, campus ORDER BY day DESC, campus LIMIT 200"
            ),
        ),
    ),
)

DASHBOARDS: tuple[Dashboard, ...] = (TRAFFIC, CONTENT, SEARCH, RELIABILITY, SCRAPER_HEALTH)


# --- payloads -----------------------------------------------------------------------------


def dashboard_payload(dashboard: Dashboard) -> dict[str, Any]:
    return {"name": dashboard.name, "description": dashboard.description, "tags": [MANAGED_TAG]}


def insight_payload(insight: Insight, dashboard_id: int | None = None) -> dict[str, Any]:
    """The insight's fields. `dashboard_id` only on create: on an update the
    deprecated `dashboards` field would replace the insight's membership."""
    payload: dict[str, Any] = {
        "name": insight.name,
        "description": insight.description,
        "query": insight.query,
        "tags": [MANAGED_TAG],
    }
    if dashboard_id is not None:
        payload["dashboards"] = [dashboard_id]
    return payload


def query_of(insight: Insight) -> dict[str, Any]:
    """What `--validate` sends to the query API: the node's source."""
    return dict(insight.query["source"])


def plan(dashboards: Sequence[Dashboard] = DASHBOARDS) -> list[dict[str, Any]]:
    """`--dry-run`'s output: each dashboard and the insights created on it
    (the dashboard's id is known only once it exists)."""
    return [
        {
            "dashboard": dashboard_payload(dashboard),
            "insights": [
                {**insight_payload(insight), "dashboards": ["<id of the dashboard above>"]}
                for insight in dashboard.insights
            ],
        }
        for dashboard in dashboards
    ]


# --- the API ------------------------------------------------------------------------------

Opener = Callable[..., Any]


class APIError(RuntimeError):
    """A request PostHog refused; the message carries no credential."""


class PostHogAPI:
    """The private REST API with a personal key (research-api §0)."""

    def __init__(
        self,
        host: str,
        project_id: str,
        key: str,
        opener: Opener = urllib.request.urlopen,
    ) -> None:
        if not project_id.isdigit():
            raise APIError("POSTHOG_PROJECT_ID must be the project's numeric id")
        self.base = f"{host.rstrip('/')}/api/projects/{project_id}/"
        self._key = key
        self._opener = opener

    def request(self, method: str, path: str, body: Mapping[str, Any] | None = None) -> Any:
        url = path if path.startswith("https://") else self.base + path
        if not url.startswith(self.base):
            raise APIError(f"refusing a URL outside the project: {url}")
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(
            url,
            data=data,
            method=method,
            headers={"Authorization": f"Bearer {self._key}", "Content-Type": "application/json"},
        )
        try:
            with self._opener(request, timeout=60) as response:
                return json.loads(response.read() or b"null")
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")[:300]
            raise APIError(f"{method} {path}: HTTP {error.code} {detail}") from None
        except (urllib.error.URLError, OSError, ValueError) as error:
            raise APIError(f"{method} {path}: {type(error).__name__}") from None

    def pages(self, path: str) -> Iterator[dict[str, Any]]:
        """Every result of a paginated list, following `next`."""
        next_path: str | None = path
        while next_path:
            page = self.request("GET", next_path)
            yield from page.get("results") or []
            next_path = page.get("next")


# --- apply and validate -------------------------------------------------------------------


def apply(
    api: PostHogAPI,
    dashboards: Sequence[Dashboard] = DASHBOARDS,
    log: Callable[[str], None] = print,
) -> None:
    """Create or update every dashboard and insight by name (module docstring)."""
    found: dict[str, int] = {}
    for item in api.pages("dashboards/?limit=100"):
        if item.get("deleted") or item.get("name") not in {d.name for d in dashboards}:
            continue
        name = item["name"]
        if name in found:
            log(f"warning: two dashboards named {name!r}; updating id {found[name]} only")
            continue
        found[name] = item["id"]

    for dashboard in dashboards:
        if dashboard.name in found:
            dashboard_id = found[dashboard.name]
            api.request("PATCH", f"dashboards/{dashboard_id}/", dashboard_payload(dashboard))
            log(f"dashboard {dashboard.name!r}: updated (id {dashboard_id})")
        else:
            created = api.request("POST", "dashboards/", dashboard_payload(dashboard))
            dashboard_id = created["id"]
            log(f"dashboard {dashboard.name!r}: created (id {dashboard_id})")

        detail = api.request("GET", f"dashboards/{dashboard_id}/")
        on_board: dict[str, dict[str, Any]] = {}
        for tile in detail.get("tiles") or []:
            insight = tile.get("insight")
            if isinstance(insight, dict) and not insight.get("deleted"):
                on_board.setdefault(insight.get("name") or "", insight)

        for insight in dashboard.insights:
            existing = on_board.get(insight.name)
            if existing is not None:
                api.request("PATCH", f"insights/{existing['id']}/", insight_payload(insight))
                log(f"  insight {insight.name!r}: updated (id {existing['id']})")
            else:
                created = api.request("POST", "insights/", insight_payload(insight, dashboard_id))
                log(f"  insight {insight.name!r}: created (id {created['id']})")

        wanted = {insight.name for insight in dashboard.insights}
        for name, insight in on_board.items():
            if name not in wanted and MANAGED_TAG in (insight.get("tags") or []):
                log(
                    f"  warning: insight {name!r} (id {insight['id']}) is no longer in the code; "
                    "remove it in PostHog if it is not wanted"
                )


def validate(
    api: PostHogAPI,
    dashboards: Sequence[Dashboard] = DASHBOARDS,
    log: Callable[[str], None] = print,
) -> bool:
    """Run every insight's query once through the query API (read-only);
    print the row count or PostHog's error. True when all ran."""
    ok = True
    for dashboard in dashboards:
        log(dashboard.name)
        for insight in dashboard.insights:
            body = {
                "query": query_of(insight),
                "name": f"dashboards.py validate: {insight.name}"[:128],
                "refresh": "blocking",
            }
            try:
                answer = api.request("POST", "query/", body)
            except APIError as error:
                ok = False
                log(f"  FAIL {insight.name}: {error}")
                continue
            rows = answer.get("results") if isinstance(answer, dict) else None
            log(f"  ok   {insight.name}: {len(rows) if isinstance(rows, list) else '?'} rows")
    return ok


# --- entry point --------------------------------------------------------------------------


def main(
    argv: Sequence[str] | None = None,
    environ: Mapping[str, str] | None = None,
    opener: Opener = urllib.request.urlopen,
) -> int:
    parser = argparse.ArgumentParser(description="camsocs's PostHog dashboards as code (ENG-10).")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true", help="print the JSON it would send")
    mode.add_argument("--validate", action="store_true", help="run every query once, read-only")
    mode.add_argument("--apply", action="store_true", help="create or update the dashboards")
    args = parser.parse_args(argv)
    environ = os.environ if environ is None else environ

    if args.dry_run:
        print(json.dumps(plan(), indent=1, ensure_ascii=False))
        return 0

    key = environ.get("POSTHOG_PERSONAL_API_KEY", "").strip()
    project_id = environ.get("POSTHOG_PROJECT_ID", "").strip()
    if not key or not project_id:
        print("error: set POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID", file=sys.stderr)
        return 2
    host = environ.get("POSTHOG_APP_HOST", "").strip() or DEFAULT_APP_HOST
    try:
        api = PostHogAPI(host, project_id, key, opener)
        if args.validate:
            return 0 if validate(api) else 1
        apply(api)
    except APIError as error:
        print(f"error: {str(error).replace(key, '***')}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
