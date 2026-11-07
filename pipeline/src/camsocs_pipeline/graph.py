"""The pipeline graph: the stage registry as data (spec §5A, decision D8).

`build_graph(profile)` turns a campus's registry (`stages.registry`), its
scheduled runs (`stages.groups`) and its source manifest
(``campuses/<id>_sources.json``) into one JSON document, schema
``camsocs.pipeline-graph/1``; `render_mermaid` draws the same graph as a
Mermaid flowchart with one subgraph per lane (campus × pillar). `camsocs
graph` writes both, and ``pixi run pipeline-graph`` regenerates the committed
copies:

- ``webapp/lib/generated/pipeline-graph.cam.json`` (the dashboard reads it);
- ``docs/pipeline-map.md``.

Nothing here runs a stage, reads staging or touches the network. Building the
graph also checks the registry, and raises `GraphError` when

- a stage cites a docs § (``"source-research§N"``) that has no ``## §N``
  heading, or a doc that does not exist; a manifest source's ``section`` is
  checked the same way against the campus's own research doc
  (`campus_docs`);
- a stage reads or writes something that is not a staging directory
  (`SOURCE_TYPES`, ``<type>.events``, ``_resolved``, the talks pillar's
  ``talks``) or a selector;
- a group's stages read a directory none of them writes and the group does
  not list in `needs` (``derived_needs() ⊄ needs``);
- the source manifest names an unknown stage, source type or event source,
  or a stage that harvests has no manifest source.

Node ids are ``<kind>:<campus>:<name>`` with the exported campus's id, so the
graphs of several campus deployments can be federated without collisions
(D8.5). Module paths are left out on purpose: moving a module changes nothing
here. The output carries no timestamp, so regenerating is byte-stable.
"""

from __future__ import annotations

import json
import re
import unicodedata
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any

from camsocs_pipeline.campuses.profile import CampusProfile
from camsocs_pipeline.config import REPO_ROOT
from camsocs_pipeline.models.vocab import EVENT_SOURCES, SOURCE_TYPES
from camsocs_pipeline.pipeline.context import PHASES, PILLARS, SELECTORS, Stage, StageGroup
from camsocs_pipeline.stages import groups as campus_groups
from camsocs_pipeline.stages import registry
from camsocs_pipeline.staging.store import RESOLVED, TALKS, events_directory

SCHEMA = "camsocs.pipeline-graph/1"
SOURCES_SCHEMA = "camsocs.campus-sources/1"

DOCS_DIR = REPO_ROOT / "docs"
CAMPUSES_DIR = Path(__file__).resolve().parent / "campuses"
TIMERS_DIR = REPO_ROOT / "ops" / "vps" / "systemd"

#: Where `pixi run pipeline-graph` writes, relative to the repo root.
JSON_PATH = Path("webapp/lib/generated/pipeline-graph.cam.json")
MERMAID_PATH = Path("docs/pipeline-map.md")

#: How a stage may get past robots.txt: not at all (``robots``), as a society
#: page of a D3 URL class (``D3``), or by a publisher's recorded permission
#: (``D3a``); `None` for a source that is not crawled at run time (a seed in
#: the repo, forwarded mail, an official API).
PERMISSIONS: tuple[str | None, ...] = ("robots", "D3", "D3a", None)

#: A display name where the stage name alone would mislead.
STAGE_LABELS: Mapping[str, str] = {"talks_cam": "talks.cam lists (G1)"}

#: The Convex pipeline routes a stage reads back from (``readRoute`` and the
#: ``inbound/file`` download); a stage *reads* these and *posts* to the rest.
#: Every ``sinks=`` entry is one real route (``webapp/convex/http.ts``), by
#: its exact name, so each sink node is one route.
READ_ROUTES: frozenset[str] = frozenset(
    {
        "inbound/pending",
        "inbound/file",
        "crosswalk",
        "worklist",
        "suppressions",
        "coverage",
        "coverage/events",
        "events/scan",
    }
)

