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
The rules for dates live in `extract.dating`.

**Cards on the page** (`page_card_events`). Many societies publish their
programme only as images — a term card, a slideshow of posters (the German
Society's Michaelmas 2026 card) — so each page read also gives its term cards
and posters (`sources.termcards.card_images`): an image or a linked PDF whose
alt text, title or file name says term card, a term, poster, flyer,
programme, schedule, calendar or events, or that sits right under a heading
announcing a programme — never logos, icons, sponsors' or social networks'
images, camera photos, anything in the navigation, header or footer or under
a heading of past events, nothing shown smaller than 300 px or as a strip.
Old cards are left out before any request (`card_stale_reason`: a past term
or only earlier years in the name or the heading above, a dated upload path
before 1 March of this academic year's first year; on a page about an
earlier season, every card that does not name this year), and after it by
``Last-Modified``. At most `MAX_CARDS_PER_PAGE` a page, each file once a site
(resized copies are one file; the original upload is fetched), with the
society-website purpose bound to the page's site (a CDN keeps its own
robots.txt and AI opt-outs; Meta's CDNs are never fetched), and only when the
page itself may reach the model. They are read through the termcard path
(`extract.cards`, the strong model's vision): every event needs its date in a
quote off the card, and a yearless date's year a second signal — the card
names its term with the year, or the heading or alt text beside it does; it
was uploaded this academic year (a path like ``/2026/10/``, or
``Last-Modified``); the page names this year or the term; its weekdays agree;
it lies within eight weeks — while a stated weekday must fall on the date.
Values read off an image stay ``inferred``. The model's reference date is the
week the card was published, so an unchanged image is asked about once (the
reply is cached by its bytes); at most `MAX_CARD_CALLS_PER_RUN` new vision
calls a run. Their events are ``termcard`` events (source URL the card file,
public unless the card says members only, organised by the site's
organisation): one reading per event (`unseen_card_events`), none the page's
own text already lists that day under a similar title (its quotes checked,
it beats a reading off an image); other sources' readings merge at load
(`events.duplicates`).

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
from camsocs_pipeline.extract.cards import CardHints, card_events
from camsocs_pipeline.extract.dating import (
    dated_quote,
    page_dating,
    weekdays_agree,
    year_problem,
)
from camsocs_pipeline.extract.dedupe import named_in, similar_titles
from camsocs_pipeline.extract.events import (
    CallBudget,
    EventContext,
    LlmEvent,
    LlmEvents,
    OverBudget,
    build_events,
    extract_events,
    load_prompt,
    redact_contacts,
    title_slug,
)
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
from camsocs_pipeline.sources.policy import AI_OVERRIDE_NOTE, SOCIETY_WEBSITE, FetchPurpose
from camsocs_pipeline.sources.termcards import (
    PageFile,
    Skipped,
    TermcardFile,
    card_images,
    card_stale_reason,
    dated_this_year,
    fetch_card_file,
    modified_reason,
    original_url,
    term_hint,
)
from camsocs_pipeline.sources.websites.discover import choose_pages, in_scope
from camsocs_pipeline.sources.websites.page import Page, parse_page
from camsocs_pipeline.sources.websites.site import ai_reading, with_note
from camsocs_pipeline.staging.store import events_directory

logger = logging.getLogger(__name__)

SOURCE_TYPE = "society_website"
EVENT_SOURCE = "website"
#: The event source of what the cards on a page give (`extract.cards`).
CARD_SOURCE = "termcard"
PROMPT = "website_events_v1"
EVIDENCE = "primary"
#: The enrichment stage's page cache age (`sources.websites.enrich.FRESH_FOR`).
FRESH_FOR = timedelta(days=3)
#: Events further ahead than this are not announcements of this year's events.
HORIZON = timedelta(days=274)
MAX_EVENT_PAGES = 2
MAX_PROMPT_CHARS = 12_000
#: Term cards and posters read off one page at most (a slideshow of a
#: term's posters is about a dozen).
MAX_CARDS_PER_PAGE = 15
#: Model calls for cards in one run; a card read before costs nothing.
MAX_CARD_CALLS_PER_RUN = 150
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
    #: Card images (or files) read by the vision model, cached or not.
    cards: int = 0
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
    budget: CallBudget | None = None,
) -> SiteResult:
    """Every upcoming event one society's website lists (module docstring).
    `budget`: the run's model calls for the cards its pages show."""
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
    if llm is not None:
        cards = page_card_events(
            client,
            pages,
            site,
            llm=llm,
            memo=memo,
            calendar=calendar,
            now=now,
            out=out,
            budget=budget,
        )
        structured += unseen_card_events(current(cards, window, out.tally), structured, out.tally)
    out.events = structured
    return out


# --- term cards and posters shown as images ------------------------------------------------------


def _card_file(
    client: PoliteClient, item: PageFile, purpose: FetchPurpose
) -> TermcardFile | Skipped:
    """The file a page shows: its original upload (`original_url`), else the
    copy the page shows when the original is not there."""
    fetched: TermcardFile | Skipped = Skipped(item.url, "not read")
    for url in dict.fromkeys([original_url(item.url), item.url]):
        fetched = fetch_card_file(client, url, purpose)
        if isinstance(fetched, TermcardFile) or not fetched.reason.startswith(
            ("not_found", "http_error")
        ):
            return fetched
    return fetched


def page_card_events(
    client: PoliteClient,
    pages: Sequence[tuple[Page, FetchResult]],
    site: Site,
    *,
    llm: LLMClient,
    memo: LLMMemo | None,
    calendar: TermCalendar,
    now: datetime,
    out: SiteResult,
    budget: CallBudget | None = None,
) -> list[EventObservation]:
    """The events of the term cards and posters a site's events pages show
    as images or link as files (module docstring, "Cards on the page")."""
    today = london_date(now)
    found: list[EventObservation] = []
    seen: set[str] = set()
    for page, result in pages:
        files = [item for item in card_images(result.text, page.url) if item.key not in seen]
        seen.update(item.key for item in files)
        if not files:
            continue
        # The cards are the page's content: its AI opt-outs hold unless the
        # D3 override lifts them, as for its text.
        reading = ai_reading(client, page, SOCIETY_WEBSITE.bound_to(site.home_url))
        if reading == "refused":
            out.tally.drop("a card on a page that keeps AI out", len(files))
            continue
        dating = page_dating(page_text(page), london_date(fetched_at(result)))
        purpose = SOCIETY_WEBSITE.bound_to(page.url)
        read = 0
        for item in files:
            stale = card_stale_reason(item, today)
            if stale is None and dating.stale is not None and not dated_this_year(item, today):
                stale = dating.stale
            if stale is not None:
                out.tally.drop("an old card or poster")
                continue
            if read >= MAX_CARDS_PER_PAGE:
                out.tally.drop("over the page's limit of cards")
                continue
            card = _card_file(client, item, purpose)
            if isinstance(card, Skipped):
                out.tally.drop(f"a card not read ({card.reason.split(' (', 1)[0]})")
                continue
            read += 1
            if modified_reason(card.fetch.last_modified, today) is not None:
                out.tally.drop("an old card or poster")
                continue
            hints = CardHints(
                term_text=" ".join(filter(None, [item.alt, item.label, item.heading, page.title])),
                page=dating,
            )
            if reading == "override":
                card = replace(card, ai_override=True)
            try:
                found += card_events(
                    card,
                    org_key=site.org_key,
                    org_name=site.org_name,
                    listed_url=page.url,
                    now=now,
                    llm=llm,
                    memo=memo,
                    calendar=calendar,
                    notes=out.notes,
                    hints=hints,
                    budget=budget,
                    drops=out.tally,
                )
            except OverBudget:
                out.tally.drop("over the run's budget of card readings")
                return found
            except LLMValidationError:
                out.tally.drop("reply did not validate")
                continue
            except NoLLMHost:
                continue
            out.cards += 1
    return found


def _timed(record: EventObservation) -> bool:
    return any(obs.field == "allDay" and obs.value is False for obs in record.fields)


def _london_day(record: EventObservation) -> date | None:
    start = _start(record)
    return start.astimezone(LONDON).date() if start else None


def _title(record: EventObservation) -> str:
    return next((str(f.value) for f in record.fields if f.field == "title" and f.value), "")


def _description(record: EventObservation) -> str:
    return next((str(f.value) for f in record.fields if f.field == "description" and f.value), "")


def _one_evening(a: EventObservation, b: EventObservation) -> bool:
    """A timed and an all-day card reading of one organiser on one London
    day that name the same thing: the term card's "Cinema ItaSoc" row (its
    description "The Last One for the Road") and the film's own poster, "THE
    LAST ONE FOR THE ROAD" at 20:15 (review 2026-10-10)."""
    if _timed(a) == _timed(b) or _organiser(a) != _organiser(b):
        return False
    if _london_day(a) is None or _london_day(a) != _london_day(b):
        return False
    return (
        similar_titles(_title(a), _title(b))
        or named_in(_title(a), _title(b), _description(b))
        or named_in(_title(b), _title(a), _description(a))
    )


def unseen_card_events(
    cards: Sequence[EventObservation], listed: Sequence[EventObservation], tally: Tally
) -> list[EventObservation]:
    """The cards' events the site's own text does not already list: one
    reading per event (a poster and the term card both show the evening; a
    timed reading before an all-day one, then the fuller one, then page
    order — also when the two name it differently, `_one_evening`), and none
    that the page's text or structured data lists on the
    same London day under a similar title — the page's words, its quotes
    checked, beat a reading off an image (a card's "4:30" read as 04:30 is
    the page's 16:30). Other sources' readings merge at load
    (`events.duplicates`)."""
    best: dict[str, EventObservation] = {}
    for record in cards:
        held = best.get(record.external_id)
        if held is None or (_timed(record), len(record.fields)) > (_timed(held), len(held.fields)):
            best[record.external_id] = record
    if len(cards) > len(best):
        tally.drop("one event on several cards", len(cards) - len(best))
    # A poster and the term card under different titles: the timed reading
    # stands, the all-day row adds nothing.
    timed = [record for record in best.values() if _timed(record)]
    for key, record in list(best.items()):
        if not _timed(record) and any(_one_evening(record, other) for other in timed):
            del best[key]
            tally.drop("one event on a poster and the term card")
    by_day: dict[date, list[str]] = {}
    for record in listed:
        if (day := _london_day(record)) is not None:
            by_day.setdefault(day, []).append(_title(record))
    kept: list[EventObservation] = []
    for record in best.values():
        day = _london_day(record)
        if any(similar_titles(_title(record), title) for title in by_day.get(day, [])):
            tally.drop("already listed on the page")
        else:
            kept.append(record)
    return kept


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
    budget = CallBudget(MAX_CARD_CALLS_PER_RUN)
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
                    lambda site: _safe_read(client, site, llm, memo, calendar, now, budget),
                    sites,
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
        f"({sum(r.llm_cached for r in results)} cached); "
        f"{sum(r.cards for r in results)} card images read ({budget.used} new vision calls), "
        f"{sum(1 for e in events if e.event_source == CARD_SOURCE)} events from them; "
        f"{len(events)} events from {sum(1 for r in results if r.events)} sites"
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
    budget: CallBudget,
) -> SiteResult:
    try:
        return read_site(
            client, site, llm=llm, memo=memo, calendar=calendar, now=now, budget=budget
        )
    except Exception as error:  # one broken site must not end the stage
        logger.exception("events of %s failed", site.org_key)
        result = SiteResult(site)
        result.notes.append(f"{site.org_key}: failed ({type(error).__name__})")
        return result


