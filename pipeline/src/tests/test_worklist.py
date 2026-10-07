"""The mailing-list worklist (`camsocs worklist`, PLAN.md J4) and the public
Sympa list search (source-research §20) — offline (respx)."""

from __future__ import annotations

import csv
import json

import httpx
import pytest
from click.testing import CliRunner

import camsocs_pipeline.pipeline.load as load
from camsocs_pipeline.cli import cli
from camsocs_pipeline.models.wire import MailingListInfo, WorklistOrg
from camsocs_pipeline.pipeline.state import SyncState, save_state
from camsocs_pipeline.sources.sympa import (
    SympaList,
    best_list,
    parse_search,
    subscribe_instruction,
)
from camsocs_pipeline.worklist import SympaMatcher, compact, rank_organisations

SITE = "https://happy-otter-123.convex.site"

# Modelled on the real result markup (2026-10-07): the address is written by a
# script (obfuscated), the name is in the info link, the description below it.
SEARCH_PAGE = """
<p>5 occurrence(s) found</p>
<ul class="listenum">
  <li class="listenum">
    <a href="/sympa/info/caius-engsoc-2024"><script>document.write("c" + "@")</script></a>
    <p class="listenum">graduation year of 2024</p>
  </li>
  <li class="listenum">
    <a href="/sympa/info/soc-cuqas"><script>document.write("soc-cuqas" + "@" + "lists")</script></a>
    <p class="listenum">Cambridge University Quokka Appreciation Society members</p>
  </li>
  <li class="listenum">
    <a href="/sympa/info/soc-cuqas-committee"><script>document.write("x")</script></a>
    <p class="listenum">CUQAS committee</p>
  </li>
  <li class="listenum">
    <a href="/sympa/info/soc-orrery-announce"><script>document.write("x")</script></a>
    <p class="listenum">Announcements &amp; news</p>
  </li>
  <li class="listenum">
    <a href="/sympa/info/soc-orrery-2017"><script>document.write("x")</script></a>
    <p class="listenum">Old</p>
  </li>
</ul>
"""


@pytest.fixture(autouse=True)
def _no_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(load.time, "sleep", lambda _seconds: None)


def test_parse_search_keeps_names_and_descriptions_only() -> None:
    lists = parse_search(SEARCH_PAGE)
    assert [listed.name for listed in lists] == [
        "soc-cuqas",
        "soc-cuqas-committee",
        "soc-orrery-2017",
        "soc-orrery-announce",
    ]
    assert lists[0].description == "Cambridge University Quokka Appreciation Society members"
    assert all("@" not in listed.description for listed in lists)
    assert lists[0].society == "cuqas" and lists[3].group == "announce"
    assert not lists[1].public and not lists[2].public and lists[3].public


def test_best_list_prefers_announcements_and_never_committees() -> None:
    lists = [
        SympaList("soc-x-committee", ""),
        SympaList("soc-x-members", ""),
        SympaList("soc-x-announce", ""),
    ]
    assert best_list(lists).name == "soc-x-announce"
    assert best_list([SympaList("soc-x-exec", "")]) is None
    assert subscribe_instruction("soc-x") == "send 'subscribe soc-x' to sympa@lists.cam.ac.uk"


def org(key: str, name: str, **overrides) -> WorklistOrg:
    values = {"key": key, "slug": key[4:], "name": name, "status": "active", "level": "university"}
    values.update(overrides)
    return WorklistOrg(**values)


ORGS = [
    org("org-quokka", "Cambridge University Quokka Appreciation Society", short_name="CUQAS"),
    org("org-orrery", "Cambridge University Orrery Club", sympa_list="soc-orrery-announce"),
    org(
        "org-form",
        "Form Society",
        mailing_list=MailingListInfo(
            platform="mailchimp", signup_url="https://form.example.org/join"
        ),
        feeds=["ics"],
    ),
    org("org-dormant", "Dormant Society", status="dormant", sympa_list="soc-dormant"),
    org("org-nolist", "No List Society"),
    org("org-busy", "Busy Society", sympa_list="soc-busy", upcoming_event_sources=["camdram"]),
    org(
        "org-mail",
        "Mail Only Society",
        sympa_list="soc-mailonly",
        upcoming_event_sources=["mailing_list"],
    ),
]


def test_matching_public_lists_to_organisations() -> None:
    matcher = SympaMatcher(parse_search(SEARCH_PAGE))
    assigned = matcher.assign(ORGS)
    # By short name and by description; committee lists are never chosen.
    assert assigned["org-quokka"].name == "soc-cuqas"
    assert "org-nolist" not in assigned
    assert matcher.matched["soc-cuqas"] == "org-quokka"
    assert compact("CU-QAS!") == "cuqas"


