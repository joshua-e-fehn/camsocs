"""Orchestration: the stage runner (Bundestracker pipeline/sync.py pattern).

Runs the ordered registry in `camsocs_pipeline.stages` (`STAGES`)::

    seed → harvest → resolve → enrich → events → inbox → load → report

Each stage runs inside `_guard`, which records a failure on the stage's report
instead of ending the run: one source being down must not cost the others. A
stage whose `requires` include a stage that *failed in this run* is reported
`not_run` instead (e.g. `load` after a failed `resolve`), rather than
producing a cascade of errors that buries the cause.

A **group** (`camsocs sync --group events|full`, `stages.GROUPS`) names the
stages one scheduled run executes. Before a group runs, `group_inputs` checks
that what it reads from earlier runs is on disk (`StageGroup.needs`): a daily
events run on a host that never ran the full harvest stops with that message
instead of succeeding with nothing.

A real run is bracketed by the run log in Convex: `health()` first (a rotated
key is one clean 401 before any work), then `runs.start`, the stages, and
`runs.finish` with per-stage results — the server derives the run status. A
`--dry-run` makes no network writes and needs no credentials: the loader
serialises payloads and discards them, and no run row or state file is written.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable, Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path

from camsocs_pipeline import __version__
from camsocs_pipeline.config import Settings
from camsocs_pipeline.pipeline.context import Stage, StageContext, StageFn, StageGroup
from camsocs_pipeline.pipeline.load import ConvexError, ConvexLoader
from camsocs_pipeline.pipeline.report import RunReport, StageReport, mint_run_key
from camsocs_pipeline.pipeline.state import SyncState, load_state, save_state
from camsocs_pipeline.stages import GROUPS, STAGES
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


def resolve_group(name: str, groups: Mapping[str, StageGroup] | None = None) -> StageGroup:
    """The group called `name`; an unknown name is an error, like an unknown stage."""
    groups = GROUPS if groups is None else groups
    group = groups.get(name)
    if group is None:
        raise ValueError(f"Unknown group: {name}. Known: {', '.join(sorted(groups))}.")
    return group


#: A staging file's name starts with its run key, `20261007T215500Z-3f9a1c`.
_RUN_KEY_TIME = re.compile(r"^(\d{8}T\d{6}Z)")


def staged_at(path: Path) -> datetime:
    """When a staging file was written: its run key's time, else its mtime."""
    match = _RUN_KEY_TIME.match(path.name)
    if match:
        return datetime.strptime(match.group(1), "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC)
    return datetime.fromtimestamp(path.stat().st_mtime, UTC)


def group_inputs(
    group: StageGroup, staging: StagingStore, now: datetime | None = None
) -> list[str]:
    """Check what `group` reads from earlier runs (`StageGroup.needs`).

    Raises `ValueError` naming every missing staging directory, before any
    request. Returns warnings for directories older than `stale_after`."""
    now = now or datetime.now(UTC)
    missing: list[str] = []
    warnings: list[str] = []
    for directory in group.needs:
        paths = staging.latest_paths(directory)
        if not paths:
            missing.append(directory)
            continue
        newest = max(staged_at(path) for path in paths)
        if group.stale_after is not None and now - newest > group.stale_after:
            days = (now - newest).days
            warnings.append(
                f"{directory} was last staged {days} days ago ({newest:%Y-%m-%d}); "
                "the full group has not refreshed it since"
            )
    if missing:
        raise ValueError(
            f"The {group.name} group reads what the full group stages, and "
            f"{staging.root} holds no {', '.join(missing)} yet. Run "
            "`camsocs sync --group full` (pixi run harvest) first."
        )
    return warnings


def run_sync(
    *,
    settings: Settings,
    stages: Sequence[str] | None = None,
    group: StageGroup | None = None,
    dry_run: bool = False,
    limit: int | None = None,
    loader: ConvexLoader | None = None,
    registry: Sequence[Stage] | None = None,
    now: datetime | None = None,
) -> RunReport:
    """Run the requested stages — or `group`'s, never both — and return the
    report. Raises `ConfigError` / `ConvexError` / `ValueError` only for
    failures before any stage ran (config, a group's missing inputs, health,
    `runs.start`); stage failures are recorded on the report instead."""
    if group is not None and stages:
        raise ValueError("Give --stages or --group, not both.")
    if group is not None:
        selected = resolve_stages(group.stages or None, registry)
        warnings = group_inputs(group, StagingStore(settings.staging_dir), now)
        command = f"sync --group {group.name}"
    else:
        selected = resolve_stages(stages, registry)
        warnings = []
        command = "sync"
    report = RunReport(run_key=mint_run_key(now), command=command, dry_run=dry_run)
    report.warnings.extend(warnings)
    for warning in warnings:
        logger.warning("%s", warning)
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
                command=report.command,
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
    "GROUPS",
    "STAGES",
    "STAGE_ORDER",
    "Stage",
    "StageContext",
    "StageFn",
    "StageGroup",
    "group_inputs",
    "resolve_group",
    "resolve_stages",
    "run_sync",
    "staged_at",
]
