"""Calendar feeds societies publish: ICS, Luma, Google (source-research §11;
stage `calendar_feeds`).

**Which feeds.** The `orgInternal` feeds of organisations in staging
(``icsUrls``, ``lumaCalendarIds``, ``googleCalendarIds``; website and Linktree
enrichment find them) plus `seeds.FEED_SEEDS`. The organiser of every event in
a feed is the organisation that publishes it; a feed two organisations publish
gives both. The ``ORGANIZER`` property is never used: on Luma it is often a
person's name.

**URLs** (re-verified 2026-10-07):

- ICS: the URL as published (``webcal://`` read as ``https://``);
- Luma: ``https://api.lu.ma/ics/get?entity=calendar&id=<calendar id>``;
  api.lu.ma's robots.txt disallows only ``/insights/``;
- Google: ``https://calendar.google.com/calendar/ical/<id>/public/basic.ics``.
  **calendar.google.com's robots.txt is ``Allow: /$`` + ``Disallow: /``.**
  Under Joshua's decision D3 (PLAN.md, 2026-10-08; `sources/policy.py`) a
  public ICS feed a society links is still read: every feed here is fetched
  with the society purpose, which overrides the disallow for Google's
  ``/calendar/ical/<id>/public/…`` feeds only. The event's `sources` row is
  then ``disallowed`` with ``robots_override:society`` in its access note.
  Other feed hosts keep their robots.txt.

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

**Feed references as sites write them** (re-verified 2026-10-09):

- an ICS URL on calendar.google.com is a Google feed (`feed_kind`), so a
  calendar linked as a feed and as an id is read once, as one event source;
- Google embed links carry the id base64-encoded (``?cid=Y2Ft…`` is
  ``cam…@gmail.com``): such a value is decoded first (`google_calendar_id`);
- a link to a Luma calendar page (``lu.ma/<slug>``) names its slug, and the
  ICS endpoint answers 404 for a slug (EACam, caish, ccs on 2026-10-08). The
  stage reads ``https://luma.com/<slug>`` (luma.com's robots.txt has rules
  for Googlebot only) and takes the calendar's ``api_id`` from the page's own
  data (``initialData.data.calendar``), only when that calendar's slug is the
  one linked (`luma_calendar_id`). A page that is gone (404) or shows no such
  calendar drops the feed, with a note (`resolve_luma`).
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
from camsocs_pipeline.events.seeds import FEED_SEEDS
from camsocs_pipeline.media import probe_image
from camsocs_pipeline.models.observation import IdentityHints, OrganiserObs
from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.resolve.lookup import OrgLookup
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
LUMA_CALENDAR_PAGE = "https://luma.com/{slug}"
_LUMA_ID = re.compile(r"^cal-[A-Za-z0-9]{1,40}$")
_LUMA_SLUG = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
_NEXT_DATA = re.compile(
    r'<script id="__NEXT_DATA__" type="application/json"[^>]*>(?P<json>.*?)</script>', re.S
)
_BASE64ISH = re.compile(r"^[A-Za-z0-9_-]{8,}={0,2}$")


@dataclass
class Feed:
    kind: str
    url: str
    owners: list[IdentityHints] = field(default_factory=list)

    def add_owner(self, owner: IdentityHints) -> None:
        if all((o.known_key or o.name) != (owner.known_key or owner.name) for o in self.owners):
            self.owners.append(owner)


@dataclass
class LumaSlug:
    """A Luma calendar known by its page's slug (``lu.ma/<slug>``) only."""

    slug: str
    owners: list[IdentityHints] = field(default_factory=list)


def luma_feed_url(calendar_id: str) -> str:
    return f"https://api.lu.ma/ics/get?entity=calendar&id={quote(calendar_id, safe='-_')}"


def google_calendar_id(value: str) -> str:
    """A Google Calendar id as the ical URL needs it: a base64 value that
    decodes to an id with an ``@`` (an embed link's ``cid``) is decoded,
    anything else is kept as given."""
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


def _google_url(calendar_id: str) -> str:
    encoded = quote(calendar_id, safe="")
    return f"https://calendar.google.com/calendar/ical/{encoded}/public/basic.ics"


def _google_ical_id(url: str) -> str | None:
    """The calendar id in a calendar.google.com ical URL, or None."""
    parts = urlsplit(url)
    if (parts.hostname or "").lower() != "calendar.google.com":
        return None
    match = re.match(r"^/calendar/ical/([^/]+)/", parts.path)
    return google_calendar_id(match.group(1)) if match else None


