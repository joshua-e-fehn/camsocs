"""Calendar feeds societies publish: ICS, Luma, Google (source-research §11;
stage `calendar_feeds`).

**Which feeds.** The `orgInternal` feeds of organisations in staging
(``icsUrls``, ``lumaCalendarIds``, ``googleCalendarIds``; website and Linktree
enrichment and SU profiles find them) plus `seeds.FEED_SEEDS`. The organiser
of every event in a feed is the organisation that publishes it; a feed two
organisations publish gives both. The ``ORGANIZER`` property is never used: on
Luma it is often a person's name.

**Society content (decision D3, 2026-10-08).** Every feed here is one a
society links or publishes, so it is fetched with the society purpose
(`sources/policy.py`): Google Calendar's ``Disallow: /`` does not keep a
public ICS feed out (the ``google_calendar_feed`` class), while pacing, the
honest User-Agent and access walls still apply. A feed robots.txt alone would
have refused is recorded ``disallowed`` with the override in its `sources`
row's access note.

**URLs** (re-verified 2026-10-09):

- ICS: the URL as published (``webcal://`` read as ``https://``); an ICS URL
  on calendar.google.com is a Google feed (one event source per calendar);
- Google: ``https://calendar.google.com/calendar/ical/<id>/public/basic.ics``.
  Embed links carry the id base64-encoded (``?cid=Y2Ft…``, the id
  ``cam…@gmail.com``); such a value is decoded first, so one calendar linked
  both ways is read once;
- Luma: ``https://api.lu.ma/ics/get?entity=calendar&id=<cal-…>``; api.lu.ma's
  robots.txt disallows only ``/insights/``. A link to a calendar page
  (``lu.ma/<slug>``) names its slug, not its id, and the ICS endpoint answers
  404 for a slug: the stage reads ``https://luma.com/<slug>`` (luma.com's
  robots.txt has no rule for ``*``) and takes the calendar's ``api_id`` from
  the page's own data (``initialData.data.calendar``), only when that
  calendar's slug is the one linked. A page that is gone (404) or shows no
  such calendar drops the feed, with a note.

**Parsing** is `events.ics` (time zones, the bogus-zone heuristic, recurrence,
UID de-duplication); events re-read from a bogus zone have their times claimed
as ``inferred``. ``STATUS:CANCELLED`` marks an event cancelled and
``STATUS:TENTATIVE`` makes it ``tbc`` — except on Luma, whose feeds mark every
event TENTATIVE. Luma descriptions are generated boilerplate ("Get up-to-date
information at: <page>", "Address: …", "Hosted by <names>"): the page becomes
the event's `sourceUrl` and `bookingUrl` (registration happens there), the
address is already the ``LOCATION``, and the host line — which names people —
is dropped.

External ids are the UID (``<UID>/<start>`` for an occurrence of a recurring
event), so the same event in two feeds of one kind is one event.
"""

from __future__ import annotations

import base64
import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from urllib.parse import parse_qs, quote, unquote, urlsplit

from camsocs_pipeline.events.common import (
    EventDraft,
    EventWindow,
    Sourced,
    Tally,
    default_window,
    describe_failure,
    infer_event_type,
    observations_from,
    polite_client,
    write_staging,
)
from camsocs_pipeline.events.ics import IcsError, IcsEvent, parse_ics
from camsocs_pipeline.events.organisers import OrganiserIndex
from camsocs_pipeline.events.seeds import FEED_SEEDS
from camsocs_pipeline.media import probe_image
from camsocs_pipeline.models.observation import IdentityHints, OrganiserObs
from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.sources.base import PoliteClient
from camsocs_pipeline.sources.policy import SOCIETY

EVIDENCE = "primary"
COVERS = frozenset({"description", "endsAt", "venueText"})

#: kind → (event source, staging source type).
KINDS = {
    "ics": ("ics", "ics_feed"),
    "luma": ("luma", "luma"),
    "google": ("google_calendar", "ics_feed"),
}

