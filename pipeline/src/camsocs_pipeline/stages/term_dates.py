"""Stage `term_dates`: posts the campus's verified Full Term dates
(`ctx.profile.terms.dates`; for Cambridge seeds/term_dates.py, source-research
§19). Runs first so events loaded later in the same run get their
`termWeekLabel`."""

from __future__ import annotations

from camsocs_pipeline.pipeline.context import StageContext


def run(ctx: StageContext) -> None:
    terms = ctx.profile.terms.dates
    result = ctx.loader.upsert_term_dates(terms)
    ctx.report.inserted += result.inserted
    ctx.report.updated += result.updated
    ctx.report.unchanged += result.unchanged
    years = sorted({term.academic_year for term in terms})
    ctx.report.notes.append(f"{len(terms)} terms ({', '.join(years)})")
