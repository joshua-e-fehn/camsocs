"""Stage `talks`: every talk source → one deduped set → Convex
(docs/talks-redesign-spec.md §2–§4, decision D7).

1. **Registry.** `registry.load_registry` (`departments.json`); an invalid
   registry fails the stage before any request.
2. **talks.cam** (`talks.talkscam`): the window, at least `CRAWL_DELAY`
   seconds between requests, mapped to departments by series and venue.
3. **Department sources**: for every registry source, in registry order, the
   pluggable parser hook ``camsocs_pipeline.talks.sites.collect(dept, source,
   client, window) -> list[TalkRecord]``, imported only when the stage runs.
   No such module (the parsers are not built yet) — every source is
   *skipped*; a hook that raises `NotImplementedError` for a source's kind —
   that source is skipped; any other exception — that source *failed* (the
   note names the exception type only). The client is the polite client with
   the general purpose: robots.txt always holds for department sites. Each
   record is re-scoped to its sweep scope ``<department key>#<source index>``
   with the department first in ``department_keys``. Department sources get
   `DEPARTMENT_BUDGET` of wall time between them; a source not started by
   then is skipped, so the stage's run time stays bounded inside the daily
   group (stages/__init__.py).
4. **Dedupe** (`talks.dedupe`), keep what overlaps the window. A department
   copy of a talks.cam talk in a slice the talks.cam read missed is held back
   first, and its source not swept (`hold_unread_mirrors`).
5. **Staging**: ``var/staging/talks/<run key>.jsonl``, one posted `TalkWire`
   per line — the stage's own record of what it sent. It is not a staged
   observation directory (`load` never reads it); `prune-cache` keeps the
   latest file and deletes older ones after the usual cutoff.
6. **Push** (`talks.push`) unless this is a dry run: the registry (first,
   before step 2, so a deployment without the talks routes fails the stage
   before any crawl), the batches, the sweep over the sources read
   completely and with at least one talk (an empty read is never taken as
   "every talk was withdrawn"), then the run summary.

**Nothing here reaches a model** and nothing a source says is printed: the
stage notes (stored on the run log, shown to anyone reading a run) are counts,
department keys, source indexes and exception types.
"""

from __future__ import annotations

import importlib
import json
import logging
import time
from collections import Counter
from collections.abc import Callable, Collection, Sequence
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Literal

from camsocs_pipeline.events.common import EventWindow, polite_client
from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.pipeline.load import BatchResult, ConvexError
from camsocs_pipeline.sources.base import PoliteClient
from camsocs_pipeline.talks import push
from camsocs_pipeline.talks.dedupe import dedupe
from camsocs_pipeline.talks.mapping import DepartmentMapper
from camsocs_pipeline.talks.model import SOURCE_TYPES, TalkRecord
from camsocs_pipeline.talks.registry import Department, DepartmentSource, load_registry
from camsocs_pipeline.talks.talkscam import (
    CRAWL_DELAY,
    TalksCamRead,
    read_talks_cam,
    talks_window,
)
from camsocs_pipeline.talks.talkscam import (
    SOURCE as TALKS_CAM_SOURCE,
)

logger = logging.getLogger(__name__)

#: The parser hook's module (owned by the department-site parsers).
SITES_MODULE = "camsocs_pipeline.talks.sites"
#: Wall time all department sources share in one run.
DEPARTMENT_BUDGET = timedelta(minutes=20)
#: `var/staging/talks/` — beside, not among, the observation directories.
STAGING_DIRECTORY = "talks"

DEPARTMENT_SOURCE_TYPES = frozenset(SOURCE_TYPES) - {"talks_cam"}

SiteCollector = Callable[
    [Department, DepartmentSource, PoliteClient, EventWindow], Sequence[TalkRecord]
]
SourceStatus = Literal["ok", "failed", "skipped"]


@dataclass
class SourceOutcome:
    """One source's read. `reason` never quotes the source."""

    source: str
    status: SourceStatus
    talks: int = 0
    reason: str | None = None