SELECTOR_DESCRIPTIONS: Mapping[str, str] = {
    "@org_lookup": "the organisations known so far: _resolved and the crosswalk",
    "@event_index": "the events already staged",
    "@all_observations": "every source directory at once",
}

#: Phases whose stages harvest a source; each needs a manifest entry.
_SOURCE_PHASES = frozenset({"harvest", "events", "inbox", "talks"})

_SECTION = re.compile(r"^## §(\d+)\b(.*)$", re.MULTILINE)
_ON_CALENDAR = re.compile(r"^OnCalendar=(.+)$", re.MULTILINE)
_TIMER_UNIT = re.compile(r"^Unit=(.+)$", re.MULTILINE)
_DAILY = re.compile(r"^\*-\*-\* (\d{2}:\d{2}):00 (\S+)$")
_WEEKLY = re.compile(r"^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \*-\*-\* (\d{2}:\d{2}):00 (\S+)$")

#: Biome's JSON line width (webapp/biome.json): arrays that fit stay on one line.
_LINE_WIDTH = 100


class GraphError(ValueError):
    """The registry, a group or the source manifest contradicts itself or the docs."""


# --- docs ---------------------------------------------------------------------


def heading_anchor(heading: str) -> str:
    """The GitHub anchor of a Markdown heading: lower case, punctuation and
    symbols dropped (``§``, quotes, dashes that are not ``-``), spaces → ``-``."""
    kept = []
    for char in heading.strip().lower():
        if char in "-_" or char.isspace():
            kept.append("-" if char.isspace() else char)
        elif unicodedata.category(char)[0] in "LNM":
            kept.append(char)
    return "".join(kept)


def doc_sections(text: str) -> dict[str, str]:
    """``§N`` → the anchor of its ``## §N …`` heading."""
    return {
        match.group(1): heading_anchor(f"§{match.group(1)}{match.group(2)}")
        for match in _SECTION.finditer(text)
    }


class _Docs:
    """Reads each cited doc once; `docs` maps a doc name to its text (tests)."""

    def __init__(self, docs: Mapping[str, str] | None) -> None:
        self._given = dict(docs or {})
        self._sections: dict[str, dict[str, str]] = {}

    def sections(self, name: str, cited_by: str) -> dict[str, str]:
        if name not in self._sections:
            if name in self._given:
                text = self._given[name]
            else:
                path = DOCS_DIR / f"{name}.md"
                if not path.is_file():
                    raise GraphError(f"Stage {cited_by} cites docs/{name}.md, which does not exist")
                text = path.read_text(encoding="utf-8")
            self._sections[name] = doc_sections(text)
        return self._sections[name]

    def ref(self, cite: str, cited_by: str) -> dict[str, str | None]:
        """``"source-research§1"`` → ``{doc, section, anchor}``."""
        name, _, section = cite.partition("§")
        sections = self.sections(name, cited_by)
        doc = f"docs/{name}.md"
        if not section:
            return {"doc": doc, "section": None, "anchor": None}
        if section not in sections:
            raise GraphError(f"Stage {cited_by} cites {doc} §{section}, which has no heading")
        return {"doc": doc, "section": section, "anchor": sections[section]}


def campus_docs(campus_id: str) -> str:
    """The doc a campus's manifest ``section`` numbers refer to, by name
    (``docs/<name>.md``): Cambridge keeps ``source-research``; any other campus
    has ``campuses/<id>``."""
    return "source-research" if campus_id == "cam" else f"campuses/{campus_id}"


# --- registry checks ----------------------------------------------------------


def staging_directories() -> frozenset[str]:
    """Every directory a stage may read or write in staging."""
    return frozenset({*SOURCE_TYPES, *(events_directory(t) for t in SOURCE_TYPES), RESOLVED, TALKS})


