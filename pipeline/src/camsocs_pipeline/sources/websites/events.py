"""Society websites' events pages → events (source-research §14 "Events
pages"; stage `website_events`).

**Which pages.** The organisations the enrichment stage read a website for
(``var/staging/society_website``: the home page's observation carries
``websiteDomain`` and ``websiteHealth``). From the home page, the stage picks
at most `MAX_EVENT_PAGES` pages inside the site whose link says events,
calendar, what's on, term card, programme, fixtures or upcoming
(`discover.choose_pages`' "events" page first), never an archive of past
events, never a year-dated path older than this year; the home page itself
counts when it lists upcoming events. Pages are read through the polite
client with the society-website purpose (decision D3, 2026-10-08: society
pages may be read where robots.txt disallows, and their AI opt-outs do not
keep them from the model — never talks.cam or tbc.xyz), from the cache the
enrichment stage filled when it is younger than `FRESH_FOR`. ``noindex``
pages are not read, and ``nofollow`` stops the discovery, as in enrichment.
Each page's AI opt-outs (robots.txt, ``noai``) are checked as enrichment
checks them (`site.ai_reading`); a page read only through the override says
``ai_optout_override:society`` on its events' `sources` rows.

**Structured data first.** A page's JSON-LD / microdata ``Event`` items
(The Events Calendar, Squarespace, Wix and others publish them) are read by a
parser: name, start and end (a date without a time is all day), location,
the event's URL, image, description and cancellation — ``found`` values.

**Then the model** (bulk tier, prompt `website_events_v1`) over the page's
cleaned text (contacts redacted, at most `MAX_PROMPT_CHARS`), for pages with
no structured events. Each event must carry a ``when_quote`` that is on the
page and holds its date — the day number with a month, a numeric date, or a
term week with its weekday (`dated_quote`); an event without one is dropped.
A page cannot say "today" (it has no date of its own), so relative days are
dropped too. A calendar date's year must be the one its quote states; a
yearless date is never taken from a page about an earlier season (a
"2025/2026 season" post, a fixtures table scored "2025-26", an archive whose
latest year is last season's: `page_dating`), and needs a second signal —
its stated weekday falls on it that year *and* the page names this year or
the term, or most of the page's own weekday-dated dates fall on their
weekdays this year too (at least three, against fewer than half as many
that do not: `weekdays_agree`; chance matches one weekday in seven), or,
with no weekday, it lies within eight weeks of the day the page was read
(`year_problem`: pages keep last year's programme online without its
year). The year of a yearless date is our inference, so its start is
``inferred``. The reference date the model is given is the Thursday that
starts the week the page was read (`week_anchor`), so a re-read within the
week costs nothing. Dates are resolved in code (`extract.when`); term weeks need the
term the page names (or its URL / title says), else the event is dropped as
possibly last term's. An event without a stated time is all day, its start
``inferred``. Quotes are checked against the text sent (`claims.llm_field`).

**Which events.** Upcoming ones: an event that ends before today (London) is
dropped as past, one starting more than `HORIZON` (nine months) ahead as
implausible. Visibility is ``public`` — the society published it — or
``members_only`` where the page says so. The organiser is the site's
organisation. External ids are ``<org key>:<date>:<title slug>`` for both
paths, so a structured reading and a model reading of one event are one
event; another source's reading of the same evening (a feed, Camdram) is
merged at load (`events.duplicates`), the structured listing kept as primary.

Replies are cached by prompt and text (`extract.memo`), so an unchanged page
costs nothing on later runs. The stage writes the full current set to
``var/staging/society_website.events/``: with ``--limit``, the previous
file's events of organisations not reached this run are carried forward.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Iterable, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field, replace
from datetime import UTC, date, datetime, timedelta
from html import unescape
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from camsocs_pipeline.config import ConfigError
from camsocs_pipeline.events.checks import is_booking, is_venue_booking_page
from camsocs_pipeline.events.common import (
    LONDON,
    EventDraft,
    EventWindow,
    Sourced,
    Tally,
    clean_text,
    fetch_info,
    fetched_at,
    infer_event_type,
    london_midnight,
    observations_from,
)
from camsocs_pipeline.extract.events import (
    EventContext,
    LlmEvent,
    LlmEvents,
    build_events,
    extract_events,
    load_prompt,
    redact_contacts,
    title_slug,
)
from camsocs_pipeline.extract.evidence import EvidenceMatch, check_quote
from camsocs_pipeline.extract.llm import (
    LLMClient,
    LLMValidationError,
    NoLLMHost,
    assert_llm_source_allowed,
)
from camsocs_pipeline.extract.memo import LLMMemo
from camsocs_pipeline.extract.when import TermCalendar, london_date, week_anchor
from camsocs_pipeline.media import probe_image
from camsocs_pipeline.models.observation import (
    EventObservation,
    IdentityHints,
    Observation,
    OrganiserObs,
)
from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.sources.base import FetchResult, PoliteClient
from camsocs_pipeline.sources.policy import AI_OVERRIDE_NOTE, SOCIETY_WEBSITE
from camsocs_pipeline.sources.termcards import term_hint
from camsocs_pipeline.sources.websites.discover import choose_pages, in_scope
from camsocs_pipeline.sources.websites.page import Page, parse_page
from camsocs_pipeline.sources.websites.site import ai_reading, with_note
from camsocs_pipeline.staging.store import events_directory

logger = logging.getLogger(__name__)

SOURCE_TYPE = "society_website"
EVENT_SOURCE = "website"
PROMPT = "website_events_v1"
EVIDENCE = "primary"
#: The enrichment stage's page cache age (`sources.websites.enrich.FRESH_FOR`).
FRESH_FOR = timedelta(days=3)
#: Events further ahead than this are not announcements of this year's events.
HORIZON = timedelta(days=274)
MAX_EVENT_PAGES = 2
MAX_PROMPT_CHARS = 12_000
COVERS = frozenset({"description", "endsAt", "venueText"})

_EVENT_WORDS = re.compile(
    r"(?<![a-z])(events?|calendar|what'?s[- ]?on|term[- ]?cards?|termcard|programme|"
    r"upcoming|fixtures|diary)(?![a-z])",
    re.I,
)
_PAST_EVENTS = re.compile(r"past[- ]?events|previous[- ]?events|event[- ]?archive|/archive", re.I)
_YEAR_PATH = re.compile(r"/(20\d\d)(?:/|$)")
_HOME_LISTS = re.compile(
    r"upcoming events?|next events?|what'?s on|events? this (?:week|term)|term ?card|"
    r"this term'?s (?:events|programme)",
    re.I,
)
_EVENT_TYPE = re.compile(r"(?:^|[^A-Za-z])(?:[A-Za-z]*Event|Festival)$")

_MONTH = (
    r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|"
    r"sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
)
_DAY_MONTH = re.compile(rf"\b(\d{{1,2}})(?:st|nd|rd|th)?\.?\s*(?:of\s+)?{_MONTH}\b", re.I)
_MONTH_DAY = re.compile(rf"\b{_MONTH}\.?\s+(\d{{1,2}})(?:st|nd|rd|th)?\b", re.I)
_NUMERIC_DATE = re.compile(r"\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2}|\d{4}))?\b")
_ISO_DATE = re.compile(r"\b20\d\d-(\d\d)-(\d\d)\b")
_WEEK = re.compile(r"\b(?:week|wk)\.?\s*(\d{1,2})\b|\b(\d{1,2})(?:st|nd|rd|th)\s+week\b", re.I)
_WEEKDAY = re.compile(r"\b(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\b", re.I)
_WEEKDAY_NAME = re.compile(
    r"\b(mon|tue|wed|thu|fri|sat|sun)(?:day|s|sday|nesday|rsday|urday|r|rs|t)?\.?\b", re.I
)
_WEEKDAYS = {"mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6}
_YEAR = re.compile(r"\b(20\d\d)\b")
#: A date a page gives without its year or weekday is trusted this far ahead.
YEARLESS_HORIZON = timedelta(weeks=8)


@dataclass(frozen=True)
class Site:
    """An organisation whose own website the enrichment stage read."""

    org_key: str
    org_name: str
    #: The home page as read (the final URL after redirects).
    home_url: str
    #: The website as a register states it, when it redirected to `home_url`:
    #: the fetch cache holds the home page under this URL.
    stated_urls: tuple[str, ...] = ()


@dataclass
class SiteResult:
    site: Site
    events: list[EventObservation] = field(default_factory=list)
    pages: int = 0
    structured: int = 0
    llm_calls: int = 0
    llm_cached: int = 0
    tally: Tally = field(default_factory=Tally)
    notes: list[str] = field(default_factory=list)


# --- which sites, which pages ------------------------------------------------------------


def sites_from(records: Iterable[object]) -> list[Site]:
    """One `Site` per organisation whose home page enrichment read (its
    observation carries ``website_domain`` and ``website_health``)."""
    homes: dict[str, Observation] = {}
    stated: dict[str, list[str]] = {}
    for record in records:
        if not (
            isinstance(record, Observation)
            and record.entity_type == "organisation"
            and record.entity_key
            and record.source_type == SOURCE_TYPE
        ):
            continue
        if record.internal.get("website_domain") and record.internal.get("website_health"):
            homes.setdefault(record.entity_key, record)
        elif any(f.field == "website" for f in record.fields):
            stated.setdefault(record.entity_key, []).append(record.source_url)
    return [
        Site(
            key,
            homes[key].identity.name,
            homes[key].source_url,
            tuple(url for url in stated.get(key, []) if url != homes[key].source_url),
        )
        for key in sorted(homes)
    ]


def _norm(url: str) -> str:
    parts = urlsplit(url.split("#", 1)[0])
    return urlunsplit(
        (parts.scheme, parts.netloc.lower(), parts.path.rstrip("/") or "/", parts.query, "")
    )


def event_pages(home: Page, *, today: date) -> list[str]:
    """The pages of the site worth reading for events (module docstring)."""
    if {"nofollow", "none"} & home.robots:
        return []
    home_norm = _norm(home.url)
    chosen = choose_pages(home.url, home.links).get("events")
    scored: list[tuple[float, str]] = []
    for link in home.links:
        target = _norm(link.url)
        if target == home_norm or not in_scope(target, home.url):
            continue
        path = urlsplit(target).path
        if _PAST_EVENTS.search(path) or _PAST_EVENTS.search(link.text):
            continue
        year = _YEAR_PATH.search(path)
        if year and int(year.group(1)) < today.year:
            continue
        score = 2.0 * bool(_EVENT_WORDS.search(path.replace("_", "-")))
        score += bool(_EVENT_WORDS.search(link.text))
        if not score:
            continue
        depth = len([part for part in path.split("/") if part])
        scored.append((score - 0.25 * max(depth - 1, 0), target))
    ordered: list[str] = []
    if chosen and not _PAST_EVENTS.search(chosen):
        ordered.append(_norm(chosen))
    for _score, url in sorted(scored, key=lambda pair: (-pair[0], pair[1])):
        if url not in ordered:
            ordered.append(url)
    return ordered[:MAX_EVENT_PAGES]


def home_lists_events(home: Page) -> bool:
    return bool(_HOME_LISTS.search(home.text[:20_000]))


# --- structured data -------------------------------------------------------------------------


def _types(item: dict[str, Any]) -> list[str]:
    value = item.get("@type")
    values = value if isinstance(value, list) else [value]
    return [v for v in values if isinstance(v, str)]


def structured_events(page: Page) -> list[dict[str, Any]]:
    """JSON-LD and microdata items of an ``Event`` type (``SocialEvent``,
    ``TheaterEvent``, ``Festival`` …), including those inside ``@graph``."""
    found: list[dict[str, Any]] = []
    for syntax in ("json-ld", "microdata"):
        stack: list[Any] = list(page.structured.get(syntax) or [])
        while stack:
            item = stack.pop(0)
            if isinstance(item, list):
                stack.extend(item)
                continue
            if not isinstance(item, dict):
                continue
            if isinstance(item.get("@graph"), list):
                stack.extend(item["@graph"])
            if any(_EVENT_TYPE.search(t) for t in _types(item)):
                found.append(item)
    return found


def _text(value: Any) -> str | None:
    if isinstance(value, list):
        value = next((v for v in value if isinstance(v, str) and v.strip()), None)
    if not isinstance(value, str):
        return None
    return clean_text(unescape(value)) or None


def _when(value: Any) -> tuple[datetime, bool] | None:
    """``(aware start, all_day)`` from a schema.org date or date-time."""
    text = _text(value)
    if not text:
        return None
    try:
        if len(text) == 10:
            return london_midnight(date.fromisoformat(text)), True
        moment = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=LONDON)
    return moment, False


def _location(value: Any) -> str | None:
    if isinstance(value, list):
        value = value[0] if value else None
    if isinstance(value, str):
        return _text(value)
    if not isinstance(value, dict):
        return None
    if any("VirtualLocation" in t for t in _types(value)):
        return "Online"
    name = _text(value.get("name"))
    address = value.get("address")
    if isinstance(address, dict):
        address = ", ".join(
            part
            for part in (
                _text(address.get("streetAddress")),
                _text(address.get("addressLocality")),
                _text(address.get("postalCode")),
            )
            if part
        )
    address_text = _text(address) if address else None
    if name and address_text and address_text not in name:
        return f"{name}, {address_text}"
    return name or address_text


def _url(value: Any) -> str | None:
    if isinstance(value, dict):
        value = value.get("url") or value.get("@id")
    if isinstance(value, list):
        value = next((v for v in value if isinstance(v, str)), None)
    if isinstance(value, str) and value.startswith(("http://", "https://")):
        return value
    return None


def structured_draft(item: dict[str, Any], site: Site) -> EventDraft | None:
    """One structured ``Event`` item → a parser draft (module docstring)."""
    title = _text(item.get("name"))
    start = _when(item.get("startDate"))
    if not title or start is None:
        return None
    starts_at, all_day = start
    end = _when(item.get("endDate"))
    ends_at = end[0] if end else None
    if all_day:
        last = ends_at.astimezone(LONDON).date() if ends_at else starts_at.date()
        ends_at = london_midnight(
            max(last, starts_at.astimezone(LONDON).date()) + timedelta(days=1)
        )
    status = " ".join(_types({"@type": item.get("eventStatus")}) or [str(item.get("eventStatus"))])
    local_day = starts_at.astimezone(LONDON).date()
    return EventDraft(
        event_source=EVENT_SOURCE,
        external_id=f"{site.org_key}:{local_day.isoformat()}:{title_slug(title)}",
        title=title,
        starts_at=starts_at,
        ends_at=ends_at,
        all_day=all_day,
        description=_text(item.get("description")),
        page_url=_url(item.get("url")),
        venue=IdentityHints(name=venue) if (venue := _location(item.get("location"))) else None,
        event_type=infer_event_type(title),
        image_url=_url(item.get("image")),
        cancelled=True if "Cancelled" in status else None,
        status="tbc" if ("Postponed" in status or "Rescheduled" in status) else "confirmed",
        organisers=[
            OrganiserObs(identity=IdentityHints(name=site.org_name, known_key=site.org_key))
        ],
        inferred={"eventType"},
        covers=COVERS,
    )


# --- the model's reading --------------------------------------------------------------------


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
        weeks = {int(m.group(1) or m.group(2)) for m in _WEEK.finditer(quote)}
        return event.term_week in weeks and bool(_WEEKDAY.search(quote))
    return False


def _iso(value: str | None) -> date | None:
    try:
        return date.fromisoformat((value or "").strip()[:10])
    except ValueError:
        return None


#: An academic year or a season as pages write it: "2025/2026", "2025-26".
_SEASON = re.compile(r"\b(20\d\d)\s*[/–-]\s*(20\d\d|\d\d)\b")


@dataclass(frozen=True)
class PageDating:
    """What a page says about its own year (`page_dating`)."""

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
    """Why the year of a calendar date cannot be trusted, or None. Pages keep
    last year's programme online without its year, and "5 March" read in
    October is then next March to a reader who guesses. So the year must be
    the one the quote states; a yearless date is never taken from a page
    about an earlier season (`page_dating`), and needs a second signal: the
    weekday the quote states must fall on that date in that year *and* the
    page must name this year or the term, or (with no weekday) it must lie
    within `YEARLESS_HORIZON` of the day the page was read. A yearless date
    kept is our inference (`LlmEvent._year_inferred`)."""
    day = _iso(event.date)
    if day is None:
        return None
    quote = event.when_quote or ""
    years = {int(y) for y in _YEAR.findall(quote)}
    if years:
        return None if day.year in years else "the year differs from the page's"
    if dating.stale is not None:
        return dating.stale
    weekdays = {_WEEKDAYS[m.group(1).lower()[:3]] for m in _WEEKDAY_NAME.finditer(quote)}
    if weekdays:
        if day.weekday() not in weekdays:
            return "the weekday does not fall on that date"
        if not (dating.current or dating.term or dating.weekdays):
            return "a yearless date with only its weekday to go on"
    elif day - read_on > YEARLESS_HORIZON:
        return "a date without its year or weekday, months ahead"
    event._year_inferred = True
    return None


#: How many of a page's yearless dates must fall on their stated weekdays
#: this year for the page's dates to count as this year's (`weekdays_agree`).
MIN_AGREEING_WEEKDAYS = 3


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
        weekdays = {_WEEKDAYS[m.group(1).lower()[:3]] for m in _WEEKDAY_NAME.finditer(quote)}
        if not weekdays:
            continue
        (agreeing if day.weekday() in weekdays else disagreeing).add(day)
    return len(agreeing) >= MIN_AGREEING_WEEKDAYS and len(agreeing) > 2 * len(disagreeing)


def page_text(page: Page) -> str:
    """The text the model reads and quotes are checked against: the title and
    the page's cleaned text, contacts redacted, cut to `MAX_PROMPT_CHARS`."""
    body = f"{page.title}\n\n{page.text}" if page.title else page.text
    return redact_contacts(body)[:MAX_PROMPT_CHARS]