@dataclass
class DepartmentRead:
    records: list[TalkRecord] = field(default_factory=list)
    outcomes: list[SourceOutcome] = field(default_factory=list)
    dropped: Counter[str] = field(default_factory=Counter)

    def count(self, status: SourceStatus) -> int:
        return sum(1 for outcome in self.outcomes if outcome.status == status)


def source_scope(dept: Department, index: int) -> str:
    """The sweep scope of a department's `index`-th source: ``dept-x#0``."""
    return f"{dept.key}#{index}"


def load_site_collector() -> tuple[SiteCollector | None, SourceStatus, str | None]:
    """The parser hook, or why there is none: ``skipped`` when the module does
    not exist yet, ``failed`` when it exists but cannot be used."""
    try:
        module = importlib.import_module(SITES_MODULE)
    except ModuleNotFoundError as error:
        if error.name == SITES_MODULE:
            return None, "skipped", "no department parsers (talks.sites) yet"
        return None, "failed", f"talks.sites import failed: {type(error).__name__}"
    except Exception as error:
        return None, "failed", f"talks.sites import failed: {type(error).__name__}"
    collect = getattr(module, "collect", None)
    if not callable(collect):
        return None, "failed", "talks.sites has no collect()"
    return collect, "ok", None


def _scoped(record: TalkRecord, dept: Department, scope: str) -> TalkRecord:
    keys = list(dict.fromkeys([dept.key, *record.department_keys]))
    return replace(record, source=scope, department_keys=keys)


def read_departments(
    departments: Sequence[Department],
    client: PoliteClient,
    window: EventWindow,
    *,
    collector: SiteCollector | None,
    unavailable: tuple[SourceStatus, str | None] = ("skipped", None),
    limit: int | None = None,
    budget: timedelta = DEPARTMENT_BUDGET,
    clock: Callable[[], float] = time.monotonic,
) -> DepartmentRead:
    """Every registry source through `collector` (module docstring, step 3).
    Without a collector each source gets the `unavailable` status."""
    read = DepartmentRead()
    deadline = clock() + budget.total_seconds()
    started = 0
    for dept in departments:
        for index, source in enumerate(dept.sources):
            scope = source_scope(dept, index)
            if collector is None:
                status, reason = unavailable
                read.outcomes.append(SourceOutcome(scope, status, reason=reason))
                continue
            if limit is not None and started >= limit:
                read.outcomes.append(SourceOutcome(scope, "skipped", reason="--limit"))
                continue
            if clock() >= deadline:
                read.outcomes.append(SourceOutcome(scope, "skipped", reason="time budget"))
                continue
            started += 1
            try:
                found = list(collector(dept, source, client, window))
            except NotImplementedError:
                read.outcomes.append(
                    SourceOutcome(scope, "skipped", reason=f"no parser for {source.kind}")
                )
                continue
            except Exception as error:
                logger.warning("talks source %s failed: %s", scope, type(error).__name__)
                read.outcomes.append(SourceOutcome(scope, "failed", reason=type(error).__name__))
                continue
            kept = 0
            for record in found:
                if not isinstance(record, TalkRecord):
                    read.dropped["not a talk record"] += 1
                    continue
                if record.source_type not in DEPARTMENT_SOURCE_TYPES:
                    read.dropped["wrong source type"] += 1
                    continue
                if not window.overlaps(record.starts_at, record.ends_at):
                    read.dropped["outside the window"] += 1
                    continue
                read.records.append(_scoped(record, dept, scope))
                kept += 1
            read.outcomes.append(SourceOutcome(scope, "ok", talks=kept))
    return read


def wire_records(records: Sequence[TalkRecord]) -> tuple[list[TalkRecord], int]:
    """The records whose wire form is valid, and how many were not."""
    valid: list[TalkRecord] = []
    invalid = 0
    for record in records:
        try:
            record.to_wire()
        except (ValueError, TypeError):
            invalid += 1
            continue
        valid.append(record)
    return valid, invalid