def test_ranking() -> None:
    matcher = SympaMatcher(parse_search(SEARCH_PAGE))
    rows = rank_organisations(ORGS, public_lists=matcher.assign(ORGS))
    keys = [row.org_key for row in rows]
    assert "org-dormant" not in keys and "org-nolist" not in keys
    # Lists on record outrank names matched by description (ties by name);
    # organisations with another feed rank last.
    assert keys[:2] == ["org-orrery", "org-mail"]
    assert keys[-2:] == ["org-busy", "org-form"] or keys[-2:] == ["org-form", "org-busy"]
    by_key = {row.org_key: row for row in rows}
    assert by_key["org-quokka"].sign_up == "send 'subscribe soc-cuqas' to sympa@lists.cam.ac.uk"
    assert "matched by name" in by_key["org-quokka"].why
    assert by_key["org-form"].sign_up == "https://form.example.org/join"
    assert "already has: ics" in by_key["org-form"].why
    # Mail already arriving through the inbox is not another feed…
    assert "no other event feed" in by_key["org-mail"].why
    # …but an organisation already sending mail is not on the list at all.
    again = rank_organisations(ORGS, receiving_orgs=["org-mail"], receiving_lists=["soc-busy"])
    assert {"org-mail", "org-busy"}.isdisjoint(row.org_key for row in again)
    assert [row.rank for row in rows] == list(range(1, len(rows) + 1))


def worklist_page(page, *, done: bool, cursor: str) -> dict:
    return {
        "page": [o.model_dump(by_alias=True, exclude_none=True) for o in page],
        "isDone": done,
        "continueCursor": cursor,
    }


def test_the_worklist_command_writes_both_reports(make_settings, net) -> None:
    settings = make_settings(convex_http_url=SITE, pipeline_api_key="test-key", min_host_interval=0)
    state = SyncState()
    state.data("inbox")["org_last_mail"] = {"org-busy": "2026-10-07T09:00:00+00:00"}
    save_state(settings.state_path, state)

    route = net.post(f"{SITE}/api/pipeline/worklist").mock(
        side_effect=[
            httpx.Response(200, json=worklist_page(ORGS[:3], done=False, cursor="c1")),
            httpx.Response(200, json=worklist_page(ORGS[3:], done=True, cursor="c2")),
        ]
    )
    net.get("https://lists.cam.ac.uk/robots.txt").mock(return_value=httpx.Response(404))
    search = net.get("https://lists.cam.ac.uk/sympa/search_list/soc-").mock(
        return_value=httpx.Response(200, text=SEARCH_PAGE, headers={"content-type": "text/html"})
    )
    info = net.get(url__startswith="https://lists.cam.ac.uk/sympa/info/")

    result = CliRunner().invoke(cli, ["worklist"], obj={"settings": settings})
    assert result.exit_code == 0, result.output

    first, second = (json.loads(call.request.content) for call in route.calls)
    # "from the start" is an explicit null cursor, then the server's cursor.
    assert first == {"paginationOpts": {"numItems": 100, "cursor": None}}
    assert second["paginationOpts"]["cursor"] == "c1"
    assert search.call_count == 1 and info.call_count == 0

    with (settings.reports_dir / "mailing-list-worklist.csv").open(encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    assert [row["org_key"] for row in rows][:2] == ["org-orrery", "org-mail"]
    assert "org-busy" not in {row["org_key"] for row in rows}
    assert set(rows[0]) == {"rank", "organisation", "org_key", "status", "sign_up", "why", "score"}
    with (settings.reports_dir / "sympa-soc-lists.csv").open(encoding="utf-8") as handle:
        lists = {row["list"]: row for row in csv.DictReader(handle)}
    assert lists["soc-cuqas"]["matched_org_key"] == "org-quokka"
    assert lists["soc-cuqas-committee"]["public"] == "no"


def test_the_worklist_still_runs_when_sympa_is_unreachable(make_settings, net) -> None:
    settings = make_settings(convex_http_url=SITE, pipeline_api_key="test-key", min_host_interval=0)
    net.post(f"{SITE}/api/pipeline/worklist").mock(
        return_value=httpx.Response(200, json=worklist_page(ORGS, done=True, cursor="c"))
    )
    result = CliRunner().invoke(cli, ["worklist", "--no-sympa"], obj={"settings": settings})
    assert result.exit_code == 0, result.output
    assert (settings.reports_dir / "mailing-list-worklist.csv").exists()
    assert not (settings.reports_dir / "sympa-soc-lists.csv").exists()