def llm_events(
    page: Page,
    result: FetchResult,
    site: Site,
    *,
    llm: LLMClient,
    memo: LLMMemo | None,
    calendar: TermCalendar,
    out: SiteResult,
    source_type: str = SOURCE_TYPE,
    event_source: str = EVENT_SOURCE,
    ai_override: bool = False,
) -> list[EventObservation]:
    """The model's reading of one page, filtered as the module docstring says
    (also a termcard that is an HTML page: `source_type` / `event_source`
    ``termcard``). `ai_override`: the page reached the model only through the
    D3 override of an AI opt-out, which its events' `sources` rows record."""
    assert_llm_source_allowed(page.url)
    text = page_text(page)
    if len(text.strip()) < 40:
        return []
    retrieved = fetched_at(result)
    anchor = week_anchor(london_date(retrieved))
    prompt, version = load_prompt(PROMPT)
    request = f"{calendar.context(anchor)}\n\n--- PAGE {page.url} ---\n{text}"
    extraction = extract_events(
        llm, memo, prompt=prompt, prompt_version=version, text=request, tier="bulk"
    )
    out.llm_calls += 1
    out.llm_cached += extraction.cached
    extracted = extraction.value
    term_name, term_year = extracted.term, extracted.term_year
    if term_name is None:
        term_name, term_year = term_hint(f"{page.url} {page.title}")
    term = calendar.term_named(term_name, term_year, anchor)
    read_on = london_date(retrieved)
    dating = page_dating(text, read_on, term=term is not None)
    if dating.stale is None and weekdays_agree(extracted.events):
        dating = replace(dating, weekdays=True)
    if is_venue_booking_page(text):
        # A venue's booking calendar: other groups' functions, not events of
        # the site's organisation.
        out.tally.drop("a venue's booking calendar", len(extracted.events))
        return []
    kept: list[LlmEvent] = []
    for event in extracted.events:
        if is_booking(event.title):
            out.tally.drop("a room booking, not an event")
        elif not dated_quote(event, text):
            out.tally.drop("no dated quote on the page")
        elif (problem := year_problem(event, read_on, dating)) is not None:
            out.tally.drop(problem)
        else:
            kept.append(event)
    context = EventContext(
        source_type=source_type,
        event_source=event_source,
        source_url=page.url,
        retrieved_at=retrieved,
        source_text=text,
        model=extraction.model,
        prompt_version=version,
        evidence=EVIDENCE,
        visibility="public",
        anchor=anchor,
        calendar=calendar,
        term=term,
        require_term=True,
        scope=site.org_key,
        organiser_key=site.org_key,
        organiser_name=site.org_name,
        fetch=with_note(fetch_info(result), AI_OVERRIDE_NOTE)
        if ai_override
        else fetch_info(result),
    )
    events, dropped = build_events(LlmEvents(events=kept), context)
    for reason in dropped:
        if "long before" in reason:
            out.tally.drop("past")
        elif "implausibly far" in reason:
            out.tally.drop("more than nine months ahead")
        else:
            out.tally.drop("undated or term-less")
    return events


