"""Term weeks and relative dates → instants (extract/when.py), against the
verified Full Term dates (source-research §19)."""

from __future__ import annotations

from datetime import UTC, date, datetime

import pytest

from camsocs_pipeline.extract.when import (
    TermCalendar,
    Unresolvable,
    WhenSpec,
    london_date,
    normalise_weekday,
    parse_hhmm,
    resolve_when,
)

CAL = TermCalendar.default()
MT26 = CAL.term_named("michaelmas", 2026, date(2026, 10, 1))


def test_week_arithmetic_matches_the_university_convention() -> None:
    assert MT26 is not None
    # Full Term starts Tue 6 Oct 2026; Week 1 starts the first Thursday.
    assert MT26.week1_start == date(2026, 10, 8)
    assert MT26.week_start(0) == date(2026, 10, 1)
    assert MT26.date_of(3, "wednesday") == date(2026, 10, 28)
    assert MT26.date_of(3, "thursday") == date(2026, 10, 22)
    assert MT26.date_of(1, "tuesday") == date(2026, 10, 13)
    # Michaelmas 2026 ends Fri 4 Dec, in Week 9 (source-research §19).
    assert MT26.last_week == 9
    assert MT26.week_of(date(2026, 12, 4)) == 9
    assert MT26.week_of(date(2026, 9, 1)) is None
    assert MT26.label(3) == "MT26 Wk 3"


def test_term_for_picks_the_current_or_next_term() -> None:
    assert CAL.term_for(date(2026, 10, 19)).term == "michaelmas"
    # Two days after Full Term ended still means that term (grace period)…
    assert CAL.term_for(date(2026, 12, 6)).term == "michaelmas"
    # …but in the Christmas vacation a bare "Week 1" is Lent's.
    assert CAL.term_for(date(2026, 12, 20)).term == "lent"
    assert CAL.term_for(date(2029, 1, 1)) is None


def test_term_named_with_and_without_a_year() -> None:
    assert CAL.term_named("Lent", 2027, date(2026, 10, 1)).start == date(2027, 1, 19)
    assert CAL.term_named("easter", None, date(2026, 10, 1)).start == date(2027, 4, 27)
    assert CAL.term_named("lent", 2031, date(2026, 10, 1)) is None
    assert CAL.term_named(None, 2026, date(2026, 10, 1)) is None


def test_wednesday_of_week_3_in_the_evening_crosses_the_clock_change() -> None:
    when = resolve_when(
        WhenSpec(term_week=3, weekday="Wed", start_time="19:30", end_time="22:00"),
        anchor=date(2026, 10, 19),
        calendar=CAL,
    )
    # 28 Oct 2026 is after the clocks went back (25 Oct): GMT = UTC.
    assert when.starts_at == datetime(2026, 10, 28, 19, 30, tzinfo=UTC)
    assert when.ends_at == datetime(2026, 10, 28, 22, 0, tzinfo=UTC)
    assert when.basis == "term_week" and not when.all_day


def test_calendar_dates_use_british_summer_time() -> None:
    when = resolve_when(
        WhenSpec(date="2026-10-23", start_time="18:00"), anchor=date(2026, 10, 19), calendar=CAL
    )
    assert when.starts_at == datetime(2026, 10, 23, 17, 0, tzinfo=UTC)


def test_an_end_before_the_start_is_the_next_day() -> None:
    when = resolve_when(
        WhenSpec(date="2026-10-23", start_time="22:00", end_time="02:00"),
        anchor=date(2026, 10, 19),
        calendar=CAL,
    )
    assert when.ends_at is not None and when.ends_at.date() == date(2026, 10, 24)


def test_relative_days_and_bare_weekdays_count_from_the_anchor() -> None:
    anchor = date(2026, 10, 19)  # a Monday
    tonight = resolve_when(
        WhenSpec(relative_day="tonight", start_time="20:00"), anchor=anchor, calendar=CAL
    )
    assert london_date(tonight.starts_at) == anchor
    tomorrow = resolve_when(WhenSpec(relative_day="Tomorrow"), anchor=anchor, calendar=CAL)
    assert tomorrow.local_date == date(2026, 10, 20) and tomorrow.all_day
    friday = resolve_when(WhenSpec(weekday="friday"), anchor=anchor, calendar=CAL)
    assert friday.local_date == date(2026, 10, 23) and friday.basis == "weekday"
    monday = resolve_when(WhenSpec(weekday="monday"), anchor=anchor, calendar=CAL)
    assert monday.local_date == anchor


def test_an_all_day_event_starts_at_london_midnight() -> None:
    when = resolve_when(WhenSpec(date="2026-10-23"), anchor=date(2026, 10, 19), calendar=CAL)
    assert when.all_day
    assert when.starts_at == datetime(2026, 10, 22, 23, 0, tzinfo=UTC)


def test_a_named_term_beats_the_anchor_term() -> None:
    lent = CAL.term_named("lent", 2027, date(2026, 10, 1))
    when = resolve_when(
        WhenSpec(term_week=1, weekday="thursday"), anchor=date(2026, 10, 1), calendar=CAL, term=lent
    )
    assert when.local_date == date(2027, 1, 21)


@pytest.mark.parametrize(
    ("spec", "reason"),
    [
        (WhenSpec(), "no date"),
        (WhenSpec(term_week=3), "without a weekday"),
        (WhenSpec(term_week=14, weekday="monday"), "no such term week"),
        (WhenSpec(date="23/10/2026"), "not an ISO date"),
        (WhenSpec(date="2026-09-01"), "recap"),
        (WhenSpec(date="2028-12-01"), "implausibly far"),
    ],
)
def test_what_cannot_be_trusted_is_refused(spec: WhenSpec, reason: str) -> None:
    with pytest.raises(Unresolvable, match=reason):
        resolve_when(spec, anchor=date(2026, 10, 19), calendar=CAL)


def test_term_weeks_beyond_the_seeded_years_are_refused() -> None:
    with pytest.raises(Unresolvable, match="no verified term dates"):
        resolve_when(
            WhenSpec(term_week=2, weekday="friday"), anchor=date(2029, 1, 10), calendar=CAL
        )


def test_small_parsers() -> None:
    assert normalise_weekday("Weds") == "wednesday"
    assert normalise_weekday("THURS.") == "thursday"
    assert normalise_weekday("someday") is None
    assert parse_hhmm("7:30") is not None and parse_hhmm("19:30").hour == 19
    assert parse_hhmm("7pm") is None and parse_hhmm("24:00") is None


def test_calendar_context_names_the_week() -> None:
    text = CAL.context(date(2026, 10, 19))
    assert "Monday 19 October 2026" in text
    assert "Week 1 starts Thursday 8 October 2026" in text
    assert "Week 2" in text
