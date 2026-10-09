"""University events programme → society events only (source-research §10;
stage `uni_events`).

**robots.txt blocks it.** Re-verified 2026-10-07: every endpoint of the
University's events service (``events.json``, ``.rss``, ``.ics``, the image
store) is on ``webservices.admin.cam.ac.uk``, whose robots.txt is
``User-agent: *`` / ``Disallow: /``. It is not a society's page, so Joshua's
decision D3 (PLAN.md, 2026-10-08) keeps it out entirely: the fetch policy
(`sources/policy.py`) lists the host as never fetched, whatever the purpose.
The polite client refuses before any request (not even robots.txt is read)
and the run notes say so. The parser is kept in case the policy and the
block both change.

**Format.** The stage reads the programme's iCalendar export
(``events.ics?resultSetSize=…``, linked from the public What's On page as the
subscribe feed) through `events.ics`, a standard format, rather than
``events.json``, whose schema could not be checked without breaching
robots.txt.

**Conservative filter.** The programme is mostly the University's own events
(context for partners, not a society calendar). An event is kept only when it
names a known society: the feed's ``ORGANIZER`` name, or else the title,
contains the full name or a multi-word alias (at least `MIN_NAME_LENGTH`
characters, whole words) of exactly one organisation in staging whose type is
a student group (`STUDENT_GROUP_TYPES`). That organisation is the organiser.
Every other event is skipped.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime

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
from camsocs_pipeline.models.observation import IdentityHints, OrganiserObs
from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.resolve.lookup import OrgLookup

FEED_URL = (
    "https://webservices.admin.cam.ac.uk/events/api/programmes/11/calendar/"
    "events.ics?resultSetSize=20000"
)
SOURCE_TYPE = "uni_events_api"
EVENT_SOURCE = "uni_events_api"
EVIDENCE = "secondary"
COVERS = frozenset({"description", "endsAt", "venueText"})

MIN_NAME_LENGTH = 10
STUDENT_GROUP_TYPES = frozenset(
    {
        "society",
        "sports_club",
        "college_club",
        "jcr",
        "mcr",
        "college_boat_club",
        "theatre_company",
        "media",
    }
)


@dataclass(frozen=True)
class _Name:
    key: str
    pattern: re.Pattern[str]
    length: int


def society_names(index: OrgLookup) -> list[_Name]:
    names: list[_Name] = []
    for key, name in index.organisations().items():
        if index.org_type(key) not in STUDENT_GROUP_TYPES:
            continue
        cleaned = " ".join(name.split())
        if len(cleaned) < MIN_NAME_LENGTH or " " not in cleaned:
            continue
        names.append(
            _Name(key, re.compile(rf"(?<!\w){re.escape(cleaned)}(?!\w)", re.I), len(cleaned))
        )
    return names


def match_society(event: IcsEvent, names: list[_Name]) -> str | None:
    """The one student group the event names (organiser first, then title)."""
    for text in (event.organizer_name, event.title):
        if not text:
            continue
        hits = {name.key: name.length for name in names if name.pattern.search(text)}
        if not hits:
            continue
        longest = max(hits.values())
        winners = [key for key, length in hits.items() if length == longest]
        return winners[0] if len(winners) == 1 else None
    return None


def event_draft(event: IcsEvent, org_key: str, org_name: str) -> EventDraft:
    event_type = infer_event_type(event.title)
    inferred = {"eventType"}
    if event.zone_corrected:
        inferred |= {"startsAt", "endsAt"}
    return EventDraft(
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
        organisers=[
            OrganiserObs(identity=IdentityHints(name=org_name, known_key=org_key), role="organiser")
        ],
        inferred=inferred,
        covers=COVERS,
    )


def run(
    ctx: StageContext, *, window: EventWindow | None = None, now: datetime | None = None
) -> None:
    window = window or default_window(now)
    index = OrgLookup.for_stage(ctx)
    names = society_names(index)
    tally = Tally()
    with polite_client(ctx.settings) as client:
        result = client.fetch(FEED_URL, accept="text/calendar,*/*;q=0.5")
    if not result.ok or result.content is None:
        ctx.report.notes.append(f"not fetched — {describe_failure(result)}")
        return
    try:
        calendar = parse_ics(result.content, window)
    except IcsError as error:
        ctx.report.notes.append(f"unreadable feed: {error}")
        return
    pending: list[Sourced] = []
    for event in calendar.events:
        key = match_society(event, names)
        if key is None:
            tally.drop("not a society's event")
            continue
        pending.append(
            Sourced(event_draft(event, key, index.name_of(key) or key), FEED_URL, result)
        )
    if ctx.limit is not None:
        pending = pending[: ctx.limit]
    records = observations_from(
        pending, window, tally, source_type=SOURCE_TYPE, evidence=EVIDENCE, index=index, now=now
    )
    write_staging(ctx, records, tally)


__all__ = ["FEED_URL", "event_draft", "match_society", "run", "society_names"]
