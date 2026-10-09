"""Cambridge SU What's On → student-group events (source-research §12; stage
`su_whatson`).

Re-verified 2026-10-07: robots.txt for ``User-agent: *`` disallows ``/asset/``
(where event images live), ``/login/``, ``/search/`` and a few others; the
What's On page and event pages are allowed. The page listed 60 events: 34 by
"Sabbatical Officers", 19 by "Cambridge SU", 1 each by "Clubs and Societies"
and "University of Cambridge", and 5 by student groups.

**Listing.** ``/whatson/`` is server-rendered MSL markup: each
``div.event_item`` carries ``data-msl-organisation-id``, the organisation
(``.msl_event_organisation``), the title link (``a.msl_event_name``), a short
date ("8th October", no year or time), location and types. The RSS feed only
carries SU-run events, so it is not used.

**Which events.** Events run by the SU itself (`SU_RUN_ORGANISERS`: the SU,
its sabbatical officers, its clubs-and-societies office, the University) are
left out — camsocs lists student groups' events, and those are counted in the
notes. So is any entry whose link is not an event page on the SU site (an
elections page, an external site): without a page there is no reliable date.

**Society profiles' own event lists** (re-checked 2026-10-09): a few SU
society profiles embed the same MSL event list (``.soc-event-list``, 5 of
1,195 cached profiles on 2026-10-08), linking the same ``/events/<org>/<id>/``
pages. The stage re-reads the profiles the `su_directory` stage cached (no
request of its own) and treats their items like listing entries: the same
external id, so an event on both is one event. Their date has no year or
time ("15th October"); the event page gives both, so it is read as for any
entry. Only when that page cannot be had is the list's date used, its year
inferred (`infer_listing_date`): SU lists show upcoming events, so the
year is the one that puts the date between a week before the profile was read
and nine months after, inside an academic year whose Full Term dates are
verified (source-research §19) — otherwise the item is rejected as ambiguous.
Such an event is all day, and its date is claimed as ``inferred``.

**Event page** (``/events/<organisation id>/<event id>/`` or
``/ents/event/<id>/``): the title (``h1``), date ("Friday 09 October 2026"),
time ("6pm - 8:45pm"), location and organisation lines (``.event-details``),
and the description (``.e-details-txt``). No time → an all-day event.
**Images** (``/asset/Event/<org>/…``): robots.txt disallows ``/asset/``.
Decision D3 (2026-10-08) covers SU ``/asset/`` files *linked from a society's
profile*, so the poster an event has on its society's own profile list is
fetched with the society purpose (the ``su_asset`` class of
`sources/policy.py`) and stored as our own copy; an event only What's On
lists keeps no image (its event page's banner is not linked from a profile).
SU-run events are never read, so their images are never fetched.

The organiser is an identity hint with the SU organisation id
(``data-msl-organisation-id``) and name, resolved against staging. The event is
the student group's own listing on the SU platform, so evidence is primary.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from urllib.parse import urljoin, urlsplit

from selectolax.lexbor import LexborHTMLParser

from camsocs_pipeline.events.common import (
    LONDON,
    EventDraft,
    EventWindow,
    Sourced,
    Tally,
    clean_text,
    default_window,
    describe_failure,
    fetched_at,
    infer_event_type,
    london_midnight,
    observations_from,
    polite_client,
    write_staging,
)
from camsocs_pipeline.events.organisers import OrganiserIndex
from camsocs_pipeline.extract.when import TermCalendar
from camsocs_pipeline.media import probe_image
from camsocs_pipeline.models.observation import IdentityHints, Observation, OrganiserObs
from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.sources.base import FetchResult, PoliteClient
from camsocs_pipeline.sources.policy import SOCIETY

BASE = "https://www.cambridgesu.co.uk"
WHATSON_URL = f"{BASE}/whatson/"
SOURCE_TYPE = "su_whatson"
EVENT_SOURCE = "su_whatson"
EVIDENCE = "primary"
COVERS = frozenset({"description", "endsAt", "venueText"})

SU_RUN_ORGANISERS = frozenset(
    {"cambridge su", "sabbatical officers", "clubs and societies", "university of cambridge"}
)

#: The staging directory of SU profile observations (`su_directory` stage).
PROFILE_DIRECTORY = "su_profile"
_PROFILE_PATH = re.compile(r"^/organisation/[^/]+/?$")
#: A yearless listing date may lie this far before the profile was read …
LISTING_GRACE = timedelta(days=7)
#: … and at most this far after it (nine months).
LISTING_HORIZON = timedelta(days=274)
_YEARLESS = re.compile(r"(?P<day>\d{1,2})(?:st|nd|rd|th)?\s+(?P<month>[A-Za-z]+)")

_EVENT_PATH = re.compile(r"^/(?:events/(?P<org>\d+)/(?P<id>\d+)|ents/event/(?P<ents>\d+))/?$")
_DATE = re.compile(
    r"(?:\w+day\s+)?(?P<day>\d{1,2})(?:st|nd|rd|th)?\s+(?P<month>[A-Za-z]+)\s+(?P<year>\d{4})"
)
_TIME = re.compile(r"(?P<h>\d{1,2})(?:[:.](?P<m>\d{2}))?\s*(?P<ampm>am|pm)?", re.IGNORECASE)
_RANGE = re.compile(
    r"(?P<h1>\d{1,2})(?:[:.](?P<m1>\d{2}))?\s*(?P<a1>am|pm)?\s*(?:-|–|—|to)\s*"
    r"(?P<h2>\d{1,2})(?:[:.](?P<m2>\d{2}))?\s*(?P<a2>am|pm)?",
    re.IGNORECASE,
)
_MONTHS = {
    name: n
    for n, name in enumerate(
        (
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
        ),
        start=1,
    )
}


@dataclass
class ListingItem:
    organisation_id: str | None
    organisation: str
    title: str
    url: str
    when: str | None = None
    location: str | None = None
    types: list[str] = field(default_factory=list)
    #: Where the item was listed: What's On, or a society profile's own list.
    listed_on: str = WHATSON_URL
    #: The poster a society profile's list shows (``/asset/Event/…``).
    image_url: str | None = None

    @property
    def event_page(self) -> str | None:
        """The SU event page this entry links to, or None."""
        parts = urlsplit(self.url)
        if parts.netloc not in ("www.cambridgesu.co.uk", "cambridgesu.co.uk"):
            return None
        return self.url if _EVENT_PATH.match(parts.path) else None

    @property
    def external_id(self) -> str | None:
        match = _EVENT_PATH.match(urlsplit(self.url).path)
        if match is None:
            return None
        if match["ents"]:
            return f"ents/{match['ents']}"
        return f"events/{match['org']}/{match['id']}"


@dataclass
class EventPage:
    title: str | None
    date_text: str | None
    time_text: str | None
    location: str | None
    organisation: str | None
    description: str | None


def _node_text(node: object) -> str | None:
    if node is None:
        return None
    text = " ".join(node.text(separator=" ").split())  # type: ignore[attr-defined]
    return text or None


def parse_listing(
    html: str, base: str = WHATSON_URL, *, selector: str = "div.event_item"
) -> list[ListingItem]:
    tree = LexborHTMLParser(html)
    items: list[ListingItem] = []
    for node in tree.css(selector):
        name = node.css_first("a.msl_event_name")
        organisation = _node_text(node.css_first(".msl_event_organisation"))
        if name is None or not organisation:
            continue
        href = name.attributes.get("href") or ""
        title = _node_text(name)
        if not title or not href:
            continue
        items.append(
            ListingItem(
                organisation_id=node.attributes.get("data-msl-organisation-id"),
                organisation=organisation,
                title=title,
                url=urljoin(base, href),
                when=_node_text(node.css_first(".msl_event_time")),
                location=_node_text(node.css_first(".msl_event_location")),
                types=[t for t in (_node_text(a) for a in node.css(".msl_event_types a")) if t],
                listed_on=base,
            )
        )
    return items


def parse_profile_events(html: str, profile_url: str) -> list[ListingItem]:
    """The items of a society profile's own event list (``.soc-event-list``);
    empty for a profile without one. The organisation is the item's own
    ``data-msl-organisation-id`` — the profile's society."""
    tree = LexborHTMLParser(html)
    title = _node_text(tree.css_first("h1")) or ""
    items: list[ListingItem] = []
    for node in tree.css(".soc-event-list div.event_item"):
        name = node.css_first("a.msl_event_name")
        href = name.attributes.get("href") if name is not None else None
        text = _node_text(name)
        if not href or not text:
            continue
        items.append(
            ListingItem(
                organisation_id=node.attributes.get("data-msl-organisation-id"),
                organisation=title,
                title=text,
                url=urljoin(profile_url, href),
                when=_node_text(node.css_first(".msl_event_time")),
                location=_node_text(node.css_first(".msl_event_location")),
                types=[t for t in (_node_text(a) for a in node.css(".msl_event_types a")) if t],
                listed_on=profile_url,
                image_url=_image_src(node, profile_url),
            )
        )
    return items