def feed_url(kind: str, value: str) -> str | None:
    """The URL to fetch for a feed reference, or None if it is not usable
    (a Luma slug is resolved from its page, `resolve_luma`)."""
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


def feed_kind(kind: str, url: str) -> str:
    """An ICS URL on calendar.google.com is a Google Calendar feed."""
    if kind == "ics" and (urlsplit(url).hostname or "").lower() == "calendar.google.com":
        return "google"
    return kind


def _owner(index: OrgLookup, org_key: str) -> IdentityHints:
    return IdentityHints(name=index.name_of(org_key) or org_key, known_key=org_key)


def collect_feeds(index: OrgLookup) -> list[Feed]:
    feeds: dict[str, Feed] = {}

    def add(kind: str, value: str, owner: IdentityHints) -> None:
        url = feed_url(kind, value)
        if url is None:
            return
        feeds.setdefault(url, Feed(kind=feed_kind(kind, url), url=url)).add_owner(owner)

    for ref in index.feeds(*KINDS):
        add(ref.kind, ref.value, _owner(index, ref.org_key))
    for seed in FEED_SEEDS:
        add(seed.kind, seed.value, seed.owner)
    return list(feeds.values())


def collect_luma_slugs(index: OrgLookup) -> list[LumaSlug]:
    """Luma calendars staged by their page's slug, one per slug."""
    slugs: dict[str, LumaSlug] = {}
    for ref in index.feeds("luma"):
        value = ref.value.strip()
        if feed_url("luma", value) is None and _LUMA_SLUG.match(value):
            entry = slugs.setdefault(value.lower(), LumaSlug(value))
            owner = _owner(index, ref.org_key)
            if all(o.known_key != owner.known_key for o in entry.owners):
                entry.owners.append(owner)
    return list(slugs.values())


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
    node: object = data
    for step in ("props", "pageProps", "initialData", "data", "calendar"):
        node = node.get(step) if isinstance(node, dict) else None
    if not isinstance(node, dict):
        return None
    api_id, own_slug = node.get("api_id"), node.get("slug")
    if not isinstance(api_id, str) or not _LUMA_ID.match(api_id):
        return None
    if not isinstance(own_slug, str) or own_slug.lower() != slug.lower():
        return None
    return api_id


def resolve_luma(
    client: PoliteClient, feeds: list[Feed], slugs: list[LumaSlug], notes: list[str]
) -> list[Feed]:
    """`feeds` plus every Luma slug's calendar (read from its page, a
    society's own content under D3), merged with a feed already known by
    that URL; a slug whose page is gone or shows no such calendar is dropped
    with a note."""
    by_url = {feed.url: feed for feed in feeds}
    for entry in slugs:
        page_url = LUMA_CALENDAR_PAGE.format(slug=quote(entry.slug, safe="-_"))
        result = client.fetch(page_url, fresh_for=LUMA_PAGE_FRESH_FOR, purpose=SOCIETY)
        if not result.ok:
            notes.append(f"luma calendar {entry.slug}: dropped, {describe_failure(result)}")
            continue
        calendar_id = luma_calendar_id(result.text, entry.slug)
        if calendar_id is None:
            notes.append(f"luma calendar {entry.slug}: dropped, {page_url} shows no calendar")
            continue
        url = luma_feed_url(calendar_id)
        feed = by_url.setdefault(url, Feed(kind="luma", url=url))
        for owner in entry.owners:
            feed.add_owner(owner)
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
    index = OrgLookup.for_stage(ctx)
    feeds = collect_feeds(index)
    slugs = collect_luma_slugs(index)
    if ctx.limit is not None:
        feeds = feeds[: ctx.limit]
        slugs = slugs[: max(0, ctx.limit - len(feeds))]
    tally = Tally()
    pending: list[Sourced] = []
    read = overridden = 0
    images: dict[str, str | None] = {}
    with polite_client(ctx.settings) as client:
        feeds = resolve_luma(client, feeds, slugs, ctx.report.notes)

        for feed in feeds:
            # A feed a society links (D3): the society purpose overrides a
            # robots disallow for Google Calendar public ICS feeds only.
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
            overridden += bool(result.override)
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
    "LumaSlug",
    "clean_luma",
    "collect_feeds",
    "collect_luma_slugs",
    "event_draft",
    "feed_kind",
    "feed_url",
    "google_calendar_id",
    "luma_calendar_id",
    "resolve_luma",
    "run",
]