def _check_registry(stages: Sequence[Stage], group_map: Mapping[str, StageGroup]) -> None:
    names = [stage.name for stage in stages]
    if len(set(names)) != len(names):
        raise GraphError(f"Stage names repeat: {names}")
    directories = staging_directories()
    for stage in stages:
        if bad := sorted(set(stage.writes) - directories - {"@all_observations"}):
            raise GraphError(f"Stage {stage.name} writes outside staging: {bad}")
        if bad := sorted(set(stage.reads) - directories - set(SELECTORS)):
            raise GraphError(f"Stage {stage.name} reads outside staging: {bad}")
        if bad := sorted(set(stage.requires) - set(names)):
            raise GraphError(f"Stage {stage.name} requires unknown stages: {bad}")
    for key, group in group_map.items():
        if bad := sorted(set(group.stages) - set(names)):
            raise GraphError(f"Group {key} names unknown stages: {bad}")
        if bad := sorted(set(group.needs) - directories):
            raise GraphError(f"Group {key} needs outside staging: {bad}")
        missing = group.derived_needs(stages) - set(group.needs)
        if missing:
            raise GraphError(
                f"Group {key} reads {sorted(missing)} but no stage of it writes them "
                "and its needs leave them out"
            )


# --- source manifest ------------------------------------------------------------


def manifest_path(campus_id: str) -> Path:
    return CAMPUSES_DIR / f"{campus_id}_sources.json"


def load_sources(campus_id: str) -> list[dict[str, Any]]:
    """The campus's source manifest (``campuses/<id>_sources.json``)."""
    path = manifest_path(campus_id)
    if not path.is_file():
        raise GraphError(f"Campus {campus_id} has no source manifest ({path.name})")
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("schema") != SOURCES_SCHEMA or data.get("campus") != campus_id:
        raise GraphError(f"{path.name}: expected schema {SOURCES_SCHEMA} for campus {campus_id}")
    return list(data["sources"])


def _sources(
    entries: Iterable[Mapping[str, Any]], stages: Sequence[Stage], docs: _Docs, research: str
) -> list[dict[str, Any]]:
    by_name = {stage.name: stage for stage in stages}
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for entry in entries:
        key = entry["key"]
        if key in seen:
            raise GraphError(f"Source {key} is listed twice")
        seen.add(key)
        stage = by_name.get(entry["stage"])
        if stage is None:
            raise GraphError(f"Source {key} names unknown stage {entry['stage']!r}")
        source_types = list(entry["sourceTypes"])
        for source_type in source_types:
            if source_type not in SOURCE_TYPES:
                raise GraphError(f"Source {key}: unknown source type {source_type!r}")
            if (
                source_type not in stage.writes
                and events_directory(source_type) not in stage.writes
            ):
                raise GraphError(f"Source {key}: stage {stage.name} does not write {source_type}")
        event_sources = list(entry["eventSources"])
        if bad := sorted(set(event_sources) - set(EVENT_SOURCES)):
            raise GraphError(f"Source {key}: unknown event sources {bad}")
        if entry["permission"] not in PERMISSIONS:
            raise GraphError(f"Source {key}: unknown permission {entry['permission']!r}")
        section = entry["section"]
        anchor = None
        if section is not None:
            ref = docs.ref(f"{research}§{section}", cited_by=f"{stage.name} (source {key})")
            anchor = ref["anchor"]
        out.append(
            {
                "key": key,
                "label": entry["label"],
                "stage": stage.name,
                "pillar": stage.pillar,
                "sourceTypes": source_types,
                "eventSources": event_sources,
                "section": section,
                "anchor": anchor,
                "permission": entry["permission"],
            }
        )
    covered = {source["stage"] for source in out}
    for stage in stages:
        if stage.phase in _SOURCE_PHASES and stage.name not in covered:
            raise GraphError(f"Stage {stage.name} harvests but the source manifest omits it")
    return out


# --- schedules ------------------------------------------------------------------


def describe_calendar(on_calendar: str) -> str:
    """A systemd ``OnCalendar=`` as a reader says it: ``daily 04:30 Europe/London``."""
    if match := _DAILY.match(on_calendar):
        return f"daily {match.group(1)} {match.group(2)}"
    if match := _WEEKLY.match(on_calendar):
        return f"weekly {match.group(1)} {match.group(2)} {match.group(3)}"
    return on_calendar