# --- one site ----------------------------------------------------------------------------------


def _start(record: EventObservation) -> datetime | None:
    for obs in record.fields:
        if obs.field == "startsAt" and isinstance(obs.value, int):
            return datetime.fromtimestamp(obs.value / 1000, tz=UTC)
    return None


def _end(record: EventObservation) -> datetime | None:
    for obs in record.fields:
        if obs.field == "endsAt" and isinstance(obs.value, int):
            return datetime.fromtimestamp(obs.value / 1000, tz=UTC)
    return None


def current(records: Sequence[EventObservation], window: EventWindow, tally: Tally) -> list:
    """Upcoming events only: not over before today, starting within `HORIZON`."""
    kept: list[EventObservation] = []
    for record in records:
        start = _start(record)
        if start is None:
            continue
        end = _end(record) or start
        if max(start, end) < window.start:
            tally.drop("past")
        elif start >= window.end:
            tally.drop("more than nine months ahead")
        else:
            kept.append(record)
    return kept


def window_from(now: datetime) -> EventWindow:
    today = london_date(now)
    return EventWindow(start=london_midnight(today), end=london_midnight(today) + HORIZON)


def _fetch(client: PoliteClient, url: str) -> FetchResult:
    return client.fetch(url, fresh_for=FRESH_FOR, purpose=SOCIETY_WEBSITE)


