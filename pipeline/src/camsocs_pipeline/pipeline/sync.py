"""Orchestration: the stage runner (Bundestracker pipeline/sync.py pattern).

Runs the ordered registry in `camsocs_pipeline.stages` (`STAGES`)::

    seed → harvest → resolve → enrich → events → inbox → load → report

Each stage runs inside `_guard`, which records a failure on the stage's report
instead of ending the run: one source being down must not cost the others. A
stage whose `requires` include a stage that *failed in this run* is reported
`not_run` instead (e.g. `load` after a failed `resolve`), rather than
producing a cascade of errors that buries the cause.

A real run is bracketed by the run log in Convex: `health()` first (a rotated
key is one clean 401 before any work), then `runs.start`, the stages, and
`runs.finish` with per-stage results — the server derives the run status. A
`--dry-run` makes no network writes and needs no credentials: the loader
serialises payloads and discards them, and no run row or state file is written.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Sequence
from datetime import datetime

from camsocs_pipeline import __version__
from camsocs_pipeline.config import Settings
from camsocs_pipeline.pipeline.context import Stage, StageContext, StageFn
from camsocs_pipeline.pipeline.load import ConvexError, ConvexLoader
from camsocs_pipeline.pipeline.report import RunReport, StageReport, mint_run_key
from camsocs_pipeline.pipeline.state import SyncState, load_state, save_state
from camsocs_pipeline.stages import STAGES
from camsocs_pipeline.staging.store import StagingStore

logger = logging.getLogger(__name__)

#: Canonical order of the registered stages. A subset requested with
#: `--stages` still runs in this order.
STAGE_ORDER: tuple[str, ...] = tuple(stage.name for stage in STAGES)


def resolve_stages(
    requested: Sequence[str] | None, registry: Sequence[Stage] | None = None
) -> list[Stage]:
    """The stages to run, in registry order. Unknown names are an error, not
    a silent no-op — a typo in a cron line should fail loudly."""
    registry = STAGES if registry is None else registry
    names = [stage.name for stage in registry]
    if len(set(names)) != len(names):
        raise ValueError(f"Duplicate stage names in the registry: {names}")
    if not requested:
        return list(registry)
    unknown = sorted({name for name in requested if name not in names})
    if unknown:
        raise ValueError(f"Unknown stage(s): {', '.join(unknown)}. Known: {', '.join(names)}.")
    wanted = set(requested)
    return [stage for stage in registry if stage.name in wanted]


def run_sync(
    *,
    settings: Settings,
    stages: Sequence[str] | None = None,
    dry_run: bool = False,
    limit: int | None = None,
    loader: ConvexLoader | None = None,
    registry: Sequence[Stage] | None = None,
    now: datetime | None = None,
) -> RunReport:
    """Run the requested stages and return the report. Raises `ConfigError` /
    `ConvexError` only for failures before any stage ran (config, health,
    `runs.start`); stage failures are recorded on the report instead."""
    selected = resolve_stages(stages, registry)
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
                report.run_key,
                command="sync",
                stages=[stage.name for stage in selected],
                pipeline_version=__version__,
            )

        _run_stages(selected, report, settings, loader, state, limit)

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
    stages: Sequence[Stage],
    report: RunReport,
    settings: Settings,
    loader: ConvexLoader,
    state: SyncState,
    limit: int | None,
) -> None:
    staging = StagingStore(settings.staging_dir)
    failed: set[str] = set()
    for stage in stages:
        stage_report = report.stage(stage.name)
        blockers = [name for name in stage.requires if name in failed]
        if blockers:
            stage_report.status = "not_run"
            stage_report.notes.append(f"skipped: {', '.join(blockers)} failed")
            continue
        context = StageContext(
            settings=settings,
            report=stage_report,
            run=report,
            loader=loader,
            state=state,
            staging=staging,
            dry_run=loader.dry_run,
            limit=limit,
        )
        _guard(stage_report, lambda stage=stage, ctx=context: stage.resolve()(ctx))
        if not stage_report.ok:
            failed.add(stage.name)


def _guard(stage_report: StageReport, body: Callable[[], None]) -> None:
    """Run a stage, recording a failure instead of ending the run. Broad on
    purpose: stages are independent unless they declare `requires`."""
    try:
        body()
    except Exception as error:
        logger.exception("Stage %s failed", stage_report.name)
        stage_report.fail(f"{type(error).__name__}: {error}")


__all__ = [
    "STAGES",
    "STAGE_ORDER",
    "Stage",
    "StageContext",
    "StageFn",
    "resolve_stages",
    "run_sync",
]
