"""What a stage is and what it may use — the contract every stage module codes
against (`camsocs_pipeline.stages`), kept apart from the runner (`sync.py`) so
stage modules and the registry import it without an import cycle.
"""

from __future__ import annotations

import importlib
from collections.abc import Callable
from dataclasses import dataclass

from camsocs_pipeline.config import Settings
from camsocs_pipeline.pipeline.load import ConvexLoader
from camsocs_pipeline.pipeline.report import RunReport, StageReport
from camsocs_pipeline.pipeline.state import SyncState
from camsocs_pipeline.staging.store import StagingStore


@dataclass
class StageContext:
    """Everything a stage may use.

    - write counts and notes to `report` (`inserted` / `updated` /
      `unchanged` / `skipped`, `notes` for anything a reader should see);
    - read and write `state` for watermarks between runs;
    - stage observations through `staging` (harvest stages write only there,
      under ``run.run_key``);
    - post through `loader`, which is a no-op in a dry run;
    - honour `limit` (process at most this many items) for trial runs.
    """

    settings: Settings
    report: StageReport
    run: RunReport
    loader: ConvexLoader
    state: SyncState
    staging: StagingStore
    dry_run: bool
    limit: int | None


StageFn = Callable[[StageContext], None]


@dataclass(frozen=True)
class Stage:
    """One entry of the ordered registry (`camsocs_pipeline.stages.STAGES`).

    `fn` defaults to ``run`` in the module ``camsocs_pipeline.stages.<name>``,
    imported only when the stage runs — so the registry needs no import line
    per stage (parallel branches would conflict on it), and a stage whose
    module fails to import fails alone instead of breaking every run.

    `requires`: stages whose *failure in this run* makes this one pointless —
    it is then reported `not_run` instead of running on stale or half input
    (e.g. `load` requires `resolve`). A required stage that was not requested
    does not block: the input from its last successful run is on disk.
    """

    name: str
    fn: StageFn | None = None
    requires: tuple[str, ...] = ()
    description: str = ""

    def __post_init__(self) -> None:
        if not self.name.isidentifier():
            raise ValueError(f"Stage names are module names: {self.name!r}")

    def resolve(self) -> StageFn:
        if self.fn is not None:
            return self.fn
        module = importlib.import_module(f"camsocs_pipeline.stages.{self.name}")
        return module.run


__all__ = ["Stage", "StageContext", "StageFn"]
