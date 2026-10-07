"""Stage `camdram_societies`: Camdram's ``societies.json`` → theatre company
observations (source-research §5). Writes ``var/staging/camdram/`` (part
``camdram_societies``, beside the events stage's part). Harvest only
(`sources/camdram.py`)."""

from __future__ import annotations

from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.sources import camdram
from camsocs_pipeline.sources.observe import run_harvest


def run(ctx: StageContext) -> None:
    run_harvest(ctx, "camdram", camdram.harvest)