def group_schedule(group: str, timers_dir: Path = TIMERS_DIR) -> str | None:
    """When the VPS runs `group` (``camsocs-harvest-<group>.timer``, docs/ops-vps.md),
    or `None` for a group that runs only by hand."""
    path = timers_dir / f"camsocs-harvest-{group}.timer"
    if not path.is_file():
        return None
    text = path.read_text(encoding="utf-8")
    unit = _TIMER_UNIT.search(text)
    if unit is None or unit.group(1).strip() != f"camsocs-harvest@{group}.service":
        raise GraphError(f"{path.name} does not start camsocs-harvest@{group}.service")
    calendars = _ON_CALENDAR.findall(text)
    if len(calendars) != 1:
        raise GraphError(f"{path.name}: expected one OnCalendar=, found {len(calendars)}")
    return describe_calendar(calendars[0].strip())


# --- the graph --------------------------------------------------------------------


def lane_id(stage: Stage) -> str:
    return f"{stage.campus or 'engine'}/{stage.pillar}"


def _ref(kind: str, campus: str, name: str) -> str:
    return f"{kind}:{campus}:{name.removeprefix('@')}"


def build_graph(
    profile: CampusProfile,
    *,
    stages: Sequence[Stage] | None = None,
    group_map: Mapping[str, StageGroup] | None = None,
    sources: Iterable[Mapping[str, Any]] | None = None,
    docs: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """The pipeline graph of `profile` (schema ``camsocs.pipeline-graph/1``).

    The keyword arguments replace what is read from the repo (the registry,
    the groups, the source manifest, a doc's text by name), for tests."""
    stages = list(registry(profile) if stages is None else stages)
    group_map = campus_groups(profile) if group_map is None else group_map
    _check_registry(stages, group_map)
    reader = _Docs(docs)
    campus = profile.id
    research = campus_docs(campus)
    entries = load_sources(campus) if sources is None else sources
    source_rows = _sources(entries, stages, reader, research)

    member_of: dict[str, list[str]] = {stage.name: [] for stage in stages}
    group_rows = []
    for key, group in group_map.items():
        members = [stage.name for stage in group.members(stages)]
        for name in members:
            member_of[name].append(key)
        group_rows.append(
            {
                "key": key,
                "description": group.description or None,
                "stages": members,
                "needs": list(group.needs),
                "staleAfterDays": group.stale_after.days if group.stale_after else None,
                "derive": group.derive,
                "schedule": group_schedule(key) if campus == "cam" else None,
            }
        )

    lanes = []
    present = {lane_id(stage) for stage in stages}
    for owner in (campus, "engine"):
        for pillar in PILLARS:
            if f"{owner}/{pillar}" in present:
                lanes.append(
                    {
                        "id": f"{owner}/{pillar}",
                        "campus": None if owner == "engine" else owner,
                        "pillar": pillar,
                    }
                )
    if unknown := present - {lane["id"] for lane in lanes}:
        raise GraphError(f"Stages of another campus in the {campus} graph: {sorted(unknown)}")

    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, str]] = []
    directories: dict[str, None] = {}
    selectors: dict[str, None] = {}
    sinks: dict[str, None] = {}

    def endpoint(entry: str) -> str:
        if entry.startswith("@"):
            selectors.setdefault(entry)
            return _ref("sel", campus, entry)
        directories.setdefault(entry)
        return _ref("dir", campus, entry)

    for order, stage in enumerate(stages):
        stage_id = _ref("stage", campus, stage.name)
        nodes.append(
            {
                "id": stage_id,
                "kind": "stage",
                "name": stage.name,
                "order": order,
                "phase": stage.phase,
                "pillar": stage.pillar,
                "campus": stage.campus,
                "lane": lane_id(stage),
                "description": stage.description or None,
                "requires": list(stage.requires),
                "groups": member_of[stage.name],
                "network": stage.network,
                "llm": stage.llm,
                "fetchesInDryRun": stage.fetches,
                "label": STAGE_LABELS.get(stage.name),
                "docs": [reader.ref(cite, cited_by=stage.name) for cite in stage.docs],
            }
        )
        for required in stage.requires:
            edges.append(
                {"from": _ref("stage", campus, required), "to": stage_id, "kind": "requires"}
            )
        for entry in stage.reads:
            edges.append({"from": endpoint(entry), "to": stage_id, "kind": "reads"})
        for entry in stage.writes:
            edges.append({"from": stage_id, "to": endpoint(entry), "kind": "writes"})
        for sink in stage.sinks:
            sinks.setdefault(sink)
            sink_id = _ref("sink", campus, sink)
            if sink in READ_ROUTES:
                edges.append({"from": sink_id, "to": stage_id, "kind": "reads"})
            else:
                edges.append({"from": stage_id, "to": sink_id, "kind": "posts"})

    for row in group_rows:
        group_id = _ref("group", campus, row["key"])
        nodes.append({"id": group_id, "kind": "group", "name": row["key"]})
        for need in row["needs"]:
            edges.append({"from": endpoint(need), "to": group_id, "kind": "needs"})

    for directory in directories:
        source_type = None if directory in (RESOLVED, TALKS) else directory.removesuffix(".events")
        nodes.append(
            {
                "id": _ref("dir", campus, directory),
                "kind": "staging",
                "name": directory,
                "sourceType": source_type,
                "events": directory.endswith(".events"),
            }
        )
    for selector in (s for s in SELECTORS if s in selectors):
        nodes.append(
            {
                "id": _ref("sel", campus, selector),
                "kind": "selector",
                "name": selector.removeprefix("@"),
                "selector": selector,
                "description": SELECTOR_DESCRIPTIONS[selector],
            }
        )
    for sink in sinks:
        nodes.append(
            {
                "id": _ref("sink", campus, sink),
                "kind": "sink",
                "name": sink,
                "route": f"/api/pipeline/{sink}",
            }
        )

    return {
        "schema": SCHEMA,
        "campus": {
            "id": campus,
            "name": profile.short_name,
            "site": profile.branding.site_url,
            "docs": f"docs/{research}.md",
        },
        "pillars": list(PILLARS),
        "phases": [{"key": phase, "order": order} for order, phase in enumerate(PHASES)],
        "lanes": lanes,
        "groups": group_rows,
        "nodes": nodes,
        "edges": edges,
        "sources": source_rows,
    }