_LUMA_PAGE = re.compile(r"Get up-to-date information at:\s*(https?://\S+)", re.IGNORECASE)
_LUMA_ADDRESS = re.compile(r"(?ms)^Address:\s*\n.*?(?:\n\s*\n|\Z)")
_LUMA_HOSTS = re.compile(r"(?m)^Hosted by .*$")
#: A Luma calendar page is read again at most weekly (its id never changes).
LUMA_PAGE_FRESH_FOR = timedelta(days=7)


@dataclass
class Feed:
    kind: str
    #: The URL to fetch; None for a Luma calendar known only by its slug
    #: until `resolve_luma` reads its page.
    url: str | None
    owners: list[IdentityHints] = field(default_factory=list)
    #: A Luma calendar slug (``lu.ma/<slug>``) whose id is not known yet.
    luma_slug: str | None = None

    def add_owner(self, owner: IdentityHints) -> None:
        if all((o.known_key or o.name) != (owner.known_key or owner.name) for o in self.owners):
            self.owners.append(owner)


LUMA_CALENDAR_PAGE = "https://luma.com/{slug}"
_LUMA_ID = re.compile(r"^cal-[A-Za-z0-9]{1,40}$")
_LUMA_SLUG = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
_NEXT_DATA = re.compile(
    r'<script id="__NEXT_DATA__" type="application/json"[^>]*>(?P<json>.*?)</script>', re.S
)
_BASE64ISH = re.compile(r"^[A-Za-z0-9_-]{8,}={0,2}$")


def luma_feed_url(calendar_id: str) -> str:
    return f"https://api.lu.ma/ics/get?entity=calendar&id={quote(calendar_id, safe='-_')}"


def google_calendar_id(value: str) -> str:
    """A Google Calendar id as the ical URL needs it. Embed links carry it
    base64-encoded (``?cid=Y2FtYnJpZGdlY2Fsc29jQGdtYWlsLmNvbQ`` is
    ``cambridgecalsoc@gmail.com``); a value that decodes to an id with an
    ``@`` is decoded, anything else is kept as given."""
    value = unquote(value.strip())
    if "@" in value or not _BASE64ISH.match(value):
        return value
    padded = value + "=" * (-len(value) % 4)
    try:
        decoded = base64.urlsafe_b64decode(padded).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return value
    if re.fullmatch(r"[\w.+-]+@[\w.-]+\.[a-z]{2,}", decoded, re.IGNORECASE):
        return decoded
    return value


def _google_ical_id(url: str) -> str | None:
    """The calendar id in a calendar.google.com ical URL, or None."""
    parts = urlsplit(url)
    if (parts.hostname or "").lower() != "calendar.google.com":
        return None
    match = re.match(r"^/calendar/ical/([^/]+)/", parts.path)
    return google_calendar_id(match.group(1)) if match else None


def feed_url(kind: str, value: str) -> str | None:
    """The URL to fetch for a feed reference, or None if it is not usable
    (or, for a Luma slug, not known before its page is read)."""
    value = value.strip()
    if kind == "luma":
        if value.startswith(("http://", "https://")):
            calendar = parse_qs(urlsplit(value).query).get("id")
            value = calendar[0] if calendar else ""
        return luma_feed_url(value) if _LUMA_ID.match(value) else None
    if kind == "google":
        if value.startswith(("http://", "https://")):
            calendar_id = _google_ical_id(value)
            return _google_url(calendar_id) if calendar_id else value
        return _google_url(google_calendar_id(value))
    if value.startswith("webcal://"):
        value = "https://" + value[len("webcal://") :]
    if not value.startswith(("http://", "https://")):
        return None
    calendar_id = _google_ical_id(value)
    return _google_url(calendar_id) if calendar_id else value


def _google_url(calendar_id: str) -> str:
    encoded = quote(calendar_id, safe="")
    return f"https://calendar.google.com/calendar/ical/{encoded}/public/basic.ics"


