"""Talks from departments' own sites (spec §2, §3): one parser per source
kind of the department registry, all deterministic and zero-LLM.

`collect(dept, source, client, window)` reads one registry source with the
polite client (``general`` purpose: robots.txt always holds) and returns
the talks it lists inside ``[window.start, window.end)``:

| source kind  | parser        | source type   |
|--------------|---------------|---------------|
| ``ics``        | `ics`           | ``dept_ics``    |
| ``rss``        | `rss`           | ``dept_rss``    |
| ``json_api``   | `json_api`      | ``dept_json``   |
| ``json_ld``    | `jsonld`        | ``dept_jsonld`` |
| ``drupal_uis`` | `drupal_uis`    | ``dept_drupal`` |

Every record carries ``source = f"{dept.key}#{index}"`` (the source's place
in ``dept.sources``, the sweep scope) and ``department_keys = [dept.key]``.
Only talks are kept (`filters`). A source whose listing cannot be read raises
`SourceError`; the caller must then not sweep it. `read` returns the records
with the read's counts and notes (`SourceRead`) for the verify report.
"""

from __future__ import annotations

from collections.abc import Callable

from camsocs_pipeline.events.common import EventWindow
from camsocs_pipeline.talks.dedupe import title_key
from camsocs_pipeline.talks.model import TalkRecord
from camsocs_pipeline.talks.registry import Department, DepartmentSource
from camsocs_pipeline.talks.sites import drupal_uis, ics, json_api, jsonld, rss
from camsocs_pipeline.talks.sites.common import (
    Client,
    SiteContext,
    SourceError,
    SourceRead,
    Window,
)

#: Source kind → (parser, source type).
PARSERS: dict[str, tuple[Callable[[SiteContext], None], str]] = {
    "ics": (ics.collect, ics.SOURCE_TYPE),
    "rss": (rss.collect, rss.SOURCE_TYPE),
    "json_api": (json_api.collect, json_api.SOURCE_TYPE),
    "json_ld": (jsonld.collect, jsonld.SOURCE_TYPE),
    "drupal_uis": (drupal_uis.collect, drupal_uis.SOURCE_TYPE),
}

#: Every source type these parsers produce (all parser-only, never an LLM).
SITE_SOURCE_TYPES: frozenset[str] = frozenset(t for _, t in PARSERS.values())


def _index(dept: Department, source: DepartmentSource) -> int:
    for i, candidate in enumerate(dept.sources):
        if candidate == source:
            return i
    raise ValueError(f"{source.url} is not a source of {dept.key}")


def read(dept: Department, source: DepartmentSource, client: Client, window: Window) -> SourceRead:
    """`collect`, with the read's counts and notes."""
    if source.kind not in PARSERS:
        raise NotImplementedError(f"no parser for source kind {source.kind!r}")
    parser, source_type = PARSERS[source.kind]
    ctx = SiteContext(
        dept=dept,
        source=source,
        index=_index(dept, source),
        client=client,
        window=EventWindow(start=window.start, end=window.end),
        source_type=source_type,
    )
    parser(ctx)
    ctx.read.records = _unique(ctx.read.records)
    return ctx.read


def collect(
    dept: Department, source: DepartmentSource, client: Client, window: Window
) -> list[TalkRecord]:
    """The talks one registry source lists in the window (module docstring)."""
    return read(dept, source, client, window).records


def _unique(records: list[TalkRecord]) -> list[TalkRecord]:
    """One record per key, and per title and start minute: a listing can
    repeat an item across pages, or list one talk under two URLs (AMES). A
    placeholder title ("Title TBA", "Seminar") never matches (`dedupe.title_key`),
    nor do two records that name different talks.cam talks."""
    out: list[TalkRecord] = []
    keys: set[str] = set()
    by_title: dict[tuple[str, str], TalkRecord] = {}
    for record in records:
        if record.key in keys:
            continue
        same = title_key(record)
        earlier = by_title.get(same) if same is not None else None
        if earlier is not None and (
            earlier.talks_cam_id is None
            or record.talks_cam_id is None
            or earlier.talks_cam_id == record.talks_cam_id
        ):
            continue
        keys.add(record.key)
        if same is not None:
            by_title.setdefault(same, record)
        out.append(record)
    return out


__all__ = [
    "PARSERS",
    "SITE_SOURCE_TYPES",
    "SourceError",
    "SourceRead",
    "collect",
    "read",
]
