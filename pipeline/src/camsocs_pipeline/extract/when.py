"""When an extracted event happens — resolved deterministically, never by the LLM.

Society mail, captions and termcards rarely give full dates. They say
"Wednesday of Week 3", "this Friday", "tomorrow" or "Thu 15th". The LLM
reports *what the text says* (a calendar date, or a term week and weekday, or
a relative day, plus HH:MM times, with the verbatim words as evidence) and this
module turns that into instants:

- **Term weeks** use the University's Full Term dates (`seeds.term_dates`,
  source-research §19). Full Term starts on a Tuesday; a student week runs
  Thursday → Wednesday; Week 1 starts on the first Thursday of Full Term and
  Week 0 is the week before. So "Wednesday of Week 3" in Michaelmas 2026
  (Full Term from Tue 6 Oct) is Wed 28 Oct 2026.
- **Which term** a bare "Week 3" means is the term the text names (a termcard
  says "Michaelmas 2026"), else the first term that has not ended more than a
  few days before the anchor date (the mail's date, the post's date).
- **Relative days** count from the anchor date in Europe/London; a bare
  weekday is its next occurrence on or after the anchor.
- **Times** are Europe/London wall-clock times, converted to UTC instants. An
  event without a start time is `allDay` and starts at local midnight.

Anything implausible (more than two weeks before the anchor — usually a recap
of a past event — or more than ~13 months after) is refused with a reason
rather than guessed.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from camsocs_pipeline.models.wire import TermDate

LONDON = ZoneInfo("Europe/London")

WEEKDAYS: tuple[str, ...] = (
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
)
_THURSDAY = 3
#: Full names, three-letter forms and the common British abbreviations.
_WEEKDAY_FORMS: dict[str, str] = {
    **{name: name for name in WEEKDAYS},
    **{name[:3]: name for name in WEEKDAYS},
    "tues": "tuesday",
    "weds": "wednesday",
    "thur": "thursday",
    "thurs": "thursday",
}

#: Term-week numbers a source may use: Week 0 (before Full Term) to Week 10
#: (the first week after the longest Full Term).
MIN_TERM_WEEK = 0
MAX_TERM_WEEK = 10

#: Events dated this far before the anchor are recaps, not announcements.
MAX_DAYS_BEFORE_ANCHOR = 14
#: Nobody announces a society event more than ~13 months ahead.
MAX_DAYS_AFTER_ANCHOR = 400
#: A term still counts as "the current one" this long after Full Term ends.
TERM_GRACE_DAYS = 3

_TERM_PREFIX = {"michaelmas": "MT", "lent": "LT", "easter": "ET"}
_HHMM = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")


def normalise_weekday(value: str | None) -> str | None:
    """`"Wed"`, `"wednesday"`, `"WEDNESDAY"` → `"wednesday"`; anything else → None."""
    if not value:
        return None
    lowered = value.strip().lower().rstrip(".")
    return _WEEKDAY_FORMS.get(lowered)


def parse_hhmm(value: str | None) -> time | None:
    """`"19:30"` / `"7:30"` → a time; anything else → None (the LLM is asked
    for 24-hour HH:MM; a malformed time is dropped, never guessed)."""
    if not value:
        return None
    match = _HHMM.match(value.strip())
    if not match:
        return None
    return time(int(match.group(1)), int(match.group(2)))


@dataclass(frozen=True)
class Term:
    """One Full Term, with the student-week arithmetic on it."""

    academic_year: str
    term: str
    start: date
    end: date

    @property
    def week1_start(self) -> date:
        """The first Thursday of Full Term."""
        return self.start + timedelta(days=(_THURSDAY - self.start.weekday()) % 7)

    @property
    def last_week(self) -> int:
        return (self.end - self.week1_start).days // 7 + 1

    @property
    def calendar_year(self) -> int:
        return self.start.year

    def week_start(self, week: int) -> date:
        """The Thursday that begins `week` (Week 0 is the week before Week 1)."""
        return self.week1_start + timedelta(days=7 * (week - 1))

    def date_of(self, week: int, weekday: str) -> date:
        """The `weekday` of term week `week` (weeks run Thursday → Wednesday)."""
        offset = (WEEKDAYS.index(weekday) - _THURSDAY) % 7
        return self.week_start(week) + timedelta(days=offset)

    def week_of(self, day: date) -> int | None:
        """The term week holding `day`, or None outside Week 0 … the last week."""
        week = (day - self.week1_start).days // 7 + 1
        return week if 0 <= week <= self.last_week else None

    def label(self, week: int) -> str:
        """`MT26 Wk 3` — the same label Convex derives (data-model §6)."""
        return f"{_TERM_PREFIX[self.term]}{self.calendar_year % 100:02d} Wk {week}"

    def describe(self) -> str:
        return (
            f"{self.term.capitalize()} Full Term {self.calendar_year} runs "
            f"{_long(self.start)} to {_long(self.end)}; Week 1 starts "
            f"{_long(self.week1_start)} and Week 0 starts {_long(self.week_start(0))}"
        )


def _long(day: date) -> str:
    return f"{WEEKDAYS[day.weekday()].capitalize()} {day.day} {day.strftime('%B %Y')}"


class TermCalendar:
    """The verified Full Terms, in order (`seeds.term_dates.TERM_DATES`)."""

    def __init__(self, terms: Iterable[TermDate]) -> None:
        self.terms: list[Term] = sorted(
            (
                Term(
                    academic_year=t.academic_year,
                    term=t.term,
                    start=date.fromisoformat(t.full_term_start),
                    end=date.fromisoformat(t.full_term_end),
                )
                for t in terms
            ),
            key=lambda term: term.start,
        )

    @classmethod
    def default(cls) -> TermCalendar:
        from camsocs_pipeline.seeds.term_dates import TERM_DATES

        return cls(TERM_DATES)

    def term_for(self, anchor: date) -> Term | None:
        """The term a bare "Week N" written on `anchor` refers to: the first term
        that has not ended more than `TERM_GRACE_DAYS` before it."""
        for term in self.terms:
            if term.end + timedelta(days=TERM_GRACE_DAYS) >= anchor:
                return term
        return None

    def term_named(self, name: str | None, year: int | None, anchor: date) -> Term | None:
        """The term a text names ("Michaelmas 2026", "Lent Term"); a name without
        a year means the next such term from the anchor."""
        if not name:
            return None
        wanted = name.strip().lower()
        candidates = [term for term in self.terms if term.term == wanted]
        if year is not None:
            for term in candidates:
                if term.calendar_year == year:
                    return term
            return None
        for term in candidates:
            if term.end + timedelta(days=TERM_GRACE_DAYS) >= anchor:
                return term
        return None

    def context(self, anchor: date) -> str:
        """Plain-language calendar facts for a prompt, so the model can turn
        "Thursday 15th" into a full date relative to the anchor."""
        lines = [f"Reference date: {_long(anchor)} (Europe/London)."]
        term = self.term_for(anchor)
        if term is not None:
            week = term.week_of(anchor)
            where = f" It is in Week {week} of that term." if week is not None else ""
            lines.append(
                f"Cambridge {term.describe()}. A student week runs Thursday to Wednesday.{where}"
            )
        return " ".join(lines)


@dataclass(frozen=True)
class WhenSpec:
    """What a text says about when an event happens (LLM output, unresolved)."""

    date: str | None = None
    term_week: int | None = None
    weekday: str | None = None
    relative_day: str | None = None
    start_time: str | None = None
    end_time: str | None = None


@dataclass(frozen=True)
class When:
    """A resolved time: UTC instants plus the London calendar date."""

    starts_at: datetime
    ends_at: datetime | None
    all_day: bool
    local_date: date
    #: How the date was resolved: `date`, `term_week`, `relative`, `weekday`.
    basis: str


class Unresolvable(ValueError):
    """The text does not pin down a date we can trust."""


def resolve_when(
    spec: WhenSpec, *, anchor: date, calendar: TermCalendar, term: Term | None = None
) -> When:
    """Resolve `spec` against `anchor` (a London date). Raises `Unresolvable`."""
    day, basis = _resolve_day(spec, anchor=anchor, calendar=calendar, term=term)
    if day < anchor - timedelta(days=MAX_DAYS_BEFORE_ANCHOR):
        raise Unresolvable(f"{day} is long before {anchor}: a recap, not an announcement")
    if day > anchor + timedelta(days=MAX_DAYS_AFTER_ANCHOR):
        raise Unresolvable(f"{day} is implausibly far after {anchor}")

    start_time = parse_hhmm(spec.start_time)
    if start_time is None:
        midnight = datetime.combine(day, time(0, 0), tzinfo=LONDON)
        return When(midnight.astimezone(UTC), None, True, day, basis)
    starts = datetime.combine(day, start_time, tzinfo=LONDON)
    ends: datetime | None = None
    end_time = parse_hhmm(spec.end_time)
    if end_time is not None:
        end_day = day if end_time > start_time else day + timedelta(days=1)
        ends = datetime.combine(end_day, end_time, tzinfo=LONDON)
    return When(starts.astimezone(UTC), ends.astimezone(UTC) if ends else None, False, day, basis)


def _resolve_day(
    spec: WhenSpec, *, anchor: date, calendar: TermCalendar, term: Term | None
) -> tuple[date, str]:
    if spec.date:
        try:
            return date.fromisoformat(spec.date.strip()[:10]), "date"
        except ValueError as error:
            raise Unresolvable(f"not an ISO date: {spec.date!r}") from error
    weekday = normalise_weekday(spec.weekday)
    if spec.term_week is not None:
        if not MIN_TERM_WEEK <= spec.term_week <= MAX_TERM_WEEK:
            raise Unresolvable(f"no such term week: {spec.term_week}")
        if weekday is None:
            raise Unresolvable(f"Week {spec.term_week} without a weekday")
        chosen = term or calendar.term_for(anchor)
        if chosen is None:
            raise Unresolvable(f"no verified term dates cover {anchor}")
        return chosen.date_of(spec.term_week, weekday), "term_week"
    relative = (spec.relative_day or "").strip().lower()
    if relative in ("today", "tonight"):
        return anchor, "relative"
    if relative == "tomorrow":
        return anchor + timedelta(days=1), "relative"
    if weekday is not None:
        offset = (WEEKDAYS.index(weekday) - anchor.weekday()) % 7
        return anchor + timedelta(days=offset), "weekday"
    raise Unresolvable("no date, term week, relative day or weekday given")


def london_date(moment: datetime) -> date:
    """The Europe/London calendar date of an aware instant."""
    if moment.tzinfo is None:
        raise ValueError("timestamps must be timezone-aware")
    return moment.astimezone(LONDON).date()


__all__ = [
    "LONDON",
    "WEEKDAYS",
    "Term",
    "TermCalendar",
    "Unresolvable",
    "When",
    "WhenSpec",
    "london_date",
    "normalise_weekday",
    "parse_hhmm",
    "resolve_when",
]