def feed_kind(kind: str, url: str | None) -> str:
    """An ICS URL on calendar.google.com is a Google Calendar feed."""
    if kind == "ics" and url and (urlsplit(url).hostname or "").lower() == "calendar.google.com":
        return "google"
    return kind


def collect_feeds(index: OrganiserIndex) -> list[Feed]:
    """Every feed in staging and the seeds, one per URL (Luma slugs one per
    slug until `resolve_luma` turns them into URLs)."""
    feeds: dict[str, Feed] = {}

    def add(kind: str, value: str, owner: IdentityHints) -> None:
        url = feed_url(kind, value)
        slug = None
        if url is None:
            slug = value.strip()
            if kind != "luma" or not _LUMA_SLUG.match(slug):
                return
        kind = feed_kind(kind, url)
        identity = url or f"luma-slug:{slug.lower()}"  # type: ignore[union-attr]
        feed = feeds.setdefault(identity, Feed(kind=kind, url=url, luma_slug=slug))
        feed.add_owner(owner)

    for ref in index.feeds(*KINDS):
        add(
            ref.kind,
            ref.value,
            IdentityHints(name=index.name_of(ref.org_key) or ref.org_key, known_key=ref.org_key),
        )
    for seed in FEED_SEEDS:
        add(seed.kind, seed.value, seed.owner)
    return list(feeds.values())


def luma_calendar_id(html: str, slug: str) -> str | None:
    """The ``api_id`` of the calendar a ``luma.com/<slug>`` page shows, from
    the page's own data (``initialData.data.calendar``), only when that
    calendar's slug is `slug`; None for anything else (an event, a person, a
    page without the data)."""
    match = _NEXT_DATA.search(html)
    if match is None:
        return None
    try:
        data = json.loads(match.group("json"))
    except ValueError:
        return None
    calendar = (
        data.get("props", {}).get("pageProps", {}).get("initialData", {}).get("data", {})
        if isinstance(data, dict)
        else {}
    )
    calendar = calendar.get("calendar") if isinstance(calendar, dict) else None
    if not isinstance(calendar, dict):
        return None
    api_id, own_slug = calendar.get("api_id"), calendar.get("slug")
    if not isinstance(api_id, str) or not _LUMA_ID.match(api_id):
        return None
    if not isinstance(own_slug, str) or own_slug.lower() != slug.lower():
        return None
    return api_id


def resolve_luma(client: PoliteClient, feeds: list[Feed], notes: list[str]) -> list[Feed]:
    """Feeds with every Luma slug turned into its calendar's ICS URL (read
    from the calendar page, society content under D3), merged with a feed
    already known by that URL; slugs whose page is gone or shows no such
    calendar are dropped with a note."""
    by_url: dict[str, Feed] = {feed.url: feed for feed in feeds if feed.url}
    for feed in feeds:
        if feed.url is not None or feed.luma_slug is None:
            continue
        page_url = LUMA_CALENDAR_PAGE.format(slug=quote(feed.luma_slug, safe="-_"))
        result = client.fetch(page_url, fresh_for=LUMA_PAGE_FRESH_FOR, purpose=SOCIETY)
        if not result.ok:
            notes.append(f"luma calendar {feed.luma_slug}: dropped, {describe_failure(result)}")
            continue
        calendar_id = luma_calendar_id(result.text, feed.luma_slug)
        if calendar_id is None:
            notes.append(f"luma calendar {feed.luma_slug}: dropped, {page_url} shows no calendar")
            continue
        url = luma_feed_url(calendar_id)
        known = by_url.get(url)
        if known is None:
            feed.url = url
            by_url[url] = feed
        else:
            for owner in feed.owners:
                known.add_owner(owner)
    return list(by_url.values())


def clean_luma(description: str | None) -> tuple[str | None, str | None]:
    """``(page URL, remaining description)`` from a Luma ICS description."""
    if not description:
        return None, None
    page = None
    match = _LUMA_PAGE.search(description)
    if match:
        page = match.group(1).rstrip(".,)")
        description = description.replace(match.group(0), "")
    description = _LUMA_ADDRESS.sub("", description)
    description = _LUMA_HOSTS.sub("", description)
    description = description.strip()
    return page, description or None


