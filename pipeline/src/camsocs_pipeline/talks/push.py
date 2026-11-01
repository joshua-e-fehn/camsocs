"""Talks → Convex over the pipeline's ingestion API
(docs/talks-redesign-spec.md §4; all ``POST /api/pipeline/…``, Bearer
``PIPELINE_API_KEY``, through `pipeline.load.ConvexLoader`: the same URL,
key, retries and dry-run behaviour as every other route).

=====================  ============================================  ==========
path                   body                                          cap
=====================  ============================================  ==========
talks/departments      ``{departments: Department[]}``               500 a call
talks/batch            ``{runId, talks: TalkWire[]}``                200 a call
talks/sweep            ``{runId, from, to, sources: string[]}``      —
talks/runs             the run summary (`RunSummary.to_wire`)        —
=====================  ============================================  ==========

Order matters: the registry first (talks name their departments), then every
batch, then the sweep — which marks a source's rows in the window that this
run did not post as ``missing``, so it runs only after every batch landed, and
only for the sources read completely. A failed batch means no sweep (a row
this run never reached would look unlisted). The run summary goes last, and
also when something before it failed.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal

from camsocs_pipeline.events.common import EventWindow
from camsocs_pipeline.pipeline.load import BatchResult, ConvexLoader
from camsocs_pipeline.talks.model import TalkRecord, ms
from camsocs_pipeline.talks.registry import Department

logger = logging.getLogger(__name__)

#: Talks per `talks/batch` call; the server refuses more (spec §4).
TALKS_BATCH = 200
#: Departments per `talks/departments` call.
DEPARTMENTS_BATCH = 500

RunStatus = Literal["ok", "partial", "error"]


def push_departments(loader: ConvexLoader, departments: Sequence[Department]) -> BatchResult:
    return loader.post_batches(
        "talks/departments",
        "departments",
        [dept.to_wire() for dept in departments],
        batch_size=DEPARTMENTS_BATCH,
    )


def push_talks(loader: ConvexLoader, run_id: str, records: Sequence[TalkRecord]) -> BatchResult:
    return loader.post_batches(
        "talks/batch",
        "talks",
        [record.to_wire() for record in records],
        unit="talks",
        batch_size=TALKS_BATCH,
        extra={"runId": run_id},
    )


MAX_SWEEP_CALLS = 50


def sweep(loader: ConvexLoader, run_id: str, window: EventWindow, sources: Sequence[str]) -> int:
    """Mark the unlisted talks of `sources` in the window missing; returns how
    many. No sources, no request."""
    if not sources:
        return 0
    body: dict[str, object] = {
        "runId": run_id,
        "from": ms(window.start),
        "to": ms(window.end),
        "sources": sorted(dict.fromkeys(sources)),
    }
    total = 0
    # The server loops internally and normally answers ``done: true``; when it
    # stops early it hands back a cursor to resume from (convex/http.ts).
    for _ in range(MAX_SWEEP_CALLS):
        response = loader.post("talks/sweep", body)
        missing = response.get("missing", 0)
        if isinstance(missing, int) and not isinstance(missing, bool):
            total += missing
        cursor = response.get("cursor")
        if response.get("done", True) or not cursor:
            return total
        body = {**body, "cursor": cursor}
    raise RuntimeError(f"talks/sweep did not finish within {MAX_SWEEP_CALLS} calls")


@dataclass
class RunSummary:
    """The `talkRuns` row (spec §4). Errors are counts, ids and statuses."""

    run_id: str
    started_at: datetime
    finished_at: datetime | None = None
    status: RunStatus = "ok"
    sources_ok: int = 0
    sources_failed: int = 0
    talks_received: int = 0
    inserted: int = 0
    updated: int = 0
    unchanged: int = 0
    missing: int = 0
    errors: list[str] = field(default_factory=list)

    def to_wire(self) -> dict[str, Any]:
        return {
            "runId": self.run_id,
            "status": self.status,
            "startedAt": ms(self.started_at),
            "finishedAt": ms(self.finished_at or self.started_at),
            "sourcesOk": self.sources_ok,
            "sourcesFailed": self.sources_failed,
            "talksReceived": self.talks_received,
            "inserted": self.inserted,
            "updated": self.updated,
            "unchanged": self.unchanged,
            "missing": self.missing,
            "errors": list(self.errors),
        }


def post_run(loader: ConvexLoader, summary: RunSummary) -> None:
    loader.post("talks/runs", summary.to_wire())


__all__ = [
    "DEPARTMENTS_BATCH",
    "TALKS_BATCH",
    "RunSummary",
    "post_run",
    "push_departments",
    "push_talks",
    "sweep",
]