def _image_src(node: object, base: str) -> str | None:
    image = node.css_first(".msl_event_image img")  # type: ignore[attr-defined]
    src = (image.attributes.get("src") or "").strip() if image is not None else ""
    return urljoin(base, src) if src else None


def parse_event_page(html: str) -> EventPage:
    tree = LexborHTMLParser(html)
    root = tree.css_first("#msl_event") or tree.body
    details: dict[str, str] = {}
    for node in root.css(".event-details") if root is not None else []:
        icon = node.css_first("i")
        classes = (icon.attributes.get("class") or "") if icon is not None else ""
        text = _node_text(node)
        if not text:
            continue
        for marker, key in (
            ("fa-calendar", "date"),
            ("fa-clock", "time"),
            ("fa-map-marker", "location"),
            ("fa-sitemap", "organisation"),
        ):
            if marker in classes:
                details.setdefault(key, text)
    description_node = root.css_first(".e-details-txt") if root is not None else None
    description = None
    if description_node is not None:
        description = clean_text(description_node.html)
    return EventPage(
        title=_node_text(root.css_first("h1")) if root is not None else None,
        date_text=details.get("date"),
        time_text=details.get("time"),
        location=details.get("location"),
        organisation=details.get("organisation"),
        description=description,
    )


def _dates(text: str | None) -> list[date]:
    found: list[date] = []
    for match in _DATE.finditer(text or ""):
        month = _MONTHS.get(match["month"].lower())
        if month is None:
            continue
        try:
            found.append(date(int(match["year"]), month, int(match["day"])))
        except ValueError:
            continue
    return found


