"""`camsocs clean-events`: stored events that a corrected reader will never
restate, found and — on production, only when asked — removed (review
2026-10-10; docs/deploy.md §7).

The load judges calendar noise (D6) and makes titles safe (D1) only for the
readings it posts, and the events stages read nothing older than a week
(`events.common.LOOKBACK_DAYS`). So what a deployment stored before those
fixes stays: a past prayer-room notice in the month view, a CTF from last week
counted as the society's activity, a title that reads "I someone". A future
event a listing stops showing is withdrawn by its listing (`sweepGroup`), but
not one whose card file was its listing and is no longer read.

The candidates (`candidates`), each with its reason:

- ``notice:<rule>`` — the D6 rules (`events.noise.judge`) judge the stored
  title a notice, past or future;
- ``external:<rule>`` — a past event the D6 rules decisively judge someone
  else's (a CTFtime import, a "[External]" title, a talks.cam relay) that is
  stored as the society's own (`hosting` not ``takes_part``);
- ``stale-redaction`` — a title that reads "someone" (an earlier redaction)
  the latest harvest did not see again;
- ``stale-card`` — a future term-card event no card read since three days
  before the newest card sighting (a card a page no longer shows, swept by its
  own file before the cards were swept by their page).

The command lists them by key, London date, source and reason — titles only
with ``--titles``: the terminal is not a run log, but a notice's title can
name its booker. ``--apply`` removes them through the guarded route
(``POST /api/pipeline/events/remove``: events only, by key, confirmed, 25 a
call), and only with ``--env prod``.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from camsocs_pipeline.events.noise import EventText, judge, own_names
from camsocs_pipeline.models.wire import ScannedEvent
from camsocs_pipeline.sources.links import name_tokens

LONDON = ZoneInfo("Europe/London")
#: How far a sighting may lag the newest before the harvest no longer reads it
#: (the server's `WITHDRAWN_AFTER_MS`).
STALE_AFTER = timedelta(days=3)
#: A stored event's source → the source type its reading had (what the rules
#: read: a calendar feed, a society's page, a listing that states its events).
_SOURCE_TYPES = {
    "camdram": "camdram",
    "talks_cam": "talks_list",
    "ics": "ics_feed",
    "google_calendar": "ics_feed",
    "luma": "luma",
    "website": "society_website",
    "termcard": "termcard",
    "mailing_list": "mailing_list_email",
    "instagram_api": "instagram_api",
}
_SOMEONE = re.compile(r"(?i)(?<![\w'’])someone(?![\w'’])")
_URL = re.compile(r"https?://[^\s<>\"'()\[\]]+", re.IGNORECASE)


@dataclass(frozen=True)
class Candidate:
    key: str
    reason: str
    starts_at: int
    source: str
    title: str

    def line(self, *, titles: bool) -> str:
        day = datetime.fromtimestamp(self.starts_at / 1000, UTC).astimezone(LONDON)
        shown = f'  "{" ".join(self.title.split())[:80]}"' if titles else ""
        return f"{self.key}  {day:%Y-%m-%d}  {self.source:<16} {self.reason}{shown}"


def _organiser_names(keys: Iterable[str]) -> tuple[str, ...]:
    """An organisation's words from its key (``org-cyber-security-society``):
    enough for the rules' "names its own organiser"."""
    return tuple(" ".join(key.removeprefix("org-").split("-")) for key in keys if key)


def text_of(event: ScannedEvent) -> EventText:
    """A stored event as the D6 rules read a staged reading."""
    names = _organiser_names(event.organiser_keys)
    description = event.description or ""
    return EventText(
        title=event.title,
        description=description,
        venue=event.venue_text or "",
        urls=tuple(dict.fromkeys(match.group(0) for match in _URL.finditer(description))),
        organisers=names,
        own_tokens=frozenset(name_tokens(*names)),
        own_names=own_names(names),
        source_type=_SOURCE_TYPES.get(event.source, event.source),
        event_source=event.source,
    )


def candidates(events: Sequence[ScannedEvent], *, now: datetime) -> list[Candidate]:
    """The stored events to remove, with their reasons (module docstring)."""
    now_ms = int(now.timestamp() * 1000)
    newest = max((event.last_seen_at for event in events), default=0)
    cards = [event.last_seen_at for event in events if event.source == "termcard"]
    newest_card = max(cards, default=0)
    stale_ms = int(STALE_AFTER.total_seconds() * 1000)
    out: list[Candidate] = []
    for event in events:
        verdict = judge(text_of(event))
        reason: str | None = None
        if verdict.kind == "notice":
            reason = f"notice:{verdict.rule}"
        elif (
            verdict.kind == "external"
            and event.hosting != "takes_part"
            and event.starts_at < now_ms
        ):
            reason = f"external:{verdict.rule}"
        elif _SOMEONE.search(event.title) and event.last_seen_at < newest - stale_ms:
            reason = "stale-redaction"
        elif (
            event.source == "termcard"
            and event.starts_at >= now_ms
            and event.last_seen_at < newest_card - stale_ms
        ):
            reason = "stale-card"
        if reason is not None:
            out.append(Candidate(event.key, reason, event.starts_at, event.source, event.title))
    return sorted(out, key=lambda c: (c.reason, c.starts_at, c.key))


__all__ = ["STALE_AFTER", "Candidate", "candidates", "text_of"]