def _home(client: PoliteClient, site: Site) -> FetchResult:
    """The home page: the copy enrichment cached (under the URL it asked
    for, which may have redirected), else a polite fetch."""
    for url in site.stated_urls:
        cached = client.cached(url, SOCIETY_WEBSITE)
        if cached is not None and cached.final_url == site.home_url:
            fresh = _fetch(client, url)
            if fresh.ok:
                return fresh
    return _fetch(client, site.home_url)


def read_site(
    client: PoliteClient,
    site: Site,
    *,
    llm: LLMClient | None,
    memo: LLMMemo | None,
    calendar: TermCalendar,
    now: datetime,
) -> SiteResult:
    """Every upcoming event one society's website lists (module docstring)."""
    out = SiteResult(site)
    window = window_from(now)
    home_result = _home(client, site)
    if not home_result.ok or "html" not in (home_result.content_type or "html").lower():
        out.notes.append(f"{site.org_key}: home page not read ({home_result.outcome})")
        return out
    home = parse_page(home_result.final_url or site.home_url, home_result.text)
    if {"noindex", "none"} & home.robots:
        return out
    pages: list[tuple[Page, FetchResult]] = []
    if home_lists_events(home):
        pages.append((home, home_result))
    for url in event_pages(home, today=london_date(now)):
        result = _fetch(client, url)
        if not result.ok or "html" not in (result.content_type or "html").lower():
            continue
        page = parse_page(result.final_url or url, result.text)
        if {"noindex", "none"} & page.robots:
            continue
        pages.append((page, result))
    pending: list[Sourced] = []
    model_read: list[EventObservation] = []
    for page, result in pages:
        out.pages += 1
        items = structured_events(page)
        drafts = [d for d in (structured_draft(item, site) for item in items) if d is not None]
        if drafts:
            out.structured += len(drafts)
            images: dict[str, str | None] = {}
            for draft in drafts:
                if draft.image_url and draft.image_url not in images:
                    images[draft.image_url] = (
                        draft.image_url
                        if probe_image(
                            client, draft.image_url, purpose=SOCIETY_WEBSITE.bound_to(page.url)
                        )
                        else None
                    )
                draft.image_url = images.get(draft.image_url) if draft.image_url else None
                pending.append(Sourced(draft, page.url, result))
            continue
        if llm is None:
            continue
        # §14: per page, an AI opt-out (robots.txt or the page's own `noai`)
        # holds unless the D3 society override lifts it — which the events'
        # `sources` rows then say (`ai_optout_override:society`).
        reading = ai_reading(client, page, SOCIETY_WEBSITE.bound_to(site.home_url))
        if reading == "refused":
            out.notes.append(f"{site.org_key}: {page.url} keeps AI out — not read by the model")
            continue
        try:
            model_read += llm_events(
                page,
                result,
                site,
                llm=llm,
                memo=memo,
                calendar=calendar,
                out=out,
                ai_override=reading == "override",
            )
        except LLMValidationError:
            out.tally.drop("reply did not validate")
        except NoLLMHost:
            continue
    structured = observations_from(
        pending, window, out.tally, source_type=SOURCE_TYPE, evidence=EVIDENCE, index=None, now=now
    )
    seen = {record.external_id for record in structured}
    for record in current(model_read, window, out.tally):
        if record.external_id not in seen:
            seen.add(record.external_id)
            structured.append(record)
    out.events = structured
    return out


