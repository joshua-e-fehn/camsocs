"""Whether a date the model read off a page or a card can be trusted
(source-research §14 "Events pages", §21 "Dates").

Pages and cards keep last year's programme online without its year, and
"5 March" read in October is then next March to a reader who guesses. These
rules decide, deterministically, which of the model's dates stand:

- **A dated quote** (`dated_quote`, `card_dated_quote`): every event must
  carry a ``when_quote`` that holds its date — the day number (with a month on
  a page; a card may print the month as a heading above its rows), or a term
  week with its weekday. Relative days never count: a page or a card has no
  date of its own.
- **The year** (`year_problem`): a calendar date's year must be the one its
  quote states; a yearless date is never taken from a source about an earlier
  season (`page_dating`), its stated weekday must fall on it, and it needs a
  second signal — the source names this year or the term, or most of its own
  weekday-dated dates fall on their weekdays this year (`weekdays_agree`),
  or it lies within eight weeks of the day it was read. A card adds two: it
  was published this academic year (its upload path or ``Last-Modified``:
  `PageDating.fresh`), or it names its term with the year and the date falls
  in that term (`PageDating.term_span`). The year of a yearless date kept is
  our inference, so its start is ``inferred``.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, timedelta

from camsocs_pipeline.extract.events import LlmEvent
from camsocs_pipeline.extract.evidence import EvidenceMatch, check_quote

_MONTH = (
    r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|"
    r"sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
)
_DAY_MONTH = re.compile(rf"\b(\d{{1,2}})(?:st|nd|rd|th)?\.?\s*(?:of\s+)?{_MONTH}\b", re.I)
_MONTH_DAY = re.compile(rf"\b{_MONTH}\.?\s+(\d{{1,2}})(?:st|nd|rd|th)?\b", re.I)
_NUMERIC_DATE = re.compile(r"\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2}|\d{4}))?\b")
_ISO_DATE = re.compile(r"\b20\d\d-(\d\d)-(\d\d)\b")
#: Any day number as a card prints it: "15", "8th", "1ST", "18-29".
_DAY_NUMBER = re.compile(r"(?<!\d)(\d{1,2})(?:st|nd|rd|th)?(?!\d)", re.I)
_WEEK = re.compile(r"\b(?:week|wk)\.?\s*(\d{1,2})\b|\b(\d{1,2})(?:st|nd|rd|th)\s+week\b", re.I)
_WEEKDAY = re.compile(r"\b(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\b", re.I)
_WEEKDAY_NAME = re.compile(
    r"\b(mon|tue|wed|thu|fri|sat|sun)(?:day|s|sday|nesday|rsday|urday|r|rs|t)?\.?\b", re.I
)
_WEEKDAYS = {"mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6}
_YEAR = re.compile(r"\b(20\d\d)\b")
#: An academic year or a season as pages write it: "2025/2026", "2025-26".
_SEASON = re.compile(r"\b(20\d\d)\s*[/–-]\s*(20\d\d|\d\d)\b")
#: A date a page gives without its year or weekday is trusted this far ahead.
YEARLESS_HORIZON = timedelta(weeks=8)
#: How many of a page's yearless dates must fall on their stated weekdays
#: this year for the page's dates to count as this year's (`weekdays_agree`).
MIN_AGREEING_WEEKDAYS = 3


def _iso(value: str | None) -> date | None:
    try:
        return date.fromisoformat((value or "").strip()[:10])
    except ValueError:
        return None


def _weekdays(quote: str) -> set[int]:
    return {_WEEKDAYS[m.group(1).lower()[:3]] for m in _WEEKDAY_NAME.finditer(quote)}


def _week_dated(event: LlmEvent, quote: str) -> bool:
    """A term week's quote holds the week number and a weekday."""
    weeks = {int(m.group(1) or m.group(2)) for m in _WEEK.finditer(quote)}
    return event.term_week in weeks and bool(_WEEKDAY.search(quote))


def dated_quote(event: LlmEvent, source_text: str) -> bool:
    """Whether the event's ``when_quote`` is on the page and holds its date:
    the day number with a month (or a numeric / ISO date) for a calendar
    date, the week number and a weekday for a term week. Relative days never
    count: a web page has no date of its own."""
    quote = (event.when_quote or "").strip()
    if not quote or check_quote(quote, source_text) is EvidenceMatch.ABSENT:
        return False
    if event.relative_day:
        return False
    if event.date:
        day = _iso(event.date)
        if day is None:
            return False
        numbers = {int(m.group(1)) for m in _DAY_MONTH.finditer(quote)} | {
            int(m.group(1)) for m in _MONTH_DAY.finditer(quote)
        }
        numbers |= {int(m.group(2)) for m in _ISO_DATE.finditer(quote)}
        for m in _NUMERIC_DATE.finditer(quote):
            numbers |= {int(m.group(1)), int(m.group(2))}
        return day.day in numbers
    if event.term_week is not None:
        return _week_dated(event, quote)
    return False


