"""Stage `cucbc_clubs`: the CUCBC boat clubs — the 31 college boat clubs plus
CUBC, CUCBC and four others (source-research §7). Writes
``var/staging/cucbc/`` (part ``cucbc_clubs``, beside the events stage's part).
``Crawl-delay: 10`` makes a full run take about six minutes; details pages are
reused from the cache for a week. Harvest only (`sources/cucbc.py`)."""

from __future__ import annotations

from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.sources import cucbc
from camsocs_pipeline.sources.observe import run_harvest


def run(ctx: StageContext) -> None:
    run_harvest(ctx, "cucbc", cucbc.harvest)