# --- the stage -----------------------------------------------------------------------------------


def _organiser(record: EventObservation) -> str | None:
    keys = [o.identity.known_key for o in record.organisers if o.identity.known_key]
    return keys[0] if keys else None


def run(ctx: StageContext, *, now: datetime | None = None) -> None:
    now = now or datetime.now(UTC)
    sites = sites_from(ctx.staging.read_latest(SOURCE_TYPE))
    if not sites:
        ctx.report.notes.append("no society website read yet — run enrich first")
        return
    total = len(sites)
    if ctx.limit is not None:
        sites = sites[: ctx.limit]
    if ctx.dry_run:
        _dry_run(ctx, sites, now)
        return
    settings = ctx.settings
    llm: LLMClient | None = None
    try:
        llm = LLMClient(settings.require_llm())
    except ConfigError as error:
        ctx.report.notes.append(f"LLM not configured ({error}) — structured data only")
    memo = LLMMemo(settings.cache_dir / "llm")
    calendar = TermCalendar.default()
    with PoliteClient(
        user_agent=settings.require_user_agent(),
        cache_dir=settings.cache_dir,
        min_interval=settings.min_host_interval,
        max_retries=1,
    ) as client:
        workers = max(1, settings.llm_concurrency)
        with ThreadPoolExecutor(max_workers=workers) as pool:
            results = list(
                pool.map(
                    lambda site: _safe_read(client, site, llm, memo, calendar, now, ctx), sites
                )
            )
    events = [event for result in results for event in result.events]
    reached = {site.org_key for site in sites}
    with_sites = {site.org_key for site in sites_from(ctx.staging.read_latest(SOURCE_TYPE))}
    carried = [
        record
        for record in ctx.staging.read_latest(events_directory(SOURCE_TYPE))
        if isinstance(record, EventObservation)
        and (organiser := _organiser(record)) in with_sites
        and organiser not in reached
    ]
    current_set = [*carried, *events]
    if current_set:
        ctx.staging.write(events_directory(SOURCE_TYPE), ctx.run.run_key, current_set)
    # Staged: the events read this run are new; carried ones are unchanged
    # (as termcards and instagram count them; `load` reports what reached Convex).
    ctx.report.inserted += len(events)
    ctx.report.unchanged += len(carried)
    tally = Tally()
    for result in results:
        for reason, count in result.tally.dropped.items():
            tally.drop(reason, count)
    pages = sum(r.pages for r in results)
    ctx.report.notes.append(
        f"{total} sites read by enrichment; {len(sites)} read for events, {pages} pages; "
        f"{sum(r.structured for r in results)} structured events, "
        f"{sum(r.llm_calls for r in results)} model reads "
        f"({sum(r.llm_cached for r in results)} cached); {len(events)} events from "
        f"{sum(1 for r in results if r.events)} sites"
        + (f", {len(carried)} carried forward" if carried else "")
    )
    if tally.dropped:
        ctx.report.notes.append(
            "left out: " + ", ".join(f"{n} {why}" for why, n in sorted(tally.dropped.items()))
        )
    for result in results:
        ctx.report.notes.extend(f"  {note}" for note in result.notes[:2])