def card_dated_quote(event: LlmEvent) -> bool:
    """Whether the event's ``when_quote`` holds the date a card prints for it:
    the day number for a calendar date (a card may print the month once, as a
    heading above its rows: "OCTOBER … 15 Social"), the week number and a
    weekday for a term week. An image has no text to find the quote in, so
    only what it says is checked; values read only off an image stay
    ``inferred``. Relative days never count: a card has no date of its own."""
    quote = (event.when_quote or "").strip()
    if not quote or event.relative_day:
        return False
    if event.date:
        day = _iso(event.date)
        return day is not None and day.day in {int(m.group(1)) for m in _DAY_NUMBER.finditer(quote)}
    if event.term_week is not None:
        return _week_dated(event, quote)
    return False


@dataclass(frozen=True)
class PageDating:
    """What a page (or a card) says about its own year (`page_dating`)."""

    #: Why the page is last season's or older (yearless dates then cannot
    #: be this year's), or None.
    stale: str | None = None
    #: The page names this academic year (a year since it began, or its season).
    current: bool = False
    #: The page (or its URL / title) names the term.
    term: bool = False
    #: The page's own weekday-dated dates fall on their weekdays this year
    #: (`weekdays_agree`).
    weekdays: bool = False
    #: A card published this academic year (its upload path or
    #: ``Last-Modified``): its yearless dates are this year's.
    fresh: bool = False
    #: Week 0 to a week after Full Term of a term the source names with its
    #: year ("Michaelmas 2026"): a yearless date inside it is that term's.
    term_span: tuple[date, date] | None = None


def page_dating(text: str, read_on: date, *, term: bool = False) -> PageDating:
    """A page's own year (module docstring): a page whose seasons are all
    earlier ones ("the upcoming 2025/2026 season", a fixtures table scored
    "2025-26"), or that names no year since last season, is stale."""
    current = read_on.year if read_on.month >= 7 else read_on.year - 1
    seasons: set[int] = set()
    for match in _SEASON.finditer(text):
        first, second = int(match.group(1)), int(match.group(2)) % 100
        if second == (first + 1) % 100:
            seasons.add(first)
    years = {int(y) for y in _YEAR.findall(text)}
    names_current = current in seasons or any(year >= current for year in years)
    if seasons and max(seasons) < current and current not in seasons:
        return PageDating("the page is about an earlier season", False, term)
    if years and max(years) < current:
        return PageDating("the page names no year since last season", False, term)
    return PageDating(None, names_current, term)


#: A page that names this year (the default for a single event checked alone).
CURRENT_PAGE = PageDating(current=True)


def year_problem(event: LlmEvent, read_on: date, dating: PageDating = CURRENT_PAGE) -> str | None:
    """Why the year of a calendar date cannot be trusted, or None (module
    docstring): the year must be the one the quote states; a yearless date is
    never taken from a source about an earlier season, its stated weekday must
    fall on it, and it needs a second signal — the source names this year or
    the term, its weekdays agree on this year, it is a card published this
    academic year, the date falls in a term the source names with its year,
    or it lies within `YEARLESS_HORIZON` of the day it was read. A yearless
    date kept is our inference (`LlmEvent._year_inferred`)."""
    day = _iso(event.date)
    if day is None:
        return None
    quote = event.when_quote or ""
    years = {int(y) for y in _YEAR.findall(quote)}
    if years:
        return None if day.year in years else "the year differs from the page's"
    if dating.stale is not None:
        return dating.stale
    weekdays = _weekdays(quote)
    if weekdays and day.weekday() not in weekdays:
        return "the weekday does not fall on that date"
    in_named_term = dating.term_span is not None and (
        dating.term_span[0] <= day <= dating.term_span[1]
    )
    # Within eight weeks of the reading, nearness is the second signal (a
    # date whose weekday also falls on it has two).
    if not (in_named_term or dating.fresh or day - read_on <= YEARLESS_HORIZON):
        if not weekdays:
            return "a date without its year or weekday, months ahead"
        if not (dating.current or dating.term or dating.weekdays):
            return "a yearless date with only its weekday to go on"
    event._year_inferred = True
    return None


def weekdays_agree(events: Sequence[LlmEvent]) -> bool:
    """Whether the page's yearless, weekday-dated dates are this year's as a
    set: at least `MIN_AGREEING_WEEKDAYS` distinct dates fall on the weekday
    their quote states, more than twice as many as those that do not. A
    weekday matches by chance one date in seven, so last year's programme
    (or an old archive) agrees on a few dates at most; a current page with
    one leftover of last year's ("Friday, 10 October" above this year's
    Saturday dates) still agrees."""
    agreeing: set[date] = set()
    disagreeing: set[date] = set()
    for event in events:
        day = _iso(event.date)
        quote = event.when_quote or ""
        if day is None or _YEAR.search(quote):
            continue
        weekdays = _weekdays(quote)
        if not weekdays:
            continue
        (agreeing if day.weekday() in weekdays else disagreeing).add(day)
    return len(agreeing) >= MIN_AGREEING_WEEKDAYS and len(agreeing) > 2 * len(disagreeing)


__all__ = [
    "CURRENT_PAGE",
    "MIN_AGREEING_WEEKDAYS",
    "YEARLESS_HORIZON",
    "PageDating",
    "card_dated_quote",
    "dated_quote",
    "page_dating",
    "weekdays_agree",
    "year_problem",
]
