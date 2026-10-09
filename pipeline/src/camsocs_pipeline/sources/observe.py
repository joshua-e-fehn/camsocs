"""From fetch results to observations: the glue every seed harvester shares.

- `fetch_info` / `retrieved_at` turn a `FetchResult` into the provenance an
  `Observation` carries (`sources` row: HTTP status, robots verdict).
- `missing_reason` maps a failed fetch to the ``missingReason`` its negative
  claims carry. A failed fetch is never "found" (AGENTS.md): 404 is
  ``not_found``, 401/403 and a robots block ``access_restricted``, anything
  transient ``unreachable``.
- `run_harvest` is the body of a harvest stage: it opens a polite client,
  runs the source's harvest function (honouring ``--limit``), writes the
  observations to ``var/staging/<source_type>/<run_key>--<stage>.jsonl`` (one
  file per source type, the stage name as the part) and reports. In a dry
  run it fetches and stages nothing: a dry run writes nothing and needs no
  network.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime

from selectolax.lexbor import LexborHTMLParser

from camsocs_pipeline.models.observation import FetchInfo, Observation
from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.sources.base import FetchResult, PoliteClient

_FAILURE_REASONS = {
    "not_found": "not_found",
    "access_restricted": "access_restricted",
    "disallowed_by_robots": "access_restricted",
    "unreachable": "unreachable",
    "http_error": "unreachable",
}


def retrieved_at(result: FetchResult) -> datetime:
    moment = datetime.fromisoformat(result.fetched_at)
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def missing_reason(result: FetchResult) -> str:
    """The ``missingReason`` for fields a failed fetch could not read. A
    robots.txt that cannot be read blocks the fetch (RFC 9309), but the site
    is then unreachable rather than closed to us."""
    detail = (result.detail or "").lower()
    if result.outcome == "disallowed_by_robots" and (
        "unreachable" in detail or "answered 5" in detail or "answered 429" in detail
    ):
        return "unreachable"
    return _FAILURE_REASONS.get(result.outcome, "unreachable")


def fetch_info(client: PoliteClient, result: FetchResult) -> FetchInfo:
    """How the page was fetched, for its `sources` row. A page read only
    because a society purpose overrode robots.txt (`sources/policy.py`) keeps
    the honest ``disallowed`` verdict and says so in the access note."""
    if result.outcome == "disallowed_by_robots":
        verdict = "disallowed"
    else:
        verdict = client.robots_verdict(result.final_url or result.url)
    notes: list[str] = []
    if result.override:
        notes.append(result.override)
    if not result.ok:
        notes.append(f"{result.outcome}" + (f": {result.detail}" if result.detail else ""))
    note = "; ".join(notes) or None
    return FetchInfo(
        http_status=result.status,
        robots_verdict=verdict,
        robots_checked_at=retrieved_at(result),
        access_note=note,
    )


def parse_html(text: str) -> LexborHTMLParser:
    return LexborHTMLParser(text)


_SPACES = re.compile(r"\s+")


def visible_text(tree: LexborHTMLParser) -> str:
    """The page's readable text, whitespace collapsed (scripts and styles dropped)."""
    for node in tree.css("script, style, noscript, template"):
        node.decompose()
    root = tree.body or tree.root
    return _SPACES.sub(" ", root.text(separator=" ") if root else "").strip()


def clean_text(text: str) -> str:
    return _SPACES.sub(" ", text.replace("\u00a0", " ")).strip()


@dataclass
class Harvest:
    """What one harvest produced: observations plus notes for the stage report."""

    observations: list[Observation] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    fetched: int = 0
    failed: int = 0

    def add(self, observations: Iterable[Observation] | Observation) -> None:
        if isinstance(observations, Observation):
            self.observations.append(observations)
        else:
            self.observations.extend(observations)


HarvestFn = Callable[[PoliteClient, int | None], Harvest]


def run_harvest(ctx: StageContext, source_type: str, harvest: HarvestFn) -> Harvest | None:
    """Run a harvest function and stage its observations under `source_type`.

    Observations of several source types (a list page and the pages it links
    to) are written to one file per source type."""
    if ctx.dry_run:
        ctx.report.notes.append("dry run: nothing fetched or staged")
        return None
    with ctx.crawler() as client:
        result = harvest(client, ctx.limit)
    by_type: dict[str, list[Observation]] = {}
    for observation in result.observations:
        by_type.setdefault(observation.source_type, []).append(observation)
    written = 0
    for directory, records in sorted(by_type.items()):
        written += ctx.staging.write(directory, ctx.run.run_key, records, part=ctx.report.name)
        ctx.report.notes.append(f"{len(records)} {directory} observations staged")
    ctx.report.inserted += written
    ctx.report.skipped += result.failed
    if source_type not in by_type:
        ctx.report.notes.append(f"no {source_type} observations")
    ctx.report.notes.extend(result.notes)
    return result


__all__ = [
    "Harvest",
    "HarvestFn",
    "clean_text",
    "fetch_info",
    "missing_reason",
    "parse_html",
    "retrieved_at",
    "run_harvest",
    "visible_text",
]
