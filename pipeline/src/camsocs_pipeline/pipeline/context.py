"""What a stage is and what it may use — the contract every stage module codes
against (`camsocs_pipeline.stages`), kept apart from the runner (`sync.py`) so
stage modules and the registry import it without an import cycle.
"""

from __future__ import annotations

import importlib
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import timedelta
from typing import TYPE_CHECKING, Literal, get_args

from camsocs_pipeline.config import Settings
from camsocs_pipeline.pipeline.load import ConvexLoader
from camsocs_pipeline.pipeline.report import RunReport, StageReport
from camsocs_pipeline.pipeline.state import SyncState
from camsocs_pipeline.sources.base import PoliteClient
from camsocs_pipeline.staging.store import StagingStore

if TYPE_CHECKING:
    # campuses/ imports this module (a profile carries its stages), so the
    # profile type is for annotations only and the default is read lazily.
    from camsocs_pipeline.campuses.profile import CampusProfile

#: The registry's phases, in run order (`stages/__init__.py`). Every stage
#: names its phase; the registry lists them in this order.
Phase = Literal[
    "seed", "harvest", "resolve", "enrich", "classify", "events", "inbox", "load", "talks", "report"
]
PHASES: tuple[str, ...] = get_args(Phase)

#: The three pillars a stage feeds (Societies / Events / Talks), or `shared`
#: for a stage that serves all of them (decision D8). Tenancy never merges them.
Pillar = Literal["societies", "events", "talks", "shared"]
PILLARS: tuple[str, ...] = get_args(Pillar)

#: `reads` / `writes` entries that name no one staging directory: the
#: organisation lookup (``_resolved`` and the crosswalk), the index of staged
#: events, and every source directory at once. They start with ``@``.
SELECTORS: tuple[str, ...] = ("@org_lookup", "@event_index", "@all_observations")


def _active_profile() -> CampusProfile:
    from camsocs_pipeline import campuses

    return campuses.active()


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
    - honour `limit` (process at most this many items) for trial runs;
    - honour `only_orgs` where it is meaningful: a run for these
      organisations only (a confirmed listing request's job, ENG-158), which
      must leave every other organisation's staged work as it is;
    - read campus facts (term dates, decisions file…) from `profile`, the
      campus this run belongs to (`campuses.active()`, decision D8).
    """

    settings: Settings
    report: StageReport
    run: RunReport
    loader: ConvexLoader
    state: SyncState
    staging: StagingStore
    dry_run: bool
    limit: int | None
    profile: CampusProfile = field(default_factory=_active_profile)
    only_orgs: frozenset[str] | None = None

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

    What the stage is, for the registry's readers (the pipeline graph, the
    staging guard, the run log); none of it changes how it runs:

    - `phase` (`PHASES`) and `pillar` (`PILLARS`); every registry entry sets
      both explicitly;
    - `campus`: the campus whose sources it reads (``"cam"``), or `None` for
      an engine stage every campus runs;
    - `module`: the module whose ``run`` it calls, when that is not
      ``camsocs_pipeline.stages.<name>``;
    - `reads` / `writes`: staging directories (a source type, its
      ``<type>.events`` directory, ``_resolved``, the talks pillar's
      ``talks``) or `SELECTORS`;
    - `sinks`: the Convex routes it calls on a real run, by their exact names
      in ``webapp/convex/http.ts`` (``termDates``, ``claims``, and the routes
      it reads back from, ``crosswalk``…);
    - `network`: it uses the network for real, a robots.txt check included
      (`fetches` keeps its dry-run meaning); `llm`: it may ask a model;
    - `docs`: where its rules are written, ``"source-research§1"``.
    """

    name: str
    fn: StageFn | None = None
    requires: tuple[str, ...] = ()
    description: str = ""
    fetches: bool = False
    phase: Phase = "harvest"
    pillar: Pillar = "shared"
    campus: str | None = None
    module: str | None = None
    reads: tuple[str, ...] = ()
    writes: tuple[str, ...] = ()
    sinks: tuple[str, ...] = ()
    network: bool = False
    llm: bool = False
    docs: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if not self.name.isidentifier():
            raise ValueError(f"Stage names are module names: {self.name!r}")
        if self.phase not in PHASES:
            raise ValueError(f"Stage {self.name}: unknown phase {self.phase!r}")
        if self.pillar not in PILLARS:
            raise ValueError(f"Stage {self.name}: unknown pillar {self.pillar!r}")

    def resolve(self) -> StageFn:
        if self.fn is not None:
            return self.fn
        module = importlib.import_module(self.module or f"camsocs_pipeline.stages.{self.name}")
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

    def members(self, registry: Sequence[Stage]) -> list[Stage]:
        """The registry stages this group runs, in registry order."""
        if not self.stages:
            return list(registry)
        wanted = set(self.stages)
        return [stage for stage in registry if stage.name in wanted]

    def derived_needs(self, registry: Sequence[Stage]) -> frozenset[str]:
        """What the group's stages read that none of them writes (selectors
        aside): the directories an earlier run must have left. `needs` must
        cover it (tests/test_stage_metadata.py)."""
        members = self.members(registry)
        reads = {name for stage in members for name in stage.reads}
        writes = {name for stage in members for name in stage.writes}
        return frozenset(name for name in reads - writes if name not in SELECTORS)


__all__ = [
    "PHASES",
    "PILLARS",
    "SELECTORS",
    "Phase",
    "Pillar",
    "Stage",
    "StageContext",
    "StageFn",
    "StageGroup",
]
