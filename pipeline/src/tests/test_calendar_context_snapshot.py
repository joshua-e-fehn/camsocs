"""The term calendar's prompt context and week labels, frozen (multi-campus
seam, guardrail L0a).

`TermCalendar.context` is rendered into the LLM requests of the inbox,
Instagram, termcard and website-event stages, and `extract.memo` keys each
cached reply on the whole request: a changed byte in that line (or in the week
arithmetic behind it) re-asks the model for every cached page and card. The
term-week labels must equal what Convex derives (data-model §6). So the
context, the labels and the week arithmetic over a sweep of dates — every
fifth day from September 2026 to August 2028 plus every term boundary — must
equal ``fixtures/golden/calendar-context.cam.json`` byte for byte.

Regenerate with ``CAMSOCS_RECORD_GOLDEN=1 pixi run test-python
src/tests/test_calendar_context_snapshot.py``, then run it again without it.
"""

from __future__ import annotations

import json
import os
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from camsocs_pipeline.extract.when import WEEKDAYS, TermCalendar, week_anchor

GOLDEN = Path(__file__).parent / "fixtures" / "golden" / "calendar-context.cam.json"
RECORD = "CAMSOCS_RECORD_GOLDEN"
SCHEMA = "camsocs.calendar-context/1"
FIRST = date(2026, 9, 1)
LAST = date(2028, 8, 31)
STEP = timedelta(days=5)


def sweep(calendar: TermCalendar) -> list[date]:
    days = set()
    day = FIRST
    while day <= LAST:
        days.add(day)
        day += STEP
    for term in calendar.terms:
        for edge in (term.start, term.week1_start, term.week_start(0), term.end):
            days.update(edge + timedelta(days=offset) for offset in (-1, 0, 1))
        days.add(term.end + timedelta(days=3))
        days.add(term.end + timedelta(days=4))
    return sorted(days)


def snapshot() -> dict[str, Any]:
    calendar = TermCalendar.default()
    terms = [
        {
            "term": term.term,
            "academicYear": term.academic_year,
            "start": term.start.isoformat(),
            "end": term.end.isoformat(),
            "week0Start": term.week_start(0).isoformat(),
            "week1Start": term.week1_start.isoformat(),
            "lastWeek": term.last_week,
            "describe": term.describe(),
            "week3": {weekday: term.date_of(3, weekday).isoformat() for weekday in WEEKDAYS},
        }
        for term in calendar.terms
    ]
    days = []
    for day in sweep(calendar):
        term = calendar.term_for(day)
        week = term.week_of(day) if term is not None else None
        anchor = week_anchor(day)
        days.append(
            {
                "date": day.isoformat(),
                "context": calendar.context(day),
                "weekAnchor": anchor.isoformat(),
                "anchorContext": calendar.context(anchor),
                "term": f"{term.term} {term.calendar_year}" if term is not None else None,
                "label": term.label(week) if term is not None and week is not None else None,
            }
        )
    return {"schema": SCHEMA, "terms": terms, "days": days}


def render() -> str:
    return json.dumps(snapshot(), indent=1, ensure_ascii=False) + "\n"


def test_the_calendar_context_and_week_labels_are_frozen() -> None:
    rendered = render()
    if os.environ.get(RECORD):
        GOLDEN.parent.mkdir(parents=True, exist_ok=True)
        GOLDEN.write_text(rendered, encoding="utf-8")
    assert GOLDEN.exists(), f"no golden file; record it with {RECORD}=1"
    golden = GOLDEN.read_text(encoding="utf-8")
    if rendered != golden:
        mine, theirs = json.loads(rendered), json.loads(golden)
        assert mine["terms"] == theirs["terms"]
        for a, b in zip(mine["days"], theirs["days"], strict=False):
            assert a == b, a["date"]
    assert rendered == golden


def test_the_snapshot_holds_the_line_the_prompts_carry() -> None:
    """A guard on the snapshot itself: a day of Week 2 of Michaelmas 2026 is in
    it, with the Cambridge line every LLM stage renders."""
    days = {entry["date"]: entry for entry in snapshot()["days"]}
    entry = days["2026-10-21"]
    assert entry["label"] == "MT26 Wk 2"
    assert entry["weekAnchor"] == "2026-10-15"
    assert entry["context"] == (
        "Reference date: Wednesday 21 October 2026 (Europe/London). Cambridge Michaelmas "
        "Full Term 2026 runs Tuesday 6 October 2026 to Friday 4 December 2026; Week 1 starts "
        "Thursday 8 October 2026 and Week 0 starts Thursday 1 October 2026. A student week "
        "runs Thursday to Wednesday. It is in Week 2 of that term."
    )