def staging_path(staging_dir: Path, run_key: str) -> Path:
    if not run_key or "/" in run_key or run_key.startswith("."):
        raise ValueError(f"Not a usable run key: {run_key!r}")
    return staging_dir / STAGING_DIRECTORY / f"{run_key}.jsonl"


def write_staging(path: Path, records: Sequence[TalkRecord]) -> None:
    """One `TalkWire` per line, written whole or not at all."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record.to_wire(), ensure_ascii=False, sort_keys=True) + "\n")
    temporary.replace(path)


def sweep_sources(
    cam: TalksCamRead, departments: DepartmentRead, held: Collection[str] = ()
) -> list[str]:
    """The sources read completely, with at least one talk, and none of
    their talks `held` back (`hold_unread_mirrors`)."""
    sources = [TALKS_CAM_SOURCE] if cam.complete and cam.records else []
    sources += [
        o.source
        for o in departments.outcomes
        if o.status == "ok" and o.talks > 0 and o.source not in held
    ]
    return sources


def hold_unread_mirrors(
    records: Sequence[TalkRecord], cam: TalksCamRead
) -> tuple[list[TalkRecord], set[str]]:
    """`records` without the department copies of talks.cam talks in a slice
    this run's talks.cam read missed, and the scopes they came from.

    Dedupe works within one run, and a department copy has its own key: posted
    while its talks.cam twin is missing from the run, it would sit beside the
    talks.cam row an earlier run posted (not swept, the read being
    incomplete), and the talk would show twice. A held copy's scope is not
    swept this run either, so a row it posted earlier stays listed."""
    kept: list[TalkRecord] = []
    held: set[str] = set()
    for record in records:
        if record.talks_cam_id is not None and not cam.covers(record.starts_at):
            held.add(record.source)
            continue
        kept.append(record)
    return kept, held


def _run_status(cam: TalksCamRead, departments: DepartmentRead) -> push.RunStatus:
    ok = (1 if cam.complete else 0) + departments.count("ok")
    failed = (0 if cam.complete else 1) + departments.count("failed")
    if ok == 0:
        return "error"
    return "partial" if failed else "ok"


def _counts(counter: Counter[str]) -> str:
    return ", ".join(f"{n} {reason}" for reason, n in sorted(counter.items()))


def run(
    ctx: StageContext,
    *,
    now: datetime | None = None,
    window: EventWindow | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> None:
    started_at = now or datetime.now(UTC)
    departments = load_registry()
    window = window or talks_window(started_at)
    mapper = DepartmentMapper(departments)
    if not ctx.dry_run:
        # The registry goes first, before any request: a deployment without
        # the talks routes (functions not deployed yet) fails the stage here
        # instead of after a crawl of talks.cam whose talks could not be posted.
        try:
            push.push_departments(ctx.loader, departments)
        except ConvexError as error:
            ctx.report.notes.append(
                f"talks/departments not accepted ({type(error).__name__}): nothing read"
            )
            raise

    with polite_client(ctx.settings, min_interval=CRAWL_DELAY) as client:
        cam = read_talks_cam(client, window, mapper, max_slices=ctx.limit)
    collector, status, reason = load_site_collector()
    with polite_client(ctx.settings) as client:
        dept = read_departments(
            departments,
            client,
            window,
            collector=collector,
            unavailable=(status, reason),
            limit=ctx.limit,
            clock=clock,
        )

    dept_records, held = hold_unread_mirrors(dept.records, cam)
    merged, invalid = wire_records(dedupe([*cam.records, *dept_records]))
    duplicates = len(cam.records) + len(dept_records) - len(merged) - invalid

    notes = ctx.report.notes
    notes.append(
        f"talks.cam: {len(cam.records)} talks, {cam.mapped} mapped to departments "
        f"({cam.pages} pages, {cam.slices_read}/{cam.slices} slices"
        f"{', complete' if cam.complete else ', incomplete'})"
    )
    if cam.dropped:
        notes.append(f"talks.cam left out: {_counts(cam.dropped)}")
    notes.extend(f"talks.cam {error}" for error in cam.errors)
    notes.append(
        f"dept sources: {dept.count('ok')} ok, {dept.count('failed')} failed, "
        f"{dept.count('skipped')} skipped ({len(dept.records)} talks)"
    )
    if reason and collector is None:
        notes.append(f"dept sources: {reason}")
    notes.extend(f"{o.source}: failed ({o.reason})" for o in dept.outcomes if o.status == "failed")
    if collector is not None:
        skipped = Counter(o.reason or "" for o in dept.outcomes if o.status == "skipped")
        if skipped:
            notes.append(f"dept sources skipped: {_counts(skipped)}")
    if dept.dropped:
        notes.append(f"dept sources left out: {_counts(dept.dropped)}")
    if held:
        notes.append(
            f"dept sources: {len(dept.records) - len(dept_records)} copies of talks.cam talks "
            f"in unread slices held back; {len(held)} sources not swept"
        )
    notes.append(
        f"{len(merged)} talks after dedupe ({duplicates} merged"
        f"{f', {invalid} invalid' if invalid else ''})"
    )
    ctx.report.skipped += sum(cam.dropped.values()) + sum(dept.dropped.values()) + invalid
    ctx.report.metrics.update(
        talks=len(merged),
        talksCam=len(cam.records),
        talksCamMapped=cam.mapped,
        talksCamPages=cam.pages,
        deptSourcesOk=dept.count("ok"),
        deptSourcesFailed=dept.count("failed"),
        deptSourcesSkipped=dept.count("skipped"),
    )

    path = staging_path(ctx.settings.staging_dir, ctx.run.run_key)
    if merged:
        write_staging(path, merged)
        notes.append(f"staged → {STAGING_DIRECTORY}/{path.name}")

    summary = push.RunSummary(
        run_id=ctx.run.run_key,
        started_at=started_at,
        status=_run_status(cam, dept),
        sources_ok=(1 if cam.complete else 0) + dept.count("ok"),
        sources_failed=(0 if cam.complete else 1) + dept.count("failed"),
        talks_received=len(merged),
        errors=[*(f"talks_cam: {e}" for e in cam.errors)]
        + [f"{o.source}: {o.reason}" for o in dept.outcomes if o.status == "failed"],
    )
    if ctx.dry_run:
        ctx.report.inserted += len(merged)
        notes.append(f"dry run: {len(merged)} talks not posted")
        return
    _post(ctx, merged, window, sweep_sources(cam, dept, held), summary)


def _post(
    ctx: StageContext,
    records: Sequence[TalkRecord],
    window: EventWindow,
    sources: Sequence[str],
    summary: push.RunSummary,
) -> None:
    """Push in order (`talks.push`; the registry went first, in `run`); a
    failed write still posts the run summary, then fails the stage."""
    loader = ctx.loader
    run_id = ctx.run.run_key
    failure: ConvexError | None = None
    result = BatchResult("talks")
    try:
        result = push.push_talks(loader, run_id, records)
        summary.missing = push.sweep(loader, run_id, window, sources)
        ctx.report.notes.append(
            f"swept {len(sources)} sources: {summary.missing} talks no longer listed"
        )
    except ConvexError as error:
        failure = error
        summary.status = "error"
        summary.errors.append(f"push: {type(error).__name__}")
    summary.inserted, summary.updated, summary.unchanged = (
        result.inserted,
        result.updated,
        result.unchanged,
    )
    ctx.report.inserted += result.inserted
    ctx.report.updated += result.updated
    ctx.report.unchanged += result.unchanged
    ctx.report.notes.append(str(result))
    summary.finished_at = datetime.now(UTC)
    try:
        push.post_run(loader, summary)
    except ConvexError as error:
        failure = failure or error
    if failure is not None:
        raise failure


__all__ = [
    "DEPARTMENT_BUDGET",
    "SITES_MODULE",
    "DepartmentRead",
    "SiteCollector",
    "SourceOutcome",
    "hold_unread_mirrors",
    "load_site_collector",
    "read_departments",
    "run",
    "source_scope",
    "staging_path",
    "sweep_sources",
    "wire_records",
]
