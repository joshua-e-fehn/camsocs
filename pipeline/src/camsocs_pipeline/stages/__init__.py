"""The ordered stage registry — the one list `sync` runs.

    seed → harvest → resolve → enrich → classify → events → inbox → load → talks → report

(`PHASES` in `pipeline/context.py`; the talks pillar's `talks` stage runs after
`load`, which posts the other two pillars.)

Each entry also says what it is (decision D8): its `phase`, its `pillar`
(societies / events / talks, or shared), its `campus` (``"cam"`` for a
Cambridge source, `None` for an engine stage every campus runs: `ENGINE`),
what it reads and writes in staging, the Convex routes it posts to, whether
it uses the network or a model, and the docs § that governs it. `registry`
and `groups` give a campus its stages and scheduled runs; Cambridge's are
`STAGES` and `GROUPS` themselves.

## Convention for adding a stage (parallel agents: read this)

1. Write ``camsocs_pipeline/stages/<name>.py`` exposing ``run(ctx: StageContext)``
   (`pipeline/context.py`); the stage name *is* the module name, imported
   when the stage runs. Put source-specific code (parsers, fetch helpers)
   under ``camsocs_pipeline/sources/<name>/`` or next to the stage.
2. **Harvest and enrichment stages only write observations** to staging
   (``with ctx.staging.writer(<source_type>, ctx.run.run_key, ctx.report.name)
   as out: …``, `models/observation.py`) — pass your stage name as the part,
   so a stage sharing a source type with another (Camdram societies and
   Camdram events) never overwrites or hides its files; `sources/observe.py`
   `run_harvest` does all of this for a harvest function. They never call
   the loader and never mint organisation keys; `resolve` assigns keys and
   `load` posts.
3. Add **one entry** below, in its phase, with a comment line above it.
   There is no import to add. The entries are separated by comment lines on
   purpose, so two branches that each add their own merge without conflict.
4. Every entry states, explicitly (tests/test_stage_metadata.py checks them):

   - ``phase=`` — its place in the order above; the registry is in phase order;
   - ``pillar=`` — ``"societies"``, ``"events"``, ``"talks"`` or ``"shared"``;
     the pillars stay distinct;
   - ``campus=`` — ``"cam"`` for a Cambridge source; leave it `None` only for
     an engine stage that reads no campus-specific source;
   - ``reads=`` / ``writes=`` — its staging directories (a source type,
     ``<type>.events``, ``_resolved``) or selectors (``@org_lookup``,
     ``@event_index``, ``@all_observations``); a group's `needs` must cover
     what its stages read and none of them writes;
   - ``docs=`` — the governing ``"source-research§N"``;
   - and, when true, ``network=True`` (real network use, a robots.txt check
     included), ``llm=True`` and ``sinks=``: every ``/api/pipeline/<route>``
     it calls on a real run, by its exact route name in
     ``webapp/convex/http.ts`` (``claims``, ``inbound/mark``…), the routes it
     reads back from (``crosswalk``, ``suppressions``…) included; the graph
     tells the two apart (`graph.READ_ROUTES`).
5. A stage that reads public sources says ``fetches=True`` (offline runner
   tests leave it out). Order matters only *between* phases; within the harvest phase, stages are
   independent. Use ``requires=(...)`` only when your stage cannot run on the
   previous run's output of another stage.
6. Cite your `docs/source-research.md` § in the comment and in the module
   docstring; re-verify the § live before writing the harvester.

A stage that is commented out does not exist for `sync` (not even as "not
run"), so a half-built stage never fails a cron run.

## Groups: what a scheduled run executes (decision D5, docs/ops-vps.md)

`camsocs sync --group <name>` runs one entry of `GROUPS` (the registry order
still holds):

- ``full`` — every stage, then the server's re-derivation; weekly
  (`pixi run harvest`, the VPS's Sunday timer).
- ``talks`` — the `talks` stage alone, for a run by hand (`sync --group
  talks`); the daily group runs it too.
- ``events`` — the day's events; daily (`pixi run harvest-events`, the VPS's
  04:30 timer). It harvests no organisation itself, so it reads what the
  last full run left in `var/staging` and `var/cache`:

  - term_dates, report: nothing earlier runs left;
  - camdram_events, cucbc_events, playwaze, uni_events: the organisations
    to name as organisers — resolve (``_resolved``) and the crosswalk;
  - talks_cam, calendar_feeds: talks.cam lists and ICS / Google / Luma
    feeds — the SU profiles (keyed in ``_resolved``), enrichment
    (``society_website``, ``linktree``) and `events/seeds.py`;
  - su_whatson: the SU profiles' own event lists — su_directory
    (``su_profile`` and its cached pages);
  - website_events: the sites enrichment read (``society_website`` and its
    cached pages);
  - termcards, instagram, inbox: termcard URLs, Instagram handles, lists,
    addresses and domains — su_directory, resolve and enrich;
  - talks: nothing earlier runs left (the department registry is in the
    repo); it posts its own tables (`talks/*`, decision D7) rather than
    through load. It is in the daily group because talks change daily
    (cancellations, new dates) and the VPS timers run only ``events`` and
    ``full``. It runs after load, so a slow talks.cam day can only delay
    its own tables, never the day's events. Its run time is bounded: talks.cam at most
    `talkscam.MAX_TOTAL_PAGES` pages at Crawl-delay 10 (20 minutes; a normal
    day is a few minutes) and `talkscam.READ_BUDGET` (30 minutes, for timeouts
    and retries) plus the slice in flight, the department sites
    `stage.DEPARTMENT_BUDGET` (20 minutes) plus the source in flight — about an
    hour in the worst case, inside the 2-hour limit.
  - load: the latest file of every staging directory.

  So it ``needs`` ``_resolved``, ``society_website`` and ``su_profile``: a
  host where they were never staged stops before any request, with "run the
  full group first", instead of staging nothing and succeeding
  (website_events would only note "run enrich first"). Older than eight days
  (the weekly run failed), they still serve, with a run warning. Re-posting
  the full run's observations is a no-op on the server — each claim's
  sighting is the `retrievedAt` it carries, so nothing looks fresher than
  it is.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import timedelta
from typing import TYPE_CHECKING

from camsocs_pipeline.pipeline.context import PHASES, Stage, StageGroup
from camsocs_pipeline.staging.store import RESOLVED, TALKS

if TYPE_CHECKING:
    from camsocs_pipeline.campuses.profile import CampusProfile

#: Every source directory, at once (resolve, classify, load).
_ALL = "@all_observations"
#: The organisations known so far: ``_resolved`` and the crosswalk.
_ORGS = "@org_lookup"
#: The events already staged (the inbox and termcards match against them).
_EVENTS = "@event_index"

STAGES: list[Stage] = [
    # ── seed ─────────────────────────────────────────────────────────────────
    # Full Term dates, verified (source-research §19).
    Stage(
        "term_dates",
        description="Full Term dates → termDates",
        phase="seed",
        pillar="shared",
        sinks=("termDates",),
        docs=("source-research§19",),
    ),
    #
    # ── harvest (T3): who exists — each writes var/staging/<source_type>/ ──────
    # SU Find a Society directory + profiles (§1).
    Stage(
        "su_directory",
        description="SU directory + every profile → staging",
        phase="harvest",
        pillar="societies",
        campus="cam",
        writes=("su_directory", "su_profile"),
        network=True,
        docs=("source-research§1",),
    ),
    #
    # Proctors' register (§2).
    Stage(
        "proctors_register",
        description="Proctors' register → staging",
        phase="harvest",
        pillar="societies",
        campus="cam",
        writes=("proctors_register",),
        network=True,
        docs=("source-research§2",),
    ),
    #
    # Sport Cambridge A–Z + club pages (§3).
    Stage(
        "sport_clubs",
        phase="harvest",
        pillar="societies",
        campus="cam",
        writes=("sport_az", "sport_club_page"),
        network=True,
        docs=("source-research§3",),
    ),
    #
    # Sports Club Guide 2026-27 PDF (§4).
    Stage(
        "sport_guide_pdf",
        phase="harvest",
        pillar="societies",
        campus="cam",
        reads=("sport_club_page",),
        writes=("sport_guide_pdf",),
        network=True,
        docs=("source-research§4",),
    ),
    #
    # Camdram societies (§5).
    Stage(
        "camdram_societies",
        phase="harvest",
        pillar="societies",
        campus="cam",
        writes=("camdram",),
        network=True,
        docs=("source-research§5",),
    ),
    #
    # CUCBC clubs (§7).
    Stage(
        "cucbc_clubs",
        phase="harvest",
        pillar="societies",
        campus="cam",
        writes=("cucbc",),
        network=True,
        docs=("source-research§7",),
    ),
    #
    # Colleges and their JCR/MCR bodies (§8).
    Stage(
        "colleges",
        phase="harvest",
        pillar="societies",
        campus="cam",
        writes=("college_list", "society_website"),
        network=True,
        docs=("source-research§8",),
    ),
    #
    # ── resolve (T4): identities → keys, writes var/staging/_resolved/ ────────
    Stage(
        "resolve",
        description="staged identities → organisation keys + quarantine",
        phase="resolve",
        pillar="societies",
        reads=(_ALL,),
        writes=(RESOLVED,),
        sinks=("crosswalk",),
    ),
    #
    # ── enrich (T5): websites, Linktree; writes keyed observations ────────────
    # Society websites + Linktree: links, JSON-LD, LLM extraction (§13, §14).
    Stage(
        "enrich",
        fetches=True,
        description="websites + Linktree → keyed enrichment observations",
        phase="enrich",
        pillar="societies",
        reads=(RESOLVED,),
        writes=("society_website", "linktree"),
        network=True,
        llm=True,
        docs=("source-research§13", "source-research§14"),
    ),
    #
    # ── classify (R2): type, level and facets of every listed organisation ─────
    # Sources first, rules next, the bulk model with quotes for the rest.
    # It restates every source type (part ``classify``): its writes are a wildcard.
    Stage(
        "classify",
        description="orgType, level, categories, activities, audiences, languages, tags",
        phase="classify",
        pillar="societies",
        reads=(_ALL,),
        writes=(_ALL,),
        # A real run reads general sources' robots.txt for AI opt-outs
        # (`extract.ai_gate`); a dry run fetches nothing.
        network=True,
        llm=True,
    ),
    #
    # ── events (T6): camsocs_pipeline/events/; each writes <source_type>.events ──
    # Camdram diary (§5).
    Stage(
        "camdram_events",
        fetches=True,
        description="Camdram diary → performance events",
        phase="events",
        pillar="events",
        campus="cam",
        reads=(_ORGS,),
        writes=("camdram.events",),
        network=True,
        docs=("source-research§5",),
    ),
    #
    # talks.cam — parser only, never the LLM, Crawl-delay 10 (§6). The events
    # pillar's talks.cam lists (G1), not the talks pillar (`talks` below).
    Stage(
        "talks_cam",
        fetches=True,
        description="talks.cam lists → talks (parser only)",
        phase="events",
        pillar="events",
        campus="cam",
        reads=(_ORGS,),
        writes=("talks_list.events",),
        network=True,
        docs=("source-research§6",),
    ),
    #
    # CUCBC calendar, Bumps dates and fixed timetable (§7).
    Stage(
        "cucbc_events",
        fetches=True,
        description="CUCBC calendar, Bumps, timetable → events",
        phase="events",
        pillar="events",
        campus="cam",
        reads=(_ORGS,),
        writes=("cucbc.events",),
        network=True,
        docs=("source-research§7",),
    ),
    #
    # Playwaze leagues (§9).
    Stage(
        "playwaze",
        fetches=True,
        description="Playwaze college leagues → matches",
        phase="events",
        pillar="events",
        campus="cam",
        reads=(_ORGS,),
        writes=("playwaze.events",),
        network=True,
        docs=("source-research§9",),
    ),
    #
    # University events programme, read with recorded permission (§10, D3a).
    Stage(
        "uni_events",
        fetches=True,
        description="University events programme → public events",
        phase="events",
        pillar="events",
        campus="cam",
        reads=(_ORGS,),
        writes=("uni_events_api.events",),
        network=True,
        docs=("source-research§10",),
    ),
    #
    # Society ICS / Luma / Google feeds (§11). An engine stage: Cambridge's
    # seed feed (`events/seeds.FEED_SEEDS`) is read for cam only.
    Stage(
        "calendar_feeds",
        fetches=True,
        description="society ICS / Luma / Google feeds → events",
        phase="events",
        pillar="events",
        reads=(_ORGS,),
        writes=("ics_feed.events", "luma.events"),
        network=True,
        docs=("source-research§11",),
    ),
    #
    # SU What's On (§12).
    Stage(
        "su_whatson",
        fetches=True,
        description="SU What's On → student-group events",
        phase="events",
        pillar="events",
        campus="cam",
        reads=("su_profile", _ORGS),
        writes=("su_whatson.events",),
        network=True,
        docs=("source-research§12",),
    ),
    #
    # Society websites' events pages: structured data, then the LLM (§14).
    Stage(
        "website_events",
        fetches=True,
        description="society websites' events pages → events (structured data, then LLM)",
        phase="events",
        pillar="events",
        reads=("society_website",),
        writes=("society_website.events",),
        network=True,
        llm=True,
        docs=("source-research§14",),
    ),
    #
    # ── inbox (T7), Instagram + termcards (T8) ────────────────────────────────
    # Forwarded mailing-list mail (§16): reads the pending mails and their
    # attachments, posts what it read as `load` does, then marks the mails.
    Stage(
        "inbox",
        phase="inbox",
        pillar="events",
        reads=(_ORGS, _EVENTS),
        writes=("mailing_list_email",),
        sinks=(
            "inbound/pending",
            "inbound/file",
            "suppressions",
            "sources",
            "files",
            "claims",
            "orgInternal",
            "relationships",
            "eventOrganisers",
            "events/superseded",
            "brokerInferences",
            "inbound/mark",
        ),
        llm=True,
        docs=("source-research§16", "source-research§20"),
    ),
    #
    # Instagram Business Discovery (§17); stores post images itself.
    Stage(
        "instagram",
        phase="inbox",
        pillar="events",
        reads=(_ORGS, _EVENTS),
        writes=("instagram_api",),
        sinks=("files",),
        network=True,
        llm=True,
        docs=("source-research§17",),
    ),
    #
    # Termcard OCR (§21).
    Stage(
        "termcards",
        phase="inbox",
        pillar="events",
        reads=(_ORGS, _EVENTS),
        writes=("termcard",),
        network=True,
        llm=True,
        docs=("source-research§21",),
    ),
    #
    # ── load: every keyed observation → Convex ──────────────────────────────────
    Stage(
        "load",
        requires=("resolve",),
        description="staged observations → Convex",
        phase="load",
        pillar="shared",
        reads=(_ALL,),
        sinks=(
            "suppressions",
            "sources",
            "files",
            "claims",
            "orgInternal",
            "relationships",
            "eventOrganisers",
            "events/superseded",
            "brokerInferences",
        ),
    ),
    #
    # ── talks (D7): the academic talks pillar; posts its own tables ───────────
    # talks.cam API + department sites → talks/* routes (talks-redesign-spec §2–§4).
    # After load: it needs nothing load does, and a slow talks.cam day must
    # never keep the day's events from reaching Convex before the time limit.
    # Campus `cam` until its talks.cam aggregator step is split off. It
    # stages its own ``var/staging/talks/`` file (`TALKS`): beside the source
    # directories, never read as observations.
    Stage(
        "talks",
        fetches=True,
        description="talks.cam + department sites → talks (parser only, posts itself)",
        phase="talks",
        pillar="talks",
        campus="cam",
        writes=(TALKS,),
        sinks=("talks/departments", "talks/batch", "talks/sweep", "talks/runs"),
        network=True,
        docs=("talks-redesign-spec",),
    ),
    #
    # ── report (T14): coverage report ───────────────────────────────────────────
    # Reads the directory back from Convex → var/reports/coverage-<date>.md.
    Stage(
        "report",
        description="coverage → var/reports/coverage-<date>.md (read-only)",
        phase="report",
        pillar="shared",
        sinks=("coverage", "coverage/events"),
    ),
]

#: The engine: stages every campus runs (``campus is None``).
ENGINE: tuple[Stage, ...] = tuple(stage for stage in STAGES if stage.campus is None)


#: The scheduled runs (docs/ops-vps.md): `camsocs sync --group <name>`.
GROUPS: dict[str, StageGroup] = {
    "events": StageGroup(
        "events",
        stages=(
            "term_dates",
            "camdram_events",
            "talks_cam",
            "cucbc_events",
            "playwaze",
            "uni_events",
            "calendar_feeds",
            "su_whatson",
            "website_events",
            "inbox",
            "instagram",
            "termcards",
            "load",
            "talks",
            "report",
        ),
        needs=(RESOLVED, "society_website", "su_profile"),
        stale_after=timedelta(days=8),
        description="daily: every events source, then load and the coverage report",
    ),
    "full": StageGroup(
        "full",
        derive=True,
        description="weekly: every stage in registry order, then the re-derivation",
    ),
    "talks": StageGroup(
        "talks",
        stages=("talks",),
        description="the talks pillar alone: talks.cam + department sites → talks/*",
    ),
}


def stage_names() -> list[str]:
    return [stage.name for stage in STAGES]


def registry(profile: CampusProfile) -> list[Stage]:
    """The stages a run of `profile` may execute, in run order.

    Cambridge's is `STAGES` itself. Another campus runs the engine plus its
    own stages, stable-sorted by phase and then by declared position (engine
    first)."""
    if profile.id == "cam":
        return STAGES
    taken = {stage.name for stage in ENGINE}
    clashes = [stage.name for stage in profile.stages if stage.name in taken]
    if clashes:
        raise ValueError(f"Campus {profile.id}: stages named like engine stages: {clashes}")
    return sorted([*ENGINE, *profile.stages], key=lambda stage: PHASES.index(stage.phase))


def groups(profile: CampusProfile) -> Mapping[str, StageGroup]:
    """The scheduled runs of `profile`: `GROUPS` for Cambridge."""
    return GROUPS if profile.id == "cam" else profile.groups


__all__ = ["ENGINE", "GROUPS", "STAGES", "groups", "registry", "stage_names"]