# --- JSON, formatted as Biome formats it ------------------------------------------------


def _flat(value: Any) -> str | None:
    """`value` on one line, or `None` when Biome would keep it expanded (a
    non-empty object, or an array holding one)."""
    if isinstance(value, dict):
        return "{}" if not value else None
    if isinstance(value, list):
        parts = [_flat(item) for item in value]
        if any(part is None for part in parts):
            return None
        return "[" + ", ".join(parts) + "]"  # type: ignore[arg-type]
    return json.dumps(value, ensure_ascii=False)


def _dump(value: Any, indent: int, prefix: int, suffix: int) -> str:
    """`value` starting at column `prefix`, followed by `suffix` characters."""
    pad = " " * (indent + 2)
    if isinstance(value, dict) and value:
        lines = []
        for position, (key, item) in enumerate(value.items()):
            comma = 1 if position < len(value) - 1 else 0
            head = f"{pad}{json.dumps(key, ensure_ascii=False)}: "
            lines.append(head + _dump(item, indent + 2, len(head), comma) + "," * comma)
        return "{\n" + "\n".join(lines) + "\n" + " " * indent + "}"
    flat = _flat(value)
    if flat is not None and prefix + len(flat) + suffix <= _LINE_WIDTH:
        return flat
    if isinstance(value, list):
        lines = []
        for position, item in enumerate(value):
            comma = 1 if position < len(value) - 1 else 0
            lines.append(pad + _dump(item, indent + 2, len(pad), comma) + "," * comma)
        return "[\n" + "\n".join(lines) + "\n" + " " * indent + "]"
    return flat if flat is not None else json.dumps(value, ensure_ascii=False)


