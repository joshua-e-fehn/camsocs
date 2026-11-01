"""PostHog dashboards as code (ENG-10, `ops/posthog/dashboards.py`): the
payloads it builds, and that `--apply` creates or updates by name against a
fake PostHog (an in-memory opener here, never the network).
"""

from __future__ import annotations

import importlib.util
import io
import json
import re
import sys
import urllib.error
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

REPO = Path(__file__).resolve().parents[3]
SCRIPT = REPO / "ops" / "posthog" / "dashboards.py"
#: Not a real key; assembled so no key-shaped literal sits in the repo.
KEY = "phx" + "_" + "dashboards-test-key-not-real"
HOST = "https://eu.posthog.test"
ENVIRON = {"POSTHOG_PERSONAL_API_KEY": KEY, "POSTHOG_PROJECT_ID": "4242", "POSTHOG_APP_HOST": HOST}
BASE = f"{HOST}/api/projects/4242/"


def load() -> ModuleType:
    spec = importlib.util.spec_from_file_location("posthog_dashboards", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module  # dataclasses look their module up
    spec.loader.exec_module(module)
    return module


dashboards = load()
ALL = [(d, i) for d in dashboards.DASHBOARDS for i in d.insights]


def ids(pairs) -> list[str]:
    return [f"{d.name}/{i.name}" for d, i in pairs]


# --- the payloads -------------------------------------------------------------------------


def test_there_are_four_dashboards() -> None:
    assert [d.name for d in dashboards.DASHBOARDS] == [
        "camsocs: Traffic",
        "camsocs: Content",
        "camsocs: Search",
        "camsocs: Reliability",
    ]
    assert "accepted analytics" in dashboards.TRAFFIC.description


@pytest.mark.parametrize("dashboard, insight", ALL, ids=ids(ALL))
def test_every_insight_excludes_test_accounts(dashboard, insight) -> None:
    source = insight.query["source"]
    if insight.query["kind"] == "InsightVizNode":
        assert source["kind"] == "TrendsQuery"
        assert source["filterTestAccounts"] is True, "the schema's default is false"
    else:
        assert insight.query["kind"] == "DataVisualizationNode"
        assert source["kind"] == "HogQLQuery"
        assert "{filters}" in source["query"]
        assert source["filters"]["filterTestAccounts"] is True


@pytest.mark.parametrize("dashboard, insight", ALL, ids=ids(ALL))
def test_names_and_descriptions_fit_posthogs_limits(dashboard, insight) -> None:
    assert 0 < len(insight.name) <= dashboards.MAX_TEXT
    assert 0 < len(insight.description) <= dashboards.MAX_TEXT
    assert len(dashboard.description) <= dashboards.MAX_TEXT


def test_insight_names_are_unique_on_each_dashboard() -> None:
    for dashboard in dashboards.DASHBOARDS:
        names = [insight.name for insight in dashboard.insights]
        assert len(names) == len(set(names)), dashboard.name


def events_used() -> set[str]:
    found: set[str] = set()
    for _dashboard, insight in ALL:
        source = insight.query["source"]
        if source["kind"] == "TrendsQuery":
            found.update(series["event"] for series in source["series"])
        else:
            found.update(re.findall(r"event = '([^']+)'", source["query"]))
    return found


def test_the_dashboards_cover_the_taxonomy_and_the_server_events() -> None:
    assert events_used() == {
        "$pageview",
        "society_viewed",
        "event_viewed",
        "talk_viewed",
        "calendar_subscribe_clicked",
        "ics_feed_fetched",
        "outbound_link_clicked",
        "search_performed",
        "search_zero_results",
        "$exception",
        "harvest_run_finished",
        "harvest_stage_completed",
        "$ai_generation",
        "listing_request_received",
    }


#: What an insight may break down or read: IDs, keys, enums, counts.
ALLOWED_PROPERTIES = {
    "$pathname",
    "$session_entry_referring_domain",
    "$device_type",
    "orgKey",
    "eventKey",
    "talkKey",
    "feed",
    "kind",
    "surface",
    "queryLength",
    "status",
    "stage",
    "durationS",
    "$ai_model",
    "$ai_input_tokens",
    "$ai_output_tokens",
    "$ai_latency",
    "$ai_is_error",
    "$lib",
}


def properties_read(insight) -> set[str]:
    source = insight.query["source"]
    if source["kind"] == "TrendsQuery":
        read = {s["math_property"] for s in source["series"] if "math_property" in s}
        breakdown = source.get("breakdownFilter", {})
        if breakdown.get("breakdown_type") == "hogql":
            read |= set(re.findall(r"properties\.(\$?\w+)", breakdown["breakdown"]))
        elif breakdown:
            read.add(breakdown["breakdown"])
        return read
    return set(re.findall(r"properties\.(\$?\w+)", source["query"]))


@pytest.mark.parametrize("dashboard, insight", ALL, ids=ids(ALL))
def test_insights_read_ids_enums_and_counts_only(dashboard, insight) -> None:
    assert properties_read(insight) <= ALLOWED_PROPERTIES
    text = json.dumps(insight.query)
    for forbidden in ("$current_url", "$title", "title", "$ai_input", "$ai_output_choices"):
        assert not re.search(rf"(\"|properties\.){re.escape(forbidden)}(\"|\b(?!_))", text)


def test_content_insights_break_down_by_keys() -> None:
    breakdowns = {
        insight.name: insight.query["source"]["breakdownFilter"]["breakdown"]
        for insight in dashboards.CONTENT.insights
    }
    assert breakdowns["Top societies viewed (orgKey)"] == "orgKey"
    assert breakdowns["Top events viewed (eventKey)"] == "eventKey"
    assert breakdowns["Top talks viewed (talkKey)"] == "talkKey"


def test_exceptions_split_browser_from_server() -> None:
    [exceptions] = [i for i in dashboards.RELIABILITY.insights if i.name.startswith("Exceptions")]
    breakdown = exceptions.query["source"]["breakdownFilter"]
    assert breakdown["breakdown_type"] == "hogql"
    assert "distinct_id = 'camsocs-server'" in breakdown["breakdown"]


def test_an_sql_insight_without_the_filters_placeholder_is_refused() -> None:
    with pytest.raises(ValueError, match="filters"):
        dashboards.sql("SELECT count() FROM events")


def test_an_update_never_sends_dashboard_membership() -> None:
    insight = dashboards.TRAFFIC.insights[0]
    assert "dashboards" not in dashboards.insight_payload(insight)
    assert dashboards.insight_payload(insight, 7)["dashboards"] == [7]
    assert dashboards.insight_payload(insight)["tags"] == [dashboards.MANAGED_TAG]


# --- a fake PostHog -------------------------------------------------------------------------


class FakePostHog:
    """An opener for urllib that keeps dashboards and insights in memory and
    records every request (method, path, body, headers)."""

    def __init__(self) -> None:
        self.dashboards: dict[int, dict[str, Any]] = {}
        self.insights: dict[int, dict[str, Any]] = {}
        self.requests: list[tuple[str, str, Any]] = []
        self.headers: list[dict[str, str]] = []
        self.next_id = 100
        self.fail_queries: set[str] = set()

    def _id(self) -> int:
        self.next_id += 1
        return self.next_id

    def __call__(self, request, timeout: float):
        assert request.full_url.startswith(BASE), request.full_url
        path = request.full_url.removeprefix(BASE)
        body = json.loads(request.data) if request.data else None
        method = request.get_method()
        self.requests.append((method, path, body))
        self.headers.append(dict(request.header_items()))
        answer = self.answer(method, path, body)
        return io.BytesIO(json.dumps(answer).encode())

    def answer(self, method: str, path: str, body: Any) -> Any:
        if (method, path) == ("GET", "dashboards/?limit=100"):
            return {"results": list(self.dashboards.values()), "next": None}
        if (method, path) == ("POST", "dashboards/"):
            item = {"id": self._id(), "deleted": False, **body}
            self.dashboards[item["id"]] = item
            return item
        if match := re.fullmatch(r"dashboards/(\d+)/", path):
            dashboard = self.dashboards[int(match[1])]
            if method == "PATCH":
                dashboard.update(body)
                return dashboard
            tiles = [
                {"insight": insight}
                for insight in self.insights.values()
                if dashboard["id"] in insight["dashboards"]
            ]
            return {**dashboard, "tiles": tiles}
        if (method, path) == ("POST", "insights/"):
            item = {"id": self._id(), "deleted": False, **body}
            self.insights[item["id"]] = item
            return item
        if match := re.fullmatch(r"insights/(\d+)/", path):
            self.insights[int(match[1])].update(body)
            return self.insights[int(match[1])]
        if (method, path) == ("POST", "query/"):
            if body["name"].removeprefix("dashboards.py validate: ") in self.fail_queries:
                raise urllib.error.HTTPError(
                    BASE + path, 400, "Bad Request", {}, io.BytesIO(b'{"detail":"bad query"}')
                )
            return {"results": [[1], [2]]}
        raise AssertionError(f"unexpected {method} {path}")


def run(posthog: FakePostHog, *args: str, environ: dict | None = None) -> int:
    return dashboards.main(list(args), ENVIRON if environ is None else environ, posthog)


def test_apply_creates_every_dashboard_and_insight_once(capsys) -> None:
    posthog = FakePostHog()
    assert run(posthog, "--apply") == 0

    assert sorted(d["name"] for d in posthog.dashboards.values()) == sorted(
        d.name for d in dashboards.DASHBOARDS
    )
    assert len(posthog.insights) == len(ALL)
    for item in posthog.insights.values():
        [dashboard_id] = item["dashboards"]
        dashboard = posthog.dashboards[dashboard_id]
        wanted = next(d for d in dashboards.DASHBOARDS if d.name == dashboard["name"])
        assert item["name"] in {i.name for i in wanted.insights}
        assert item["tags"] == [dashboards.MANAGED_TAG]
    assert all(h["Authorization"] == f"Bearer {KEY}" for h in posthog.headers)
    assert KEY not in capsys.readouterr().out


def test_apply_again_updates_in_place_and_creates_nothing() -> None:
    posthog = FakePostHog()
    run(posthog, "--apply")
    before = (len(posthog.dashboards), len(posthog.insights))
    posthog.requests.clear()
    posthog.insights[min(posthog.insights)]["query"] = {"kind": "stale"}

    assert run(posthog, "--apply") == 0

    assert (len(posthog.dashboards), len(posthog.insights)) == before
    assert not [r for r in posthog.requests if r[0] == "POST"]
    patches = [body for method, path, body in posthog.requests if path.startswith("insights/")]
    assert len(patches) == len(ALL)
    assert all("dashboards" not in body for body in patches), "membership is left alone"
    assert posthog.insights[min(posthog.insights)]["query"] != {"kind": "stale"}


def test_an_insight_no_longer_in_the_code_is_reported_not_deleted(capsys) -> None:
    posthog = FakePostHog()
    run(posthog, "--apply")
    traffic = next(d for d in posthog.dashboards.values() if d["name"] == "camsocs: Traffic")
    posthog.insights[999] = {
        "id": 999,
        "name": "Old tile",
        "tags": [dashboards.MANAGED_TAG],
        "dashboards": [traffic["id"]],
        "deleted": False,
    }
    capsys.readouterr()

    run(posthog, "--apply")

    assert "insight 'Old tile' (id 999) is no longer in the code" in capsys.readouterr().out
    assert 999 in posthog.insights and not posthog.insights[999]["deleted"]
    assert not [r for r in posthog.requests if r[0] == "DELETE"]


def test_another_dashboard_with_a_different_name_is_left_alone() -> None:
    posthog = FakePostHog()
    posthog.dashboards[1] = {"id": 1, "name": "Your starter dashboard", "deleted": False}
    run(posthog, "--apply")
    assert posthog.dashboards[1] == {"id": 1, "name": "Your starter dashboard", "deleted": False}
    assert not [r for r in posthog.requests if r[1] == "dashboards/1/"]


def test_a_dry_run_prints_the_payloads_without_a_key_or_a_request(capsys) -> None:
    posthog = FakePostHog()
    assert run(posthog, "--dry-run", environ={}) == 0
    printed = json.loads(capsys.readouterr().out)
    assert [entry["dashboard"]["name"] for entry in printed] == [
        d.name for d in dashboards.DASHBOARDS
    ]
    assert sum(len(entry["insights"]) for entry in printed) == len(ALL)
    assert posthog.requests == []


def test_validate_runs_every_query_once_and_fails_on_an_error(capsys) -> None:
    posthog = FakePostHog()
    assert run(posthog, "--validate") == 0
    queries = [body for method, path, body in posthog.requests if path == "query/"]
    assert len(queries) == len(posthog.requests) == len(ALL), "read-only: queries only"
    assert all(body["query"]["kind"] in {"TrendsQuery", "HogQLQuery"} for body in queries)

    posthog.fail_queries.add("Top pages")
    assert run(posthog, "--validate") == 1
    assert "FAIL Top pages: POST query/: HTTP 400" in capsys.readouterr().out


def test_without_credentials_apply_refuses(capsys) -> None:
    posthog = FakePostHog()
    assert run(posthog, "--apply", environ={"POSTHOG_PROJECT_ID": "4242"}) == 2
    assert "POSTHOG_PERSONAL_API_KEY" in capsys.readouterr().err
    assert posthog.requests == []


def test_a_project_id_that_is_not_a_number_is_refused(capsys) -> None:
    environ = {**ENVIRON, "POSTHOG_PROJECT_ID": "@current"}
    assert run(FakePostHog(), "--apply", environ=environ) == 1
    assert "numeric" in capsys.readouterr().err
