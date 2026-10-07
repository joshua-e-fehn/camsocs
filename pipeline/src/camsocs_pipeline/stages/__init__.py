"""The ordered stage registry — the one list `sync` runs.

    seed → harvest → resolve → enrich → events → inbox → load → report

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
3. Edit **exactly one line** below: uncomment your reserved line. There is
   no import to add. The reserved lines are separated by comment lines on
   purpose, so two branches that each uncomment their own line merge without
   conflict. If your stage has no reserved line, add one in its phase with a
   comment line above it.
4. Order matters only *between* phases; within the harvest phase, stages are
   independent. Use ``requires=(...)`` only when your stage cannot run on the
   previous run's output of another stage.
5. Cite your `docs/source-research.md` § in the comment and in the module
   docstring; re-verify the § live before writing the harvester.

A stage that is commented out does not exist for `sync` (not even as "not
run"), so a half-built stage never fails a cron run.
"""

from __future__ import annotations

from camsocs_pipeline.pipeline.context import Stage

STAGES: list[Stage] = [
    # ── seed ─────────────────────────────────────────────────────────────────
    # Full Term dates, verified (source-research §19).
    Stage("term_dates", description="Full Term dates → termDates"),
    #
    # ── harvest (T3): who exists — each writes var/staging/<source_type>/ ──────
    # SU Find a Society directory + profiles (§1).
    Stage("su_directory", description="SU directory + every profile → staging"),
    #
    # Proctors' register (§2).
    Stage("proctors_register", description="Proctors' register → staging"),
    #
    # Sport Cambridge A–Z + club pages (§3).
    Stage("sport_clubs"),
    #
    # Sports Club Guide 2026-27 PDF (§4).
    Stage("sport_guide_pdf"),
    #
    # Camdram societies (§5).
    Stage("camdram_societies"),
    #
    # CUCBC clubs (§7).
    Stage("cucbc_clubs"),
    #
    # Colleges and their JCR/MCR bodies (§8).
    Stage("colleges"),
    #
    # ── resolve (T4): identities → keys, writes var/staging/_resolved/ ────────
    # Stage("resolve"),
    #
    # ── enrich (T5): websites, Linktree; writes keyed observations ────────────
    # Society websites + JSON-LD + LLM extraction (§14).
    # Stage("websites"),
    #
    # Linktree (§13).
    # Stage("linktree"),
    #
    # ── events (T6) ────────────────────────────────────────────────────────────
    # Camdram diary (§5).
    # Stage("camdram_events"),
    #
    # talks.cam — parser only, never the LLM, Crawl-delay 10 (§6).
    # Stage("talks_cam"),
    #
    # CUCBC calendar (§7).
    # Stage("cucbc_events"),
    #
    # Playwaze leagues (§9).
    # Stage("playwaze"),
    #
    # University Events API (§10).
    # Stage("uni_events"),
    #
    # Society ICS / Luma / Google feeds (§11).
    # Stage("calendar_feeds"),
    #
    # SU What's On (§12).
    # Stage("su_whatson"),
    #
    # ── inbox (T7), Instagram + termcards (T8) ────────────────────────────────
    # Forwarded mailing-list mail (§16).
    # Stage("inbox"),
    #
    # Instagram Business Discovery (§17).
    # Stage("instagram"),
    #
    # Termcard OCR (§1 resources, §17).
    # Stage("termcards"),
    #
    # ── load: every keyed observation → Convex ──────────────────────────────────
    Stage("load", requires=("resolve",), description="staged observations → Convex"),
    #
    # ── report (T14): coverage report ───────────────────────────────────────────
    # Stage("report"),
]


def stage_names() -> list[str]:
    return [stage.name for stage in STAGES]


__all__ = ["STAGES", "stage_names"]