def to_json(graph: Mapping[str, Any]) -> str:
    """The committed JSON text: two-space indent, objects expanded, arrays
    on one line when they fit in 100 columns — Biome's own layout, so
    ``bun run check`` leaves the generated file unchanged."""
    return _dump(graph, 0, 0, 0) + "\n"


# --- Mermaid ----------------------------------------------------------------------------


def _mermaid_id(node_id: str) -> str:
    kind, _, name = node_id.split(":", 2)
    return f"{kind}_" + re.sub(r"[^A-Za-z0-9_]", "_", name.replace(".events", "__events"))


def _mermaid_text(text: str) -> str:
    return text.replace('"', "#quot;")


def _md(text: str) -> str:
    return text.replace("|", "\\|")


def _doc_link(ref: Mapping[str, Any]) -> str:
    target = ref["doc"].removeprefix("docs/")
    if ref["section"] is None:
        return f"[{Path(target).stem}]({target})"
    return f"[§{ref['section']}]({target}#{ref['anchor']})"


#: The pillars' display names, as the dashboard's `PILLAR_LABELS`
#: (webapp/lib/pipeline-graph/graph.ts).
PILLAR_LABELS: Mapping[str, str] = {
    "societies": "Societies",
    "events": "Events",
    "talks": "Talks",
    "shared": "Shared",
}


def lane_label(lane: Mapping[str, Any], campus: Mapping[str, Any]) -> str:
    """`Societies · Cambridge`, `Events · engine`: the canvas's lane label
    (`laneLabel` in webapp/lib/pipeline-graph/layout.ts)."""
    if lane["campus"] is None:
        who = "engine"
    elif lane["campus"] == campus["id"]:
        who = campus["name"]
    else:
        who = lane["campus"]
    return f"{PILLAR_LABELS[lane['pillar']]} · {who}"


