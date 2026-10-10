"""Stage `report` (T14): the coverage report, last in every run.

Reads what the directory holds now from Convex — the server's coverage fold,
a page at a time (`ConvexLoader.coverage`), and upcoming events by source
(`ConvexLoader.event_coverage`, from London midnight today) — and writes
``var/reports/coverage-<YYYY-MM-DD>.md`` (`camsocs_pipeline.coverage_report`).
Read-only: it posts nothing. A dry run has no deployment to read and writes
no report.
"""

from __future__ import annotations

from datetime import UTC, datetime

from camsocs_pipeline.coverage_report import CoverageInputs, write_coverage_report
from camsocs_pipeline.events.common import LONDON, london_midnight, london_today
from camsocs_pipeline.pipeline.context import StageContext


def run(ctx: StageContext) -> None:
    if ctx.dry_run:
        ctx.report.notes.append("dry run: no coverage report (it reads the deployment)")
        return
    now = datetime.now(UTC)
    today = london_today(now)
    counts, rows = ctx.loader.coverage()
    events = ctx.loader.event_coverage(int(london_midnight(today).timestamp() * 1000))
    path = write_coverage_report(
        ctx.settings.reports_dir,
        CoverageInputs(
            counts=counts,
            rows=rows,
            events=events,
            events_from=today,
            generated_at=now.astimezone(LONDON),
            deployment=ctx.loader.base_url,
        ),
        ctx.run,
    )
    listed = counts.total
    ctx.report.notes.append(
        f"{listed} listed organisations, {counts.counterparts} counterparts; "
        f"{sum(events.by_source.values())} upcoming events → {path}"
    )
    ctx.report.metrics.update(
        listed=listed,
        counterparts=counts.counterparts,
        upcomingEvents=sum(events.by_source.values()),
    )
