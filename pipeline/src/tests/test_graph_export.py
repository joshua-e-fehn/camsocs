"""The pipeline graph export (spec §5A, lane L5): `camsocs_pipeline.graph`.

The committed `webapp/lib/generated/pipeline-graph.cam.json` and
`docs/pipeline-map.md` must equal what the registry generates now; when a
stage, a group or `campuses/cam_sources.json` changes, run
``pixi run pipeline-graph`` and commit both files. Every failure path is
exercised with fabricated stages (synthetic only; no source content is read).
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from click.testing import CliRunner

from camsocs_pipeline.campuses import CAMBRIDGE
from camsocs_pipeline.cli import cli
from camsocs_pipeline.config import REPO_ROOT
from camsocs_pipeline.graph import (
    JSON_PATH,
    MERMAID_PATH,
    SCHEMA,
    GraphError,
    build_graph,
    describe_calendar,
    group_schedule,
    heading_anchor,
    load_sources,
    render_mermaid,
    to_json,
)
from camsocs_pipeline.pipeline.context import PHASES, PILLARS, Stage, StageGroup
from camsocs_pipeline.stages import GROUPS, STAGES
from tests import campus_zz

STALE = "stale: run `pixi run pipeline-graph` and commit the result"


@pytest.fixture(scope="module")
def graph() -> dict:
    return build_graph(CAMBRIDGE)


def _nodes(graph: dict, kind: str) -> list[dict]:
    return [node for node in graph["nodes"] if node["kind"] == kind]


# --- the committed files ------------------------------------------------------------


def test_committed_json_is_what_the_registry_generates(graph: dict) -> None:
    committed = (REPO_ROOT / JSON_PATH).read_text(encoding="utf-8")
    assert committed == to_json(graph), STALE


def test_committed_pipeline_map_is_what_the_registry_generates(graph: dict) -> None:
    committed = (REPO_ROOT / MERMAID_PATH).read_text(encoding="utf-8")
    assert committed == render_mermaid(graph), STALE


def test_generation_is_deterministic() -> None:
    assert to_json(build_graph(CAMBRIDGE)) == to_json(build_graph(CAMBRIDGE))


def test_json_text_round_trips(graph: dict) -> None:
    text = to_json(graph)
    assert json.loads(text) == graph
    assert text.endswith("}\n")


# --- shape --------------------------------------------------------------------------


def test_top_level_shape(graph: dict) -> None:
    assert graph["schema"] == SCHEMA == "camsocs.pipeline-graph/1"
    assert graph["campus"] == {
        "id": "cam",
        "name": "Cambridge",
        "site": "https://camsocs.uk",
        "docs": "docs/source-research.md",
    }
    assert graph["pillars"] == list(PILLARS) == ["societies", "events", "talks", "shared"]
    assert [phase["key"] for phase in graph["phases"]] == list(PHASES)
    assert [phase["order"] for phase in graph["phases"]] == list(range(len(PHASES)))
    assert list(graph) == [
        "schema",
        "campus",
        "pillars",
        "phases",
        "lanes",
        "groups",
        "nodes",
        "edges",
        "sources",
    ]


def test_every_stage_node_has_a_pillar_phase_and_lane(graph: dict) -> None:
    lanes = {lane["id"]: lane for lane in graph["lanes"]}
    stages = _nodes(graph, "stage")
    assert [node["name"] for node in stages] == [stage.name for stage in STAGES]
    for node, stage in zip(stages, STAGES, strict=True):
        assert node["id"] == f"stage:cam:{stage.name}"
        assert node["pillar"] in PILLARS and node["pillar"] == stage.pillar
        assert node["phase"] in PHASES and node["phase"] == stage.phase
        assert node["lane"] in lanes
        lane = lanes[node["lane"]]
        assert (lane["campus"], lane["pillar"]) == (stage.campus, stage.pillar)
        assert node["campus"] == stage.campus
        assert node["fetchesInDryRun"] == stage.fetches
        assert (node["network"], node["llm"]) == (stage.network, stage.llm)
    assert [node["order"] for node in stages] == list(range(len(STAGES)))


def test_lanes_are_campus_by_pillar_and_never_merge_pillars(graph: dict) -> None:
    assert [lane["id"] for lane in graph["lanes"]] == [
        "cam/societies",
        "cam/events",
        "cam/talks",
        "engine/societies",
        "engine/events",
        "engine/shared",
    ]
    for lane in graph["lanes"]:
        owner, pillar = lane["id"].split("/")
        assert lane["pillar"] == pillar
        assert lane["campus"] == (None if owner == "engine" else owner)


def test_talks_cam_feeds_events_and_talks_is_its_own_pillar(graph: dict) -> None:
    by_name = {node["name"]: node for node in _nodes(graph, "stage")}
    assert by_name["talks_cam"]["label"] == "talks.cam lists (G1)"
    assert by_name["talks_cam"]["pillar"] == "events"
    assert by_name["talks"]["pillar"] == "talks"
    assert by_name["talks"]["lane"] == "cam/talks"
    assert sum(1 for node in by_name.values() if node["label"]) == 1


def test_node_ids_are_unique_and_campus_scoped(graph: dict) -> None:
    ids = [node["id"] for node in graph["nodes"]]
    assert len(ids) == len(set(ids))
    for node_id in ids:
        assert re.fullmatch(r"(stage|group|dir|sel|sink):cam:[A-Za-z0-9_./]+", node_id), node_id
    assert {node["kind"] for node in graph["nodes"]} == {
        "stage",
        "group",
        "staging",
        "selector",
        "sink",
    }


def test_edges_join_existing_nodes(graph: dict) -> None:
    kinds = {node["id"]: node["kind"] for node in graph["nodes"]}
    allowed = {
        "writes": ("stage", {"staging", "selector"}),
        "reads": ({"staging", "selector"}, "stage"),
        "requires": ("stage", "stage"),
        "needs": ({"staging"}, "group"),
        "posts": ("stage", "sink"),
    }
    for edge in graph["edges"]:
        assert set(edge) == {"from", "to", "kind"}
        source, target = allowed[edge["kind"]]
        assert kinds[edge["from"]] in ({source} if isinstance(source, str) else source), edge
        assert kinds[edge["to"]] in ({target} if isinstance(target, str) else target), edge
    assert {
        "from": "stage:cam:resolve",
        "to": "stage:cam:load",
        "kind": "requires",
    } in graph["edges"]
    assert {
        "from": "stage:cam:su_directory",
        "to": "dir:cam:su_profile",
        "kind": "writes",
    } in graph["edges"]
    assert {"from": "sel:cam:org_lookup", "to": "stage:cam:playwaze", "kind": "reads"} in graph[
        "edges"
    ]
    assert {"from": "stage:cam:load", "to": "sink:cam:claims", "kind": "posts"} in graph["edges"]
    assert {"from": "dir:cam:_resolved", "to": "group:cam:events", "kind": "needs"} in graph[
        "edges"
    ]


def test_every_sink_is_a_pipeline_route_convex_serves(graph: dict) -> None:
    http = (REPO_ROOT / "webapp" / "convex" / "http.ts").read_text(encoding="utf-8")
    routes = set(re.findall(r'(?:ingestionRoute|readRoute)\("([^"]+)"', http))
    routes |= {p.removeprefix("/api/pipeline/") for p in re.findall(r'path: "([^"]+)"', http)}
    for node in _nodes(graph, "sink"):
        assert node["route"] == f"/api/pipeline/{node['name']}"
        name = node["name"]
        assert any(route == name or route.startswith(f"{name}/") for route in routes), name


def test_groups_mirror_the_registry_and_the_vps_timers(graph: dict) -> None:
    rows = {row["key"]: row for row in graph["groups"]}
    assert list(rows) == list(GROUPS) == ["events", "full", "talks"]
    assert rows["events"]["needs"] == ["_resolved", "society_website", "su_profile"]
    assert rows["events"]["staleAfterDays"] == 8
    assert rows["events"]["schedule"] == "daily 04:30 Europe/London"
    assert rows["full"]["schedule"] == "weekly Sun 02:00 Europe/London"
    assert rows["full"]["stages"] == [stage.name for stage in STAGES]
    assert rows["full"]["derive"] is True
    assert rows["talks"] == {
        "key": "talks",
        "description": GROUPS["talks"].description,
        "stages": ["talks"],
        "needs": [],
        "staleAfterDays": None,
        "derive": False,
        "schedule": None,
    }
    by_name = {node["name"]: node for node in _nodes(graph, "stage")}
    assert by_name["talks"]["groups"] == ["events", "full", "talks"]
    assert by_name["su_directory"]["groups"] == ["full"]


def test_docs_refs_point_at_real_headings(graph: dict) -> None:
    by_name = {node["name"]: node for node in _nodes(graph, "stage")}
    assert by_name["su_directory"]["docs"] == [
        {
            "doc": "docs/source-research.md",
            "section": "1",
            "anchor": "1-cambridge-su-find-a-society",
        }
    ]
    assert by_name["talks"]["docs"] == [
        {"doc": "docs/talks-redesign-spec.md", "section": None, "anchor": None}
    ]
    assert by_name["load"]["docs"] == []


def test_sources_come_from_the_manifest_and_cover_every_harvesting_stage(graph: dict) -> None:
    manifest = load_sources("cam")
    assert [row["key"] for row in graph["sources"]] == [entry["key"] for entry in manifest]
    pillars = {stage.name: stage.pillar for stage in STAGES}
    for row in graph["sources"]:
        assert row["pillar"] == pillars[row["stage"]]
        assert row["permission"] in ("robots", "D3", "D3a", None)
    covered = {row["stage"] for row in graph["sources"]}
    harvesting = {s.name for s in STAGES if s.phase in {"harvest", "events", "inbox", "talks"}}
    assert harvesting <= covered
    by_key = {row["key"]: row for row in graph["sources"]}
    assert by_key["uni_events"]["permission"] == "D3a"
    assert by_key["talks_cam"]["permission"] == "robots"
    assert by_key["talks_cam"]["label"] == "talks.cam lists (G1)"
    assert by_key["su_directory"]["section"] == "1"


def test_pipeline_map_has_one_subgraph_per_lane(graph: dict) -> None:
    text = render_mermaid(graph)
    assert "```mermaid\nflowchart LR\n" in text
    for lane in graph["lanes"]:
        assert f'["{lane["id"]}"]' in text
    assert text.count("  subgraph lane_") == len(graph["lanes"])


# --- what the export refuses ------------------------------------------------------------

_HARVEST = Stage(
    "fake_harvest",
    phase="harvest",
    pillar="societies",
    campus="cam",
    writes=("camdram",),
    network=True,
    docs=("source-research§5",),
)
_SOURCE = {
    "key": "fake",
    "label": "a fabricated source",
    "stage": "fake_harvest",
    "sourceTypes": ["camdram"],
    "eventSources": [],
    "section": "5",
    "permission": "robots",
}
_DOCS = {"source-research": "# Source research\n\n## §5 A fabricated section\n"}


def _build(stages, groups=None, sources=(_SOURCE,), docs=_DOCS) -> dict:
    return build_graph(
        CAMBRIDGE,
        stages=stages,
        group_map=groups or {"full": StageGroup("full")},
        sources=sources,
        docs=docs,
    )


def test_a_fabricated_well_formed_registry_builds() -> None:
    built = _build([_HARVEST])
    stage = _nodes(built, "stage")[0]
    assert stage["docs"] == [
        {"doc": "docs/source-research.md", "section": "5", "anchor": "5-a-fabricated-section"}
    ]


def test_a_missing_section_raises() -> None:
    cites_99 = Stage(
        "fake_harvest",
        phase="harvest",
        pillar="societies",
        campus="cam",
        writes=("camdram",),
        docs=("source-research§99",),
    )
    with pytest.raises(GraphError, match="§99"):
        _build([cites_99])


def test_a_missing_section_in_the_real_docs_raises() -> None:
    cites_99 = Stage("fake", phase="seed", docs=("source-research§99",))
    with pytest.raises(GraphError, match=r"source-research\.md §99"):
        build_graph(CAMBRIDGE, stages=[cites_99], group_map={}, sources=[])


def test_a_missing_doc_raises() -> None:
    with pytest.raises(GraphError, match="does not exist"):
        build_graph(
            CAMBRIDGE,
            stages=[Stage("fake", phase="seed", docs=("no-such-doc",))],
            group_map={},
            sources=[],
        )


def test_a_manifest_section_that_does_not_exist_raises() -> None:
    with pytest.raises(GraphError, match="§42"):
        _build([_HARVEST], sources=[{**_SOURCE, "section": "42"}])


def test_a_write_outside_staging_raises() -> None:
    bad = Stage("fake_harvest", phase="harvest", writes=("not_a_source_type",))
    with pytest.raises(GraphError, match="writes outside staging"):
        _build([bad])


def test_a_read_outside_staging_raises() -> None:
    bad = Stage("fake", phase="load", reads=("@nothing",))
    with pytest.raises(GraphError, match="reads outside staging"):
        _build([_HARVEST, bad])


def test_a_group_whose_needs_miss_a_read_raises() -> None:
    reader = Stage("fake_load", phase="load", reads=("su_profile",))
    groups = {"daily": StageGroup("daily", stages=("fake_load",), needs=())}
    with pytest.raises(GraphError, match=r"Group daily reads \['su_profile'\]"):
        _build([_HARVEST, reader], groups=groups)


def test_a_group_naming_an_unknown_stage_raises() -> None:
    with pytest.raises(GraphError, match="unknown stages"):
        _build([_HARVEST], groups={"g": StageGroup("g", stages=("ghost",))})


def test_a_harvesting_stage_without_a_manifest_source_raises() -> None:
    with pytest.raises(GraphError, match="manifest omits it"):
        _build([_HARVEST], sources=[])


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ({"stage": "ghost"}, "unknown stage"),
        ({"sourceTypes": ["nonsense"]}, "unknown source type"),
        ({"sourceTypes": ["luma"]}, "does not write luma"),
        ({"eventSources": ["nonsense"]}, "unknown event sources"),
        ({"permission": "anything"}, "unknown permission"),
    ],
)
def test_a_manifest_entry_that_contradicts_the_registry_raises(change, message) -> None:
    with pytest.raises(GraphError, match=message):
        _build([_HARVEST], sources=[{**_SOURCE, **change}])


def test_a_manifest_key_listed_twice_raises() -> None:
    with pytest.raises(GraphError, match="twice"):
        _build([_HARVEST], sources=[_SOURCE, _SOURCE])


# --- schedules and anchors ---------------------------------------------------------------


def test_calendars_read_as_a_person_says_them() -> None:
    assert describe_calendar("*-*-* 04:30:00 Europe/London") == "daily 04:30 Europe/London"
    assert describe_calendar("Sun *-*-* 02:00:00 Europe/London") == "weekly Sun 02:00 Europe/London"
    assert describe_calendar("hourly") == "hourly"


def test_a_timer_that_starts_another_unit_raises(tmp_path: Path) -> None:
    (tmp_path / "camsocs-harvest-events.timer").write_text(
        "[Timer]\nOnCalendar=*-*-* 04:30:00 Europe/London\nUnit=camsocs-harvest@full.service\n",
        encoding="utf-8",
    )
    with pytest.raises(GraphError, match="does not start"):
        group_schedule("events", tmp_path)
    assert group_schedule("talks", tmp_path) is None


def test_heading_anchors_follow_github() -> None:
    assert heading_anchor('§1 Cambridge SU "Find a Society"') == "1-cambridge-su-find-a-society"
    assert heading_anchor("§3 Sport Cambridge A–Z and club pages") == (
        "3-sport-cambridge-az-and-club-pages"
    )
    assert heading_anchor("§8 Colleges and JCR/MCR") == "8-colleges-and-jcrmcr"


# --- another campus ------------------------------------------------------------------------


def test_a_synthetic_campus_gets_its_own_lanes_and_ids() -> None:
    sources = [
        {
            "key": f"{stage.name}_src",
            "label": "synthetic",
            "stage": stage.name,
            "sourceTypes": ["manual"],
            "eventSources": [],
            "section": None,
            "permission": None,
        }
        for stage in campus_zz.ZZ.stages
    ] + [
        {**entry, "key": f"engine_{entry['key']}"}
        for entry in load_sources("cam")
        if entry["stage"]
        in {"enrich", "calendar_feeds", "website_events", "inbox", "instagram", "termcards"}
        or entry["stage"] == "term_dates"
    ]
    built = build_graph(campus_zz.ZZ, sources=sources)
    assert built["campus"]["id"] == "zz"
    assert built["campus"]["name"] == "Testford"
    lanes = [lane["id"] for lane in built["lanes"]]
    assert lanes[:2] == ["zz/societies", "zz/events"]
    assert not any(lane.startswith("cam/") for lane in lanes)
    assert all(node["id"].split(":")[1] == "zz" for node in built["nodes"])
    assert all(row["schedule"] is None for row in built["groups"])
    with pytest.raises(GraphError, match="no source manifest"):
        build_graph(campus_zz.ZZ)


# --- the command ---------------------------------------------------------------------------


def test_the_graph_command_writes_both_files(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("CAMSOCS_CAMPUS", raising=False)
    out_json, out_md = tmp_path / "g" / "graph.json", tmp_path / "map.md"
    result = CliRunner().invoke(
        cli, ["graph", "--json", str(out_json), "--mermaid", str(out_md)], obj={}
    )
    assert result.exit_code == 0, result.output
    assert out_json.read_text(encoding="utf-8") == (REPO_ROOT / JSON_PATH).read_text(
        encoding="utf-8"
    )
    assert out_md.read_text(encoding="utf-8") == (REPO_ROOT / MERMAID_PATH).read_text(
        encoding="utf-8"
    )


def test_the_graph_command_prints_json_without_a_path(monkeypatch) -> None:
    monkeypatch.delenv("CAMSOCS_CAMPUS", raising=False)
    result = CliRunner().invoke(cli, ["graph"], obj={})
    assert result.exit_code == 0, result.output
    assert json.loads(result.output)["schema"] == SCHEMA


def test_the_graph_command_refuses_an_unknown_campus() -> None:
    result = CliRunner().invoke(cli, ["--campus", "xx", "graph"], obj={})
    assert result.exit_code != 0
    assert "Unknown campus" in result.output
