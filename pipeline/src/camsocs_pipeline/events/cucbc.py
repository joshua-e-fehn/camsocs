"""CUCBC rowing events (source-research §7; stage `cucbc_events`).

Re-verified 2026-10-07: robots.txt asks ``Crawl-delay: 10`` and disallows only
Drupal internals (``/admin/``, ``/user/…``, ``/search/``, …).

Three sources on cucbc.org, all parsed deterministically:

1. **The calendar** (``/calendar/ical/<YYYY-MM>``, one request per month the
   window touches) through `events.ics`. On 2026-10-07 it was empty for every
   month checked (Oct–Nov 2026, Nov 2025, Mar 2026) — kept because it is the
   page the timetable calls the place for confirmed dates.
2. **The Bumps page** (``/bumps``) states each year's dates in a sentence:
   "The Lent Bumps 2026 will take place from Tuesday 3rd March to Saturday 7th
   March 2026." Each becomes one all-day event over the racing days, organised
   by CUCBC.
3. **The timetable** (``/college_events/timetable``) gives the fixed calendar
   CUCBC adopted in 2000, in Full Term weeks ("Fairbairn Cup - Seniors (Jesus)
   — 9th Friday"). Week *N* runs Thursday to Wednesday and Week 1 starts on the
   first Thursday of Full Term (source-research §19; "0th Monday" is the Monday
   before Week 1). Dates come from the verified Full Term dates
   (`seeds.term_dates`). These dates are *computed*, not published: the events
   are ``tbc`` and their times ``inferred``, and the description says so. A
   spec with alternatives ("6th/7th Tuesday") is skipped: the year decides
   which, and the page does not say how. CUCBC events are organised by CUCBC;
   a college-run event by the college boat club its name or bracket names
   ("(Jesus)", "Emmanuel Sprint Regatta").
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from html import unescape

from selectolax.lexbor import LexborHTMLParser

from camsocs_pipeline.events.common import (
    EventDraft,
    EventWindow,
    Sourced,
    Tally,
    default_window,
    describe_failure,
    infer_event_type,
    london_midnight,
    observations_from,
    polite_client,
    write_staging,
)
from camsocs_pipeline.events.ics import IcsError, parse_ics
from camsocs_pipeline.events.organisers import OrganiserIndex
from camsocs_pipeline.keys import slugify
from camsocs_pipeline.models.observation import IdentityHints, OrganiserObs
from camsocs_pipeline.models.wire import TermDate
from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.seeds.term_dates import TERM_DATES

BASE = "https://www.cucbc.org"
BUMPS_URL = f"{BASE}/bumps"
TIMETABLE_URL = f"{BASE}/college_events/timetable"
CRAWL_DELAY = 10.0

SOURCE_TYPE = "cucbc"
EVENT_SOURCE = "cucbc"

CUCBC = IdentityHints(
    name="Cambridge University Combined Boat Clubs",
    aliases=["CUCBC"],
    website_domain="cucbc.org",
)

#: The 31 colleges, as boat-club names use them (longest first when matching).
COLLEGES = (
    "Christ's",
    "Churchill",
    "Clare Hall",
    "Clare",
    "Corpus Christi",
    "Darwin",
    "Downing",
    "Emmanuel",
    "Fitzwilliam",
    "Girton",
    "Gonville and Caius",
    "Caius",
    "Homerton",
    "Hughes Hall",
    "Jesus",
    "King's",
    "Lucy Cavendish",
    "Magdalene",
    "Murray Edwards",
    "Newnham",
    "Pembroke",
    "Peterhouse",
    "Queens'",
    "Robinson",
    "St Catharine's",
    "St Edmund's",
    "St John's",
    "Selwyn",
    "Sidney Sussex",
    "Trinity Hall",
    "Trinity",
    "Wolfson",
)

_WEEKDAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
_MONTHS = (
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
)
_ORDINAL_DAY = (
    r"(\d{1,2})(?:st|nd|rd|th)\s+(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)"
)
_SPEC = re.compile(rf"^{_ORDINAL_DAY}(?:\s*[-–]\s*{_ORDINAL_DAY})?$", re.IGNORECASE)
_BUMPS = re.compile(
    r"(?P<term>Lent|May) Bumps (?P<year>\d{4}) will take place from (?:\w+day )?"
    r"(?P<d1>\d{1,2})(?:st|nd|rd|th)? (?P<m1>[A-Za-z]+)(?: (?P<y1>\d{4}))? to (?:\w+day )?"
    r"(?P<d2>\d{1,2})(?:st|nd|rd|th)? (?P<m2>[A-Za-z]+) (?P<y2>\d{4})",
    re.IGNORECASE,
)
_TERMS = {"michaelmas": "michaelmas", "lent": "lent", "easter": "easter"}


# --- the Bumps page -----------------------------------------------------------------------


@dataclass(frozen=True)
class Bumps:
    term: str
    year: int
    first: date
    last: date


def _page_text(html: str) -> str:
    tree = LexborHTMLParser(html)
    body = tree.body
    text = body.text(separator=" ") if body is not None else ""
    return " ".join(unescape(text).replace("\u00a0", " ").split())


def _month(name: str) -> int | None:
    lowered = name.lower()
    return _MONTHS.index(lowered) + 1 if lowered in _MONTHS else None


def parse_bumps(html: str) -> list[Bumps]:
    found: list[Bumps] = []
    for match in _BUMPS.finditer(_page_text(html)):
        m1, m2 = _month(match["m1"]), _month(match["m2"])
        if m1 is None or m2 is None:
            continue
        try:
            last = date(int(match["y2"]), m2, int(match["d2"]))
            first = date(int(match["y1"] or match["y2"]), m1, int(match["d1"]))
        except ValueError:
            continue
        if first <= last <= first + timedelta(days=10):
            found.append(Bumps(match["term"].title(), int(match["year"]), first, last))
    return found


def bumps_draft(bumps: Bumps) -> EventDraft:
    return EventDraft(
        event_source=EVENT_SOURCE,
        external_id=f"bumps:{bumps.term.lower()}:{bumps.year}",
        title=f"{bumps.term} Bumps {bumps.year}",
        starts_at=london_midnight(bumps.first),
        ends_at=london_midnight(bumps.last + timedelta(days=1)),
        all_day=True,
        page_url=BUMPS_URL,
        event_type="competition",
        organisers=[OrganiserObs(identity=CUCBC, role="organiser")],
    )


# --- the timetable -------------------------------------------------------------------------


@dataclass(frozen=True)
class TimetableRow:
    term: str
    section: str
    name: str
    spec: str


def parse_timetable(html: str) -> list[TimetableRow]:
    tree = LexborHTMLParser(html)
    rows: list[TimetableRow] = []
    term: str | None = None
    section = ""
    for node in tree.css("h2, h3, table"):
        text = " ".join(node.text().split())
        if node.tag == "h2":
            term = _TERMS.get(text.split()[0].lower()) if text else None
            continue
        if node.tag == "h3":
            section = text
            continue
        if term is None:
            continue
        carry: tuple[str, int] | None = None
        for row in node.css("tr"):
            cells = [" ".join(td.text().split()) for td in row.css("td")]
            if len(cells) >= 2:
                name, spec = cells[0], cells[1]
                span = row.css("td")[1].attributes.get("rowspan")
                carry = (spec, int(span) - 1) if span and span.isdigit() and int(span) > 1 else None
            elif len(cells) == 1 and carry is not None and carry[1] > 0:
                name, spec = cells[0], carry[0]
                carry = (carry[0], carry[1] - 1)
            else:
                continue
            if name and spec:
                rows.append(TimetableRow(term=term, section=section, name=name, spec=spec))
    return rows


def week_day(full_term_start: date, week: int, weekday: str) -> date:
    """The ``weekday`` of Full Term week ``week`` (weeks run Thursday–Wednesday;
    Week 1 starts on the first Thursday of Full Term)."""
    first_thursday = full_term_start + timedelta(days=(3 - full_term_start.weekday()) % 7)
    thursday = first_thursday + timedelta(weeks=week - 1)
    return thursday + timedelta(days=(_WEEKDAYS.index(weekday.lower()) - 3) % 7)


def spec_dates(spec: str, full_term_start: date) -> tuple[date, date] | None:
    """``(first, last)`` for "9th Thursday" or "0th Monday - 0th Wednesday";
    None for anything with alternatives or that does not parse."""
    if "/" in spec:
        return None
    match = _SPEC.match(spec.strip())
    if match is None:
        return None
    first = week_day(full_term_start, int(match[1]), match[2])
    last = week_day(full_term_start, int(match[3]), match[4]) if match[3] else first
    return (first, last) if last >= first else None


def _boat_club(name: str) -> IdentityHints | None:
    bracket = re.search(r"\(([^()]+)\)", name)
    candidates = [bracket.group(1)] if bracket else []
    candidates.append(name)
    for text in candidates:
        cleaned = text.replace(".", "").replace("’", "'").strip()
        for college in COLLEGES:
            if re.match(rf"{re.escape(college)}(?!\w)", cleaned, re.IGNORECASE):
                return IdentityHints(
                    name=college,
                    org_type="college_boat_club",
                    college_hint=college,
                    cucbc_club=college,
                )
    return None


def timetable_drafts(
    rows: list[TimetableRow], terms: tuple[TermDate, ...] = TERM_DATES
) -> list[EventDraft]:
    drafts: list[EventDraft] = []
    for row in rows:
        organiser = CUCBC if row.section.lower().startswith("cucbc") else _boat_club(row.name)
        for term in terms:
            if term.term != row.term:
                continue
            dates = spec_dates(row.spec, date.fromisoformat(term.full_term_start))
            if dates is None:
                continue
            first, last = dates
            drafts.append(
                EventDraft(
                    event_source=EVENT_SOURCE,
                    external_id=f"timetable:{term.academic_year}:{term.term}:{slugify(row.name)}",
                    title=row.name,
                    starts_at=london_midnight(first),
                    ends_at=london_midnight(last + timedelta(days=1)),
                    all_day=True,
                    description=(
                        f'Date from the CUCBC fixed calendar ("{row.spec}" of '
                        f"{row.term.title()} Full Term); not yet confirmed in the CUCBC calendar."
                    ),
                    page_url=TIMETABLE_URL,
                    event_type="competition",
                    status="tbc",
                    organisers=[OrganiserObs(identity=organiser, role="organiser")]
                    if organiser
                    else [],
                    inferred={"startsAt", "endsAt"},
                )
            )
    return drafts


# --- the stage -------------------------------------------------------------------------------


def ical_url(year: int, month: int) -> str:
    return f"{BASE}/calendar/ical/{year:04d}-{month:02d}"


def run(
    ctx: StageContext, *, window: EventWindow | None = None, now: datetime | None = None
) -> None:
    window = window or default_window(now)
    index = OrganiserIndex.from_staging(ctx.staging)
    tally = Tally()
    pending: list[Sourced] = []
    calendar_events = 0
    with polite_client(ctx.settings, min_interval=CRAWL_DELAY) as client:
        months = window.months()
        if ctx.limit is not None:
            months = months[: ctx.limit]
        for year, month in months:
            url = ical_url(year, month)
            result = client.fetch(url, accept="text/calendar,*/*;q=0.5")
            if not result.ok or result.content is None:
                ctx.report.notes.append(f"calendar {year}-{month:02d}: {describe_failure(result)}")
                continue
            try:
                calendar = parse_ics(result.content, window)
            except IcsError as error:
                ctx.report.notes.append(f"calendar {year}-{month:02d}: {error}")
                continue
            calendar_events += len(calendar.events)
            for event in calendar.events:
                event_type, guessed = infer_event_type(event.title, default="competition")
                pending.append(
                    Sourced(
                        EventDraft(
                            event_source=EVENT_SOURCE,
                            external_id=event.external_id,
                            title=event.title,
                            starts_at=event.starts_at,
                            ends_at=event.ends_at,
                            all_day=event.all_day,
                            description=event.description,
                            page_url=event.url,
                            venue=IdentityHints(name=event.location) if event.location else None,
                            event_type=event_type,
                            cancelled=event.status == "CANCELLED",
                            organisers=[OrganiserObs(identity=CUCBC, role="organiser")],
                            inferred=({"eventType"} if guessed else set())
                            | ({"startsAt", "endsAt"} if event.zone_corrected else set()),
                        ),
                        url,
                        result,
                        evidence="primary",
                    )
                )
        bumps_result = client.fetch(BUMPS_URL)
        if bumps_result.ok:
            for bumps in parse_bumps(bumps_result.text):
                pending.append(
                    Sourced(bumps_draft(bumps), BUMPS_URL, bumps_result, evidence="primary")
                )
        else:
            ctx.report.notes.append(f"bumps: {describe_failure(bumps_result)}")
        timetable_result = client.fetch(TIMETABLE_URL)
        if timetable_result.ok:
            for draft in timetable_drafts(parse_timetable(timetable_result.text)):
                pending.append(
                    Sourced(draft, TIMETABLE_URL, timetable_result, evidence="secondary")
                )
        else:
            ctx.report.notes.append(f"timetable: {describe_failure(timetable_result)}")
    ctx.report.notes.append(f"calendar: {calendar_events} events in {len(months)} months")
    records = observations_from(
        pending,
        window,
        tally,
        source_type=SOURCE_TYPE,
        evidence="primary",
        index=index,
        crawl_delay=True,
        now=now,
    )
    write_staging(ctx, records, tally)


__all__ = [
    "Bumps",
    "TimetableRow",
    "bumps_draft",
    "ical_url",
    "parse_bumps",
    "parse_timetable",
    "run",
    "spec_dates",
    "timetable_drafts",
    "week_day",
]
