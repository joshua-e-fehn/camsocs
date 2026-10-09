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

**Event page** (``/events/<organisation id>/<event id>/`` or
``/ents/event/<id>/``): the title (``h1``), date ("Friday 09 October 2026"),
time ("6pm - 8:45pm"), location and organisation lines (``.event-details``),
and the description (``.e-details-txt``). No time → an all-day event.
Images are not fetched: they are under ``/asset/``, which robots.txt
disallows.

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
    infer_event_type,
    london_midnight,
    observations_from,
    polite_client,
    write_staging,
)
from camsocs_pipeline.models.observation import IdentityHints, OrganiserObs
from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.resolve.lookup import OrgLookup

BASE = "https://www.cambridgesu.co.uk"
WHATSON_URL = f"{BASE}/whatson/"
SOURCE_TYPE = "su_whatson"
EVENT_SOURCE = "su_whatson"
EVIDENCE = "primary"
COVERS = frozenset({"description", "endsAt", "venueText"})

SU_RUN_ORGANISERS = frozenset(
    {"cambridge su", "sabbatical officers", "clubs and societies", "university of cambridge"}
)

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


def parse_listing(html: str, base: str = WHATSON_URL) -> list[ListingItem]:
    tree = LexborHTMLParser(html)
    items: list[ListingItem] = []
    for node in tree.css("div.event_item"):
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
            )
        )
    return items


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


def event_draft(item: ListingItem, page: EventPage) -> EventDraft | None:
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
        organisers=[
            OrganiserObs(
                identity=IdentityHints(name=item.organisation, su_id=item.organisation_id),
                role="organiser",
            )
        ],
        inferred={"eventType"},
        covers=COVERS,
    )


def run(
    ctx: StageContext, *, window: EventWindow | None = None, now: datetime | None = None
) -> None:
    window = window or default_window(now)
    index = OrgLookup.for_stage(ctx)
    tally = Tally()
    pending: list[Sourced] = []
    with polite_client(ctx.settings) as client:
        listing = client.fetch(WHATSON_URL)
        if not listing.ok:
            raise RuntimeError(f"What's On not fetched: {describe_failure(listing)}")
        items = parse_listing(listing.text)
        wanted: list[ListingItem] = []
        for item in items:
            if item.organisation.lower() in SU_RUN_ORGANISERS:
                tally.drop("run by the SU")
            elif item.event_page is None:
                tally.drop("no SU event page")
            else:
                wanted.append(item)
        if ctx.limit is not None:
            wanted = wanted[: ctx.limit]
        for item in wanted:
            result = client.fetch(item.url)
            if not result.ok:
                ctx.report.notes.append(f"event page: {describe_failure(result)}")
                continue
            draft = event_draft(item, parse_event_page(result.text))
            if draft is None:
                tally.drop("no readable date")
                continue
            pending.append(Sourced(draft, item.url, result))
    ctx.report.notes.append(f"What's On lists {len(items)} entries; {len(wanted)} pages read")
    records = observations_from(
        pending, window, tally, source_type=SOURCE_TYPE, evidence=EVIDENCE, index=index, now=now
    )
    write_staging(ctx, records, tally)


__all__ = [
    "EventPage",
    "ListingItem",
    "event_draft",
    "parse_event_page",
    "parse_listing",
    "parse_when",
    "run",
]
