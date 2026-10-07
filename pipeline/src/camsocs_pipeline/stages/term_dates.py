"""Stage `term_dates`: posts the verified Full Term dates (seeds/term_dates.py,
source-research §19). Runs first so events loaded later in the same run get
their `termWeekLabel`."""

from __future__ import annotations

from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.seeds.term_dates import TERM_DATES


def run(ctx: StageContext) -> None:
    result = ctx.loader.upsert_term_dates(TERM_DATES)
    ctx.report.inserted += result.inserted
    ctx.report.updated += result.updated
    ctx.report.unchanged += result.unchanged
    years = sorted({term.academic_year for term in TERM_DATES})
    ctx.report.notes.append(f"{len(TERM_DATES)} terms ({', '.join(years)})")
