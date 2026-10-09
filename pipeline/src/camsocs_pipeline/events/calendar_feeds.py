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
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime
from urllib.parse import quote

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


@dataclass
class Feed:
    kind: str
    url: str
    owners: list[IdentityHints] = field(default_factory=list)


def feed_url(kind: str, value: str) -> str | None:
    """The URL to fetch for a feed reference, or None if it is not usable."""
    value = value.strip()
    if kind == "luma":
        return f"https://api.lu.ma/ics/get?entity=calendar&id={quote(value, safe='-_')}"
    if kind == "google":
        if value.startswith(("http://", "https://")):
            return value
        return f"https://calendar.google.com/calendar/ical/{quote(value, safe='')}/public/basic.ics"
    if value.startswith("webcal://"):
        value = "https://" + value[len("webcal://") :]
    return value if value.startswith(("http://", "https://")) else None


def collect_feeds(index: OrgLookup) -> list[Feed]:
    feeds: dict[str, Feed] = {}

    def add(kind: str, value: str, owner: IdentityHints) -> None:
        url = feed_url(kind, value)
        if url is None:
            return
        feed = feeds.setdefault(url, Feed(kind=kind, url=url))
        if all((o.known_key or o.name) != (owner.known_key or owner.name) for o in feed.owners):
            feed.owners.append(owner)

    for ref in index.feeds(*KINDS):
        add(
            ref.kind,
            ref.value,
            IdentityHints(name=index.name_of(ref.org_key) or ref.org_key, known_key=ref.org_key),
        )
    for seed in FEED_SEEDS:
        add(seed.kind, seed.value, seed.owner)
    return list(feeds.values())


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
        cache[url] = url if probe_image(client, url) else None
    return cache[url]


def run(
    ctx: StageContext, *, window: EventWindow | None = None, now: datetime | None = None
) -> None:
    window = window or default_window(now)
    index = OrgLookup.for_stage(ctx)
    feeds = collect_feeds(index)
    if ctx.limit is not None:
        feeds = feeds[: ctx.limit]
    tally = Tally()
    pending: list[Sourced] = []
    read = 0
    images: dict[str, str | None] = {}
    with polite_client(ctx.settings) as client:
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
    ctx.report.notes.append(f"{read} of {len(feeds)} feeds read")
    write_staging(ctx, records, tally)


__all__ = ["Feed", "clean_luma", "collect_feeds", "event_draft", "feed_url", "run"]
