"""Orchestration: the stage runner (Bundestracker pipeline/sync.py pattern).

    discover → fetch → parse → extract → resolve → load

Each stage runs inside `_guard`, which records a failure on the stage's report
instead of ending the run: one source being down must not cost the others. The
exception is a **gating** stage (`discover`): without a source list there is
nothing for later stages to work on, so a failed `discover` marks the rest
`not_run` rather than producing a cascade of errors that buries the cause.

A real run is bracketed by the run log in Convex: `health()` first (a rotated
key is one clean 401 before any work), then `runs.start`, the stages, and
`runs.finish` with per-stage results — the server derives the run status. A
`--dry-run` makes no network writes and needs no credentials: the loader
serialises payloads and discards them, and no run row or state file is written.

The stages are scaffolds for now: each reports "not implemented yet" and does
nothing, so the plumbing (CLI → stages → report → run log → exit code) is real
and tested before any harvester lands. Implement a stage by replacing its
entry in `STAGES`; the contract is `StageFn` below.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime

from camsocs_pipeline import __version__
from camsocs_pipeline.config import Settings
from camsocs_pipeline.pipeline.load import ConvexError, ConvexLoader
from camsocs_pipeline.pipeline.report import RunReport, StageReport, mint_run_key
from camsocs_pipeline.pipeline.state import SyncState, load_state, save_state

logger = logging.getLogger(__name__)

#: Canonical order. A subset requested with `--stages` still runs in this order.
STAGE_ORDER: tuple[str, ...] = ("discover", "fetch", "parse", "extract", "resolve", "load")

#: Stages whose failure makes every later stage pointless.
GATING_STAGES = frozenset({"discover"})


@dataclass
class StageContext:
    """Everything a stage may use. A stage writes its counts and notes to
    `report`, reads/writes `state`, and posts through `loader` (which is a
    no-op in a dry run)."""

    settings: Settings
    report: StageReport
    run: RunReport
    loader: ConvexLoader
    state: SyncState
    dry_run: bool
    #: Process at most this many items (sources, pages, claims) — for trial runs.
    limit: int | None


StageFn = Callable[[StageContext], None]


def _scaffold(purpose: str) -> StageFn:
    def stage(ctx: StageContext) -> None:
        ctx.report.notes.append(f"not implemented yet ({purpose})")

    return stage


STAGES: dict[str, StageFn] = {
    "discover": _scaffold("seed lists → sources registry"),
    "fetch": _scaffold("polite fetch of registered sources into var/cache"),
    "parse": _scaffold("deterministic rules: mailto, socials, JSON-LD, iCal"),
    "extract": _scaffold("LLM over cached text, verbatim-evidence checked"),
    "resolve": _scaffold("stable keys, crosswalk, quarantine for ambiguous names"),
    "load": _scaffold("upsert entities and claims into Convex"),
}


def resolve_stages(
    requested: Sequence[str] | None, registry: Mapping[str, StageFn] | None = None
) -> list[str]:
    """The stages to run, in canonical order. Unknown names are an error, not
    a silent no-op — a typo in a cron line should fail loudly."""
    registry = STAGES if registry is None else registry
    order = [name for name in STAGE_ORDER if name in registry] + [
        name for name in registry if name not in STAGE_ORDER
    ]
    if not requested:
        return order
    unknown = sorted({name for name in requested if name not in registry})
    if unknown:
        raise ValueError(f"Unknown stage(s): {', '.join(unknown)}. Known: {', '.join(order)}.")
    wanted = set(requested)
    return [name for name in order if name in wanted]


def run_sync(
    *,
    settings: Settings,
    stages: Sequence[str] | None = None,
    dry_run: bool = False,
    limit: int | None = None,
    loader: ConvexLoader | None = None,
    registry: Mapping[str, StageFn] | None = None,
    now: datetime | None = None,
) -> RunReport:
    """Run the requested stages and return the report. Raises `ConfigError` /
    `ConvexError` only for failures before any stage ran (config, health,
    `runs.start`); stage failures are recorded on the report instead."""
    registry = STAGES if registry is None else registry
    names = resolve_stages(stages, registry)
    report = RunReport(run_key=mint_run_key(now), command="sync", dry_run=dry_run)
    state = load_state(settings.state_path)

    owned = loader is None
    if loader is None:
        loader = (
            ConvexLoader("", "", dry_run=True)
            if dry_run
            else ConvexLoader(
                settings.require_convex_http_url(), settings.require_pipeline_api_key()
            )
        )

    try:
        if not loader.dry_run:
            if not loader.health():
                raise ConvexError("GET /api/pipeline/health did not answer ok")
            loader.start_run(
                report.run_key, command="sync", stages=names, pipeline_version=__version__
            )

        _run_stages(names, registry, report, settings, loader, state, limit)

        if not loader.dry_run:
            try:
                loader.finish_run(report.to_finish_payload())
            except ConvexError as error:
                # The stages' work is committed; the run row stays "running" in
                # Convex, which is itself evidence. Still a failed run locally.
                report.error = f"runs.finish failed: {error}"
                logger.error("%s", report.error)
    finally:
        if not loader.dry_run:
            state.record_run(report.run_key, report.ok, [s.name for s in report.stages if s.ok])
            save_state(settings.state_path, state)
        if owned:
            loader.close()

    return report


def _run_stages(
    names: Sequence[str],
    registry: Mapping[str, StageFn],
    report: RunReport,
    settings: Settings,
    loader: ConvexLoader,
    state: SyncState,
    limit: int | None,
) -> None:
    gate_failed: str | None = None
    for name in names:
        stage_report = report.stage(name)
        if gate_failed is not None:
            stage_report.status = "not_run"
            stage_report.notes.append(f"skipped: {gate_failed} failed")
            continue
        context = StageContext(
            settings=settings,
            report=stage_report,
            run=report,
            loader=loader,
            state=state,
            dry_run=loader.dry_run,
            limit=limit,
        )
        _guard(stage_report, lambda fn=registry[name], ctx=context: fn(ctx))
        if not stage_report.ok and name in GATING_STAGES:
            gate_failed = name


def _guard(stage_report: StageReport, body: Callable[[], None]) -> None:
    """Run a stage, recording a failure instead of ending the run. Broad on
    purpose: the stages after the gate are independent of each other."""
    try:
        body()
    except Exception as error:
        logger.exception("Stage %s failed", stage_report.name)
        stage_report.fail(f"{type(error).__name__}: {error}")


__all__ = ["GATING_STAGES", "STAGES", "STAGE_ORDER", "StageContext", "resolve_stages", "run_sync"]
