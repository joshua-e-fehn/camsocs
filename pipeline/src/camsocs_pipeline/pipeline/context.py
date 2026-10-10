"""What a stage is and what it may use — the contract every stage module codes
against (`camsocs_pipeline.stages`), kept apart from the runner (`sync.py`) so
stage modules and the registry import it without an import cycle.
"""

from __future__ import annotations

import importlib
from collections.abc import Callable
from dataclasses import dataclass
from datetime import timedelta

from camsocs_pipeline.config import Settings
from camsocs_pipeline.pipeline.load import ConvexLoader
from camsocs_pipeline.pipeline.report import RunReport, StageReport
from camsocs_pipeline.pipeline.state import SyncState
from camsocs_pipeline.sources.base import PoliteClient
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
    - fetch through `crawler()` (robots.txt, per-host pacing, cache);
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

    def crawler(self) -> PoliteClient:
        """The polite HTTP client (sources/base.py) configured from settings;
        use it as a context manager. A real run requires an honest User-Agent;
        a dry run needs none, because a harvest stage then reads only the
        cache (`PoliteClient.cached`) and makes no request."""
        user_agent = (
            self.settings.user_agent or "camsocs-dry-run"
            if self.dry_run
            else self.settings.require_user_agent()
        )
        return PoliteClient(
            user_agent=user_agent,
            cache_dir=self.settings.cache_dir,
            min_interval=self.settings.min_host_interval,
        )


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

    `fetches`: the stage reads public sources over the network (through the
    polite client), even in a dry run — a dry run writes nothing, but it still
    reads. Offline tests of the runner leave these stages out.
    """

    name: str
    fn: StageFn | None = None
    requires: tuple[str, ...] = ()
    description: str = ""
    fetches: bool = False

    def __post_init__(self) -> None:
        if not self.name.isidentifier():
            raise ValueError(f"Stage names are module names: {self.name!r}")

    def resolve(self) -> StageFn:
        if self.fn is not None:
            return self.fn
        module = importlib.import_module(f"camsocs_pipeline.stages.{self.name}")
        return module.run


@dataclass(frozen=True)
class StageGroup:
    """A named set of registry stages that one scheduled run executes
    (`camsocs sync --group <name>`; `camsocs_pipeline.stages.GROUPS`).

    `stages`: the registry stages it runs, always in registry order; empty
    means every stage.

    `needs`: staging directories the group reads but no stage of it writes —
    what an earlier run of the full group left on disk (the resolver's
    ``_resolved``, enrichment's ``society_website``, the SU profiles). When one
    is missing the run stops before any request: a daily run with no known
    organisations would stage nothing and still report success.

    `stale_after`: when the newest file of a needed directory is older than
    this, the run goes ahead but carries a warning (the weekly full run has
    not refreshed what it reads).

    `derive`: after a real run, ask the deployment to re-derive statuses,
    term weeks and stale flags (what the clock alone changes).
    """

    name: str
    stages: tuple[str, ...] = ()
    needs: tuple[str, ...] = ()
    stale_after: timedelta | None = None
    derive: bool = False
    description: str = ""

    def __post_init__(self) -> None:
        if not self.name.isidentifier():
            raise ValueError(f"Group names are identifiers: {self.name!r}")


__all__ = ["Stage", "StageContext", "StageFn", "StageGroup"]