def _clock(hour: str, minute: str | None, ampm: str | None) -> time | None:
    h, m = int(hour), int(minute or 0)
    marker = (ampm or "").lower()
    if marker == "pm" and h < 12:
        h += 12
    elif marker == "am" and h == 12:
        h = 0
    return time(h, m) if 0 <= h < 24 and 0 <= m < 60 else None


def _times(text: str | None) -> list[time]:
    """Clock times in "6pm - 8:45pm" / "18:00 - 20:00" / "6 - 8pm" (a start
    without am/pm shares the end's, unless that would put it after the end:
    "11 - 1pm" is 11am to 1pm, "10 - 12pm" 10am to noon). A lone time needs
    minutes or am/pm."""
    text = text or ""
    span = _RANGE.search(text)
    if span:
        end = _clock(span["h2"], span["m2"], span["a2"])
        start = _clock(span["h1"], span["m1"], span["a1"] or span["a2"])
        if not span["a1"] and span["a2"] and start and end and start >= end:
            other = "am" if span["a2"].lower() == "pm" else "pm"
            flipped = _clock(span["h1"], span["m1"], other)
            if flipped and flipped < end:
                start = flipped
        return [t for t in (start, end) if t is not None]
    for match in _TIME.finditer(text):
        if match["m"] or match["ampm"]:
            single = _clock(match["h"], match["m"], match["ampm"])
            return [single] if single else []
    return []