def _safe_read(
    client: PoliteClient,
    site: Site,
    llm: LLMClient | None,
    memo: LLMMemo | None,
    calendar: TermCalendar,
    now: datetime,
    ctx: StageContext,
) -> SiteResult:
    try:
        return read_site(client, site, llm=llm, memo=memo, calendar=calendar, now=now)
    except Exception as error:  # one broken site must not end the stage
        logger.exception("events of %s failed", site.org_key)
        result = SiteResult(site)
        result.notes.append(f"{site.org_key}: failed ({type(error).__name__})")
        return result


def _dry_run(ctx: StageContext, sites: list[Site], now: datetime) -> None:
    """Offline: which pages would be read, from the cache only."""
    pages = structured = 0
    with ctx.crawler() as client:
        for site in sites:
            cached = next(
                (
                    found
                    for url in (site.home_url, *site.stated_urls)
                    if (found := client.cached(url, SOCIETY_WEBSITE)) is not None
                ),
                None,
            )
            if cached is None:
                continue
            home = parse_page(cached.final_url or site.home_url, cached.text)
            pages += home_lists_events(home)
            structured += len(structured_events(home))
            for url in event_pages(home, today=london_date(now)):
                page = client.cached(url, SOCIETY_WEBSITE)
                if page is not None:
                    pages += 1
                    structured += len(structured_events(parse_page(url, page.text)))
    ctx.report.notes.append(
        f"dry run: {len(sites)} sites, {pages} cached events pages, "
        f"{structured} structured events; the model is not asked"
    )


__all__ = [
    "HORIZON",
    "MAX_EVENT_PAGES",
    "PageDating",
    "Site",
    "SiteResult",
    "current",
    "dated_quote",
    "event_pages",
    "home_lists_events",
    "page_dating",
    "page_text",
    "read_site",
    "run",
    "sites_from",
    "structured_draft",
    "structured_events",
    "window_from",
    "year_problem",
]