def event_draft(
    event: IcsEvent,
    *,
    kind: str,
    owners: list[IdentityHints],
    image_url: str | None = None,
) -> EventDraft:
    event_source, _ = KINDS[kind]
    description, page, booking = event.description, event.url, None
    if kind == "luma":
        luma_page, description = clean_luma(event.description)
        page = page or luma_page
        booking = luma_page
    event_type = infer_event_type(event.title)
    inferred = {"eventType"}
    if event.zone_corrected:
        inferred |= {"startsAt", "endsAt"}
    tentative = event.status == "TENTATIVE" and kind != "luma"
    return EventDraft(
        event_source=event_source,
        external_id=event.external_id,
        title=event.title,
        starts_at=event.starts_at,
        ends_at=event.ends_at,
        all_day=event.all_day,
        description=description,
        page_url=page,
        venue=IdentityHints(name=event.location) if event.location else None,
        booking_url=booking,
        event_type=event_type,
        image_url=image_url,
        cancelled=event.status == "CANCELLED",
        status="tbc" if tentative else "confirmed",
        organisers=[OrganiserObs(identity=owner, role="organiser") for owner in owners],
        inferred=inferred,
        covers=COVERS,
    )


def _image(client: PoliteClient, url: str | None, cache: dict[str, str | None]) -> str | None:
    if not url:
        return None
    if url not in cache:
        # A feed's event image is the society's own content (D3).
        cache[url] = url if probe_image(client, url, purpose=SOCIETY) else None
    return cache[url]


def run(
    ctx: StageContext, *, window: EventWindow | None = None, now: datetime | None = None
) -> None:
    window = window or default_window(now)
    index = OrganiserIndex.from_staging(ctx.staging)
    feeds = collect_feeds(index)
    if ctx.limit is not None:
        feeds = feeds[: ctx.limit]
    tally = Tally()
    pending: list[Sourced] = []
    read = overridden = 0
    images: dict[str, str | None] = {}
    with polite_client(ctx.settings) as client:
        feeds = resolve_luma(client, feeds, ctx.report.notes)
        for feed in feeds:
            assert feed.url is not None  # resolve_luma keeps only feeds with a URL
            result = client.fetch(feed.url, accept="text/calendar,*/*;q=0.5", purpose=SOCIETY)
            if not result.ok or result.content is None:
                ctx.report.notes.append(f"{feed.kind} feed: {describe_failure(result)}")
                continue
            try:
                calendar = parse_ics(result.content, window)
            except IcsError as error:
                ctx.report.notes.append(f"{feed.kind} feed {feed.url}: {error}")
                continue
            read += 1
            if result.override:
                overridden += 1
            for zone, count in calendar.corrected.items():
                ctx.report.notes.append(
                    f"{feed.kind} feed: {count} events re-read from {zone} as Europe/London"
                )
            _, source_type = KINDS[feed.kind]
            for event in calendar.events:
                draft = event_draft(
                    event,
                    kind=feed.kind,
                    owners=feed.owners,
                    image_url=_image(client, event.image_url, images),
                )
                pending.append(Sourced(draft, feed.url, result, source_type=source_type))
    records = observations_from(
        pending, window, tally, source_type="ics_feed", evidence=EVIDENCE, index=index, now=now
    )
    override = f" ({overridden} disallowed by robots.txt, read as society content, D3)"
    ctx.report.notes.append(f"{read} of {len(feeds)} feeds read" + (override if overridden else ""))
    write_staging(ctx, records, tally)


__all__ = [
    "Feed",
    "clean_luma",
    "collect_feeds",
    "event_draft",
    "feed_kind",
    "feed_url",
    "google_calendar_id",
    "luma_calendar_id",
    "resolve_luma",
    "run",
]