def parse_when(
    date_text: str | None, time_text: str | None
) -> tuple[datetime, datetime | None, bool] | None:
    """``(start, end, all_day)`` from an event page's date and time lines."""
    dates = _dates(date_text)
    if not dates:
        return None
    first, last = dates[0], dates[-1]
    times = _times(time_text)
    if not times:
        end_day = max(first, last) + timedelta(days=1)
        return london_midnight(first), london_midnight(end_day), True
    start = datetime.combine(first, times[0], tzinfo=LONDON)
    end = None
    if len(times) > 1:
        end = datetime.combine(last, times[1], tzinfo=LONDON)
        if end <= start and last == first:
            end += timedelta(days=1)  # ends after midnight
    return start, end, False


def academic_year_of(day: date) -> str:
    """``2026-27`` for any day from 1 July 2026 to 30 June 2027."""
    first = day.year if day.month >= 7 else day.year - 1
    return f"{first}-{(first + 1) % 100:02d}"


def infer_listing_date(text: str | None, seen: date, calendar: TermCalendar) -> date | None:
    """The date a yearless listing date ("15th October") means on a list read
    on `seen` (module docstring): the one candidate year that puts it between
    `LISTING_GRACE` before `seen` and `LISTING_HORIZON` after, inside an
    academic year with verified Full Term dates. None — rejected as ambiguous —
    for no candidate, several, or a year nobody has verified."""
    match = _YEARLESS.search(text or "")
    month = _MONTHS.get(match["month"].lower()) if match else None
    if match is None or month is None:
        return None
    candidates: list[date] = []
    for year in (seen.year - 1, seen.year, seen.year + 1):
        try:
            day = date(year, month, int(match["day"]))
        except ValueError:
            continue
        if seen - LISTING_GRACE <= day <= seen + LISTING_HORIZON:
            candidates.append(day)
    if len(candidates) != 1:
        return None
    verified = {term.academic_year for term in calendar.terms}
    return candidates[0] if academic_year_of(candidates[0]) in verified else None


def _organiser(item: ListingItem) -> OrganiserObs:
    return OrganiserObs(
        identity=IdentityHints(name=item.organisation, su_id=item.organisation_id),
        role="organiser",
    )


def event_draft(
    item: ListingItem, page: EventPage, *, image_url: str | None = None
) -> EventDraft | None:
    when = parse_when(page.date_text, page.time_text)
    external_id = item.external_id
    if when is None or external_id is None:
        return None
    start, end, all_day = when
    title = page.title or item.title
    event_type = infer_event_type(title)
    location = page.location or item.location
    return EventDraft(
        event_source=EVENT_SOURCE,
        external_id=external_id,
        title=title,
        starts_at=start,
        ends_at=end,
        all_day=all_day,
        description=page.description,
        page_url=item.url,
        venue=IdentityHints(name=location) if location else None,
        event_type=event_type,
        image_url=image_url,
        organisers=[_organiser(item)],
        inferred={"eventType"},
        covers=COVERS,
    )


def listing_draft(item: ListingItem, seen: date, calendar: TermCalendar) -> EventDraft | None:
    """An event from a profile list's own words when its page cannot be had:
    all day on the inferred date (`infer_listing_date`), claimed ``inferred``."""
    day = infer_listing_date(item.when, seen, calendar)
    external_id = item.external_id
    if day is None or external_id is None:
        return None
    return EventDraft(
        event_source=EVENT_SOURCE,
        external_id=external_id,
        title=item.title,
        starts_at=london_midnight(day),
        ends_at=london_midnight(day + timedelta(days=1)),
        all_day=True,
        page_url=item.url,
        venue=IdentityHints(name=item.location) if item.location else None,
        event_type=infer_event_type(item.title),
        organisers=[_organiser(item)],
        inferred={"eventType", "startsAt", "endsAt", "allDay"},
        covers=frozenset({"venueText"}),
    )


