#!/usr/bin/env python3
"""camsocs's PostHog dashboards as code (ENG-10; docs/deploy.md "PostHog").

    pixi run posthog-dashboards -- --dry-run    # print the JSON it would send; no key needed
    pixi run posthog-dashboards -- --validate   # run every insight's query once (read-only)
    pixi run posthog-dashboards -- --apply      # create or update the dashboards in PostHog

Four dashboards — Traffic, Content, Search, Reliability — each a list of
insights in PostHog's query format (research-api §1–2): trends as
``InsightVizNode`` → ``TrendsQuery``, tables and custom buckets as
``DataVisualizationNode`` → ``HogQLQuery``. Every insight excludes internal and
test traffic: ``filterTestAccounts: true`` on a trends query (the schema's
default is false), and ``{filters}`` with ``filterTestAccounts`` in HogQL.
The project's filter drops ``environment = development`` (local runs and
the dev deployment), Joshua's cohort and the in-app Claude browser.

**Idempotent, by name.** ``--apply`` finds each dashboard by its exact name
(creating it when missing), then each insight by its name among the
dashboard's tiles: an existing one is updated in place (name, description,
query, tags), a missing one is created on the dashboard. Nothing is deleted:
an insight tagged ``managed-by-code`` that the code no longer defines is
reported, for a person to remove in PostHog. Tiles are placed by PostHog.

**Privacy.** Insights break down by IDs, keys and enums only (``orgKey``,
``eventKey``, ``talkKey``, ``feed``, ``kind``, ``surface``, a stage, a model
id): camsocs resolves names, PostHog never receives them (docs/analytics.md).
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
) -> dict[str, Any]:
    """An `InsightVizNode` around a `TrendsQuery`, test accounts excluded."""
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
            "harvest_run_finished per day by status (success, partial, failed), production "
            "VPS runs. The monitor alerts after 26 h without a success or partial run.",
            trends(events("harvest_run_finished"), breakdown="status", display="ActionsStackedBar"),
        ),
        Insight(
            "Harvest stage duration per day (average, by stage)",
            "Average harvest_stage_completed durationS per day and stage, last 30 days.",
            trends(
                events("harvest_stage_completed", math="avg", math_property="durationS"),
                breakdown="stage",
                axis_format="duration",
            ),
        ),
        Insight(
            "Harvest stages (30 days)",
            "Per stage: runs, failures, runs skipped, and durations (seconds) from "
            "harvest_stage_completed, last 30 days.",
            sql(
                "SELECT properties.stage AS stage, count() AS runs,"
                " countIf(properties.status = 'failed') AS failed,"
                " countIf(properties.status = 'not_run') AS not_run,"
                " round(avg(toFloat(properties.durationS)), 1) AS avg_s,"
                " round(quantile(0.9)(toFloat(properties.durationS)), 1) AS p90_s,"
                " round(max(toFloat(properties.durationS)), 1) AS max_s"
                " FROM events WHERE event = 'harvest_stage_completed' AND {filters}"
                " GROUP BY stage ORDER BY avg_s DESC LIMIT 100"
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

DASHBOARDS: tuple[Dashboard, ...] = (TRAFFIC, CONTENT, SEARCH, RELIABILITY)


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
