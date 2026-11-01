"""iCalendar feeds a department publishes (source kind ``ics``, source type
``dept_ics``): The Events Calendar's ``?ical=1`` exports, Timely calendars
and the like. Parsing is `events.ics.parse_ics` (recurrences expanded inside
the window, London for floating times, de-duplicated by UID); each
occurrence becomes an item: ``SUMMARY`` the title, ``LOCATION`` the venue,
``DESCRIPTION`` the abstract, ``CATEGORIES`` the labels the talk filter reads
too, ``URL`` the talk's page (else the feed), ``STATUS:CANCELLED`` cancels.
An empty answer (The Events Calendar sends an empty 200 when nothing is
upcoming) is an empty calendar, not an error. Google Calendar feeds are
never read (spec §1); none is in the registry.
"""

from __future__ import annotations

from camsocs_pipeline.events.ics import IcsError, parse_ics
from camsocs_pipeline.talks.sites.common import (
    ParsedTalk,
    SiteContext,
    SourceError,
    canonical,
    talks_cam_id,
)

SOURCE_TYPE = "dept_ics"


def collect(ctx: SiteContext) -> None:
    result = ctx.get(ctx.source.url, accept="text/calendar, */*;q=0.5")
    if not (result.content or b"").strip():
        # The Events Calendar answers an empty 200 when nothing is upcoming.
        ctx.read.says_empty = True
        return
    try:
        calendar = parse_ics(result.content or b"", ctx.window)
    except IcsError as error:
        raise SourceError(f"not an iCalendar feed: {ctx.source.url} ({error})") from error
    for event in calendar.events:
        url = canonical(event.url) if event.url else ctx.source.url
        item = ParsedTalk(
            external_id=event.external_id,
            url=url,
            source_url=ctx.source.url,
            title=event.title,
            starts_at=event.starts_at,
            ends_at=event.ends_at,
            all_day=event.all_day,
            venue=event.location,
            abstract=event.description,
            categories=list(event.categories),
            cancelled=True if (event.status or "").upper() == "CANCELLED" else None,
            talks_cam_id=talks_cam_id(event.url, event.description),
        )
        ctx.keep(item, result)
