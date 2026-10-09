"""The coverage report `camsocs harvest` (and every `sync` that runs the
`report` stage) leaves behind: ``var/reports/coverage-<YYYY-MM-DD>.md``.

What the directory in Convex holds after the run, as one Markdown page:

- the listings: how many, hidden, counterparts, by level, status and type;
- every organisation field with how many listed organisations hold a value
  for it (found, inferred, owner-confirmed, manual or conflicting), and the
  share;
- upcoming events by source and visibility;
- the tracked fields most often missing (the phase-2 outreach list);
- the run's stages and the identity-resolution quarantine.

The numbers come from the server's own coverage fold (`POST
/api/pipeline/coverage`, webapp/lib/broker/coverage.ts — the broker overview
shows the same) and its upcoming events (`coverage/events`). Rendering is
pure (`render_coverage_report`), so it is tested on fixed counts.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from urllib.parse import urlsplit

from camsocs_pipeline.models.vocab import ORGANISATION_FIELDS
from camsocs_pipeline.models.wire import CoverageCounts, EventsCoveragePage
from camsocs_pipeline.pipeline.report import RunReport

#: Most-missing fields listed.
MISSING_TOP = 15

#: The headline fields of the broker overview, in its order.
HEADLINE = (
    ("email", "Contact address (non-personal)"),
    ("website", "Website"),
    ("instagram", "Instagram"),
    ("description", "Description (short or long)"),
)


@dataclass(frozen=True)
class CoverageInputs:
    counts: CoverageCounts
    #: Organisation rows read (listed + counterparts).
    rows: int
    events: EventsCoveragePage
    #: London date the events count from.
    events_from: date
    generated_at: datetime
    deployment: str


def report_path(reports_dir: Path, day: date) -> Path:
    return reports_dir / f"coverage-{day.isoformat()}.md"


def _pct(part: int, whole: int) -> str:
    return f"{100 * part / whole:.0f}%" if whole else "–"


def _table(header: tuple[str, ...], rows: list[tuple[object, ...]]) -> list[str]:
    numeric = [i > 0 for i in range(len(header))]
    lines = [
        "| " + " | ".join(header) + " |",
        "|" + "|".join("---:" if right else "---" for right in numeric) + "|",
    ]
    lines += ["| " + " | ".join(str(cell) for cell in row) + " |" for row in rows]
    return lines


def _counts_table(title: str, counts: dict[str, int], total: int) -> list[str]:
    rows = [
        (name, count, _pct(count, total))
        for name, count in sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    ]
    return [f"### {title}", "", *_table((title.split()[-1].capitalize(), "Count", "%"), rows), ""]


def render_coverage_report(inputs: CoverageInputs, run: RunReport | None = None) -> str:
    """The report's Markdown (module docstring)."""
    counts, events = inputs.counts, inputs.events
    listed = counts.total
    host = urlsplit(inputs.deployment).netloc or inputs.deployment or "(unknown deployment)"
    lines = [
        f"# Coverage report — {inputs.generated_at.date().isoformat()}",
        "",
        f"Generated {inputs.generated_at.isoformat(timespec='minutes')} from `{host}`"
        + (f" after run `{run.run_key}`" if run else "")
        + ". Counts are over **listed** organisations (counterparts are never listed).",
        "",
        "## Listings",
        "",
        *_table(
            ("What", "Count"),
            [
                ("Listed organisations", listed),
                ("of which hidden (removed on request)", counts.hidden),
                ("Counterparts (colleges, companies, offices)", counts.counterparts),
                ("Organisation rows read", inputs.rows),
            ],
        ),
        "",
        *_counts_table("By level", counts.by_level, listed),
        *_counts_table("By status", counts.by_status, listed),
        *_counts_table("By type", counts.by_org_type, listed),
        "## Headline fields",
        "",
        *_table(
            ("Field", "Listed holding it", "%"),
            [
                (label, counts.headline.get(name, 0), _pct(counts.headline.get(name, 0), listed))
                for name, label in HEADLINE
            ],
        ),
        "",
        "## Every field",
        "",
        "Listed organisations holding a value (found, inferred, owner-confirmed, manual or "
        "conflicting); *missing* counts only the tracked fields the outreach asks for.",
        "",
    ]
    field_rows = []
    for name in ORGANISATION_FIELDS:
        held = counts.held.get(name, 0)
        missing = counts.missing.get(name)
        field_rows.append((name, held, _pct(held, listed), "" if missing is None else missing))
    field_rows.sort(key=lambda row: (-int(row[1]), str(row[0])))
    lines += _table(("Field", "Held", "%", "Missing"), field_rows)
    lines += [
        "",
        f"## Upcoming events (from {inputs.events_from.isoformat()})",
        "",
        *_table(
            ("Source", "Events"),
            [
                *sorted(events.by_source.items(), key=lambda item: (-item[1], item[0])),
                ("**total**", sum(events.by_source.values())),
            ],
        ),
        "",
        "By visibility: "
        + (
            ", ".join(f"{name} {count}" for name, count in sorted(events.by_visibility.items()))
            or "none"
        )
        + f"; cancelled {events.cancelled}.",
        "",
        f"## Most often missing (top {MISSING_TOP})",
        "",
        *_table(
            ("Tracked field", "Listed missing it", "%"),
            [
                (name, count, _pct(count, listed))
                for name, count in sorted(counts.missing.items(), key=lambda i: (-i[1], i[0]))[
                    :MISSING_TOP
                ]
            ],
        ),
        "",
    ]
    if run is not None:
        resolve = next((stage for stage in run.stages if stage.name == "resolve"), None)
        if resolve is not None and resolve.metrics:
            metrics = resolve.metrics
            lines += [
                "## Quarantine",
                "",
                f"{metrics.get('quarantineHeld', 0)} held, "
                f"{metrics.get('quarantineDropped', 0)} references dropped, "
                f"{metrics.get('quarantineReview', 0)} matches to review "
                "(var/reports/quarantine.json; decide in pipeline/resolve-decisions.json).",
                "",
            ]
        stages = [stage for stage in run.stages if stage.name != "report"]
        if stages:
            lines += ["## This run", ""]
            lines += _table(
                ("Stage", "Status", "New", "Updated", "Unchanged", "Skipped"),
                [(s.name, s.status, s.inserted, s.updated, s.unchanged, s.skipped) for s in stages],
            )
            lines.append("")
    return "\n".join(lines)


def write_coverage_report(
    reports_dir: Path, inputs: CoverageInputs, run: RunReport | None = None
) -> Path:
    path = report_path(reports_dir, inputs.generated_at.date())
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render_coverage_report(inputs, run), encoding="utf-8")
    return path


__all__ = [
    "CoverageInputs",
    "render_coverage_report",
    "report_path",
    "write_coverage_report",
]