def render_mermaid(graph: Mapping[str, Any]) -> str:
    """`docs/pipeline-map.md`: the flowchart (one subgraph per lane) and the
    stage, group and source tables."""
    campus = graph["campus"]
    nodes = graph["nodes"]
    by_kind: dict[str, list[Mapping[str, Any]]] = {}
    for node in nodes:
        by_kind.setdefault(node["kind"], []).append(node)
    out = [
        "# Pipeline map",
        "",
        "<!-- Generated by `pixi run pipeline-graph` from the stage registry",
        "     (pipeline/src/camsocs_pipeline/stages/__init__.py) and the source manifest",
        f"     (pipeline/src/camsocs_pipeline/campuses/{campus['id']}_sources.json).",
        "     Do not edit by hand: tests/test_graph_export.py fails when it is stale. -->",
        "",
        f"Campus **{campus['name']}** (`{campus['id']}`, {campus['site']}).",
        f"The same graph as data: `{JSON_PATH.as_posix()}`",
        f"(schema `{graph['schema']}`). Lanes are campus × pillar; `engine` stages run",
        "for every campus. Solid arrows write, dotted arrows read, thick arrows post to",
        "Convex.",
        "",
        "```mermaid",
        "flowchart LR",
    ]
    stages_by_lane: dict[str, list[Mapping[str, Any]]] = {}
    for node in by_kind.get("stage", []):
        stages_by_lane.setdefault(node["lane"], []).append(node)
    for lane in graph["lanes"]:
        lane_key = re.sub(r"[^A-Za-z0-9_]", "_", lane["id"])
        out.append(f'  subgraph lane_{lane_key}["{lane_label(lane, campus)}"]')
        out.append("    direction TB")
        for node in stages_by_lane.get(lane["id"], []):
            label = node["label"] or node["name"]
            out.append(f'    {_mermaid_id(node["id"])}["{_mermaid_text(label)} · {node["phase"]}"]')
        out.append("  end")
    if by_kind.get("staging"):
        out.append('  subgraph staging["staging"]')
        for node in by_kind["staging"]:
            out.append(f'    {_mermaid_id(node["id"])}[("{node["name"]}")]')
        out.append("  end")
    for node in by_kind.get("selector", []):
        out.append(f'  {_mermaid_id(node["id"])}{{{{"{node["selector"]}"}}}}')
    if by_kind.get("sink"):
        out.append('  subgraph convex["Convex /api/pipeline"]')
        for node in by_kind["sink"]:
            out.append(f'    {_mermaid_id(node["id"])}[/"{node["name"]}"/]')
        out.append("  end")
    arrows = {"writes": "-->", "reads": "-.->", "posts": "==>", "requires": "-. requires .->"}
    for edge in graph["edges"]:
        if edge["kind"] in arrows:
            out.append(
                f"  {_mermaid_id(edge['from'])} {arrows[edge['kind']]} {_mermaid_id(edge['to'])}"
            )
    out += ["```", ""]

    out += [
        "## Stages",
        "",
        "| # | Stage | Phase | Pillar | Lane | Groups | Network | LLM | Docs |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for node in by_kind.get("stage", []):
        name = f"`{node['name']}`" + (f" ({_md(node['label'])})" if node["label"] else "")
        docs = ", ".join(_doc_link(ref) for ref in node["docs"]) or "–"
        out.append(
            f"| {node['order']} | {name} | {node['phase']} | {node['pillar']} | {node['lane']} | "
            f"{', '.join(node['groups'])} | {'yes' if node['network'] else 'no'} | "
            f"{'yes' if node['llm'] else 'no'} | {docs} |"
        )
    out += [
        "",
        "## Groups",
        "",
        "| Group | Schedule | Stages | Needs | Stale after |",
        "|---|---|---|---|---|",
    ]
    for group in graph["groups"]:
        needs = ", ".join(f"`{need}`" for need in group["needs"]) or "–"
        stale = f"{group['staleAfterDays']} days" if group["staleAfterDays"] else "–"
        out.append(
            f"| `{group['key']}` | {group['schedule'] or 'by hand'} | {len(group['stages'])} | "
            f"{needs} | {stale} |"
        )
    research = campus["docs"].removeprefix("docs/")
    out += [
        "",
        "## Sources",
        "",
        "| Source | Stage | Pillar | Source types | Event sources | § | Permission |",
        "|---|---|---|---|---|---|---|",
    ]
    for source in graph["sources"]:
        section = source["section"]
        cited = "–" if section is None else f"[§{section}]({research}#{source['anchor']})"
        types = ", ".join(f"`{t}`" for t in source["sourceTypes"]) or "–"
        events = ", ".join(f"`{e}`" for e in source["eventSources"]) or "–"
        out.append(
            f"| {_md(source['label'])} | `{source['stage']}` | {source['pillar']} | {types} | "
            f"{events} | {cited} | {source['permission'] or '–'} |"
        )
    return "\n".join(out) + "\n"


def write_outputs(
    graph: Mapping[str, Any], json_path: Path | None, mermaid_path: Path | None
) -> list[Path]:
    """Write the JSON and/or the Mermaid page; returns the paths written."""
    written = []
    for path, text in ((json_path, to_json(graph)), (mermaid_path, render_mermaid(graph))):
        if path is None:
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8", newline="\n")
        written.append(path)
    return written


__all__ = [
    "JSON_PATH",
    "MERMAID_PATH",
    "READ_ROUTES",
    "SCHEMA",
    "GraphError",
    "build_graph",
    "campus_docs",
    "describe_calendar",
    "doc_sections",
    "group_schedule",
    "heading_anchor",
    "lane_id",
    "lane_label",
    "load_sources",
    "render_mermaid",
    "staging_directories",
    "to_json",
    "write_outputs",
]