def _dry_run(ctx: StageContext, sites: list[Site], now: datetime) -> None:
    """Offline: which pages would be read, from the cache only."""
    pages = structured = cards = 0
    today = london_date(now)

    def count_cards(html: str, url: str) -> int:
        found = card_images(html, url)
        return sum(1 for item in found if card_stale_reason(item, today) is None)

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
            if home_lists_events(home):
                pages += 1
                cards += count_cards(cached.text, home.url)
            structured += len(structured_events(home))
            for url in event_pages(home, today=today):
                page = client.cached(url, SOCIETY_WEBSITE)
                if page is not None:
                    pages += 1
                    structured += len(structured_events(parse_page(url, page.text)))
                    cards += count_cards(page.text, page.final_url or url)
    ctx.report.notes.append(
        f"dry run: {len(sites)} sites, {pages} cached events pages, "
        f"{structured} structured events, {cards} term cards or posters shown; "
        "the model is not asked"
    )


__all__ = [
    "HORIZON",
    "MAX_CARDS_PER_PAGE",
    "MAX_CARD_CALLS_PER_RUN",
    "MAX_EVENT_PAGES",
    "Site",
    "SiteResult",
    "current",
    "event_pages",
    "home_lists_events",
    "page_card_events",
    "page_text",
    "read_site",
    "run",
    "sites_from",
    "structured_draft",
    "structured_events",
    "unseen_card_events",
    "window_from",
]