def profile_pages(ctx: StageContext, client: PoliteClient) -> list[FetchResult]:
    """The SU profiles the `su_directory` stage cached, read back without a
    request (only their cached copies; a profile not cached is skipped)."""
    urls = sorted(
        {
            record.source_url
            for record in ctx.staging.read_latest(PROFILE_DIRECTORY)
            if isinstance(record, Observation)
            and urlsplit(record.source_url).netloc in ("www.cambridgesu.co.uk", "cambridgesu.co.uk")
            and _PROFILE_PATH.match(urlsplit(record.source_url).path)
        }
    )
    pages: list[FetchResult] = []
    for url in urls:
        cached = client.cached(url)
        if cached is not None and cached.content is not None:
            pages.append(cached)
    return pages


def _image(client: PoliteClient, url: str | None, cache: dict[str, str | None]) -> str | None:
    """A poster a society's profile links, fetched as its own content (D3)."""
    if not url or urlsplit(url).netloc not in ("www.cambridgesu.co.uk", "cambridgesu.co.uk"):
        return None
    if url not in cache:
        cache[url] = url if probe_image(client, url, purpose=SOCIETY) else None
    return cache[url]


def run(
    ctx: StageContext, *, window: EventWindow | None = None, now: datetime | None = None
) -> None:
    window = window or default_window(now)
    index = OrganiserIndex.from_staging(ctx.staging)
    calendar = TermCalendar.default()
    tally = Tally()
    pending: list[Sourced] = []
    images: dict[str, str | None] = {}
    with polite_client(ctx.settings) as client:
        listing = client.fetch(WHATSON_URL)
        if not listing.ok:
            raise RuntimeError(f"What's On not fetched: {describe_failure(listing)}")
        items = parse_listing(listing.text)
        profiles = profile_pages(ctx, client)
        listed: dict[str, FetchResult] = {}
        posters: dict[str, str] = {}
        profile_items: list[ListingItem] = []
        for profile in profiles:
            for item in parse_profile_events(profile.text, profile.url):
                profile_items.append(item)
                listed.setdefault(item.url, profile)
                if item.image_url and item.external_id:
                    posters.setdefault(item.external_id, item.image_url)
        wanted: list[ListingItem] = []
        seen_ids: set[str] = set()
        for item in [*items, *profile_items]:
            if item.organisation.lower() in SU_RUN_ORGANISERS:
                tally.drop("run by the SU")
            elif item.event_page is None:
                tally.drop("no SU event page")
            elif item.external_id not in seen_ids:
                seen_ids.add(item.external_id or "")
                wanted.append(item)
        if ctx.limit is not None:
            wanted = wanted[: ctx.limit]
        for item in wanted:
            result = client.fetch(item.url)
            if not result.ok:
                profile = listed.get(item.url)
                fallback = (
                    listing_draft(item, fetched_at(profile).astimezone(LONDON).date(), calendar)
                    if profile is not None and item.listed_on != WHATSON_URL
                    else None
                )
                if fallback is None:
                    ctx.report.notes.append(f"event page: {describe_failure(result)}")
                    continue
                pending.append(Sourced(fallback, profile.url, profile))  # type: ignore[union-attr]
                continue
            page = parse_event_page(result.text)
            poster = posters.get(item.external_id or "")
            draft = event_draft(item, page, image_url=_image(client, poster, images))
            if draft is None:
                tally.drop("no readable date")
                continue
            pending.append(Sourced(draft, item.url, result))
    ctx.report.notes.append(
        f"What's On lists {len(items)} entries, {len(profiles)} cached profiles list "
        f"{len(profile_items)}; {len(wanted)} event pages read"
    )
    records = observations_from(
        pending, window, tally, source_type=SOURCE_TYPE, evidence=EVIDENCE, index=index, now=now
    )
    write_staging(ctx, records, tally)


__all__ = [
    "EventPage",
    "ListingItem",
    "academic_year_of",
    "event_draft",
    "infer_listing_date",
    "listing_draft",
    "parse_event_page",
    "parse_listing",
    "parse_profile_events",
    "parse_when",
    "profile_pages",
    "run",
]
