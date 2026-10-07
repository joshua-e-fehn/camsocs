"""Stage `sport_clubs`: the Sport Cambridge A–Z of University sports clubs and
each club's page (source-research §3). Writes ``var/staging/sport_az/`` and
``var/staging/sport_club_page/``. Harvest only (`sources/sport.py`)."""

from __future__ import annotations

from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.sources import sport
from camsocs_pipeline.sources.observe import run_harvest


def run(ctx: StageContext) -> None:
    run_harvest(ctx, "sport_az", sport.harvest)
