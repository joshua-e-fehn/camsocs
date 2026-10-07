"""Stage `sport_guide_pdf`: the Sports Club Guide 2026-27 PDF — club sections
and the "at a glance" table, read deterministically (source-research §4).
Writes ``var/staging/sport_guide_pdf/``. Harvest only (`sources/sport_guide.py`).

Runs after `sport_clubs` so the guide's entries can carry the A–Z club's
``sport_slug`` (read from the latest staged ``sport_club_page`` observations);
without them it still runs, and the resolver joins by Instagram handle and name.
"""

from __future__ import annotations

from functools import partial

from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.sources import sport_guide
from camsocs_pipeline.sources.observe import run_harvest


def run(ctx: StageContext) -> None:
    clubs = sport_guide.known_clubs(ctx.staging.read_latest("sport_club_page"))
    if not clubs:
        ctx.report.notes.append("no staged sport_club_page observations: entries not linked")
    run_harvest(ctx, "sport_guide_pdf", partial(sport_guide.harvest, clubs=clubs))
