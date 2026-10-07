"""Stage `colleges`: the 31 colleges from the University's college A–Z and
their JCR / MCR bodies (source-research §8). Writes
``var/staging/college_list/`` (colleges) and ``var/staging/society_website/``
(bodies). Harvest only: no keys, no Convex (`sources/colleges.py`)."""

from __future__ import annotations

from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.sources import colleges
from camsocs_pipeline.sources.observe import run_harvest


def run(ctx: StageContext) -> None:
    run_harvest(ctx, "college_list", colleges.harvest)
