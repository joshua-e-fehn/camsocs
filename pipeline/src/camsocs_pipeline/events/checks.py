"""Date sanity and the "link in bio" flag for every event before it is staged.

SocTrackr's evidence (landscape brief §3 row 8): of 1,858 events extracted from
Instagram, 5 had impossible dates (1980, 1996) and 255 pointed to a "link in
bio" instead of a booking link. Structured feeds rarely do either, but the same
checks run on every source so later sources (mail, Instagram, termcards) get
them for free.

- **Impossible dates are rejected**: a start before 2000 or more than two years
  after today, or more than a year before today (a stale feed entry is not a
  current event).
- **An end before the start is dropped** (the start stands); so is an end more
  than 31 days after a timed start, which is a feed error rather than an event.
- **Outside the window** is not an error: the event is simply left out.
- **"Link in bio"** (or a Linktree link) in the title or description sets
  `EventDraft.link_in_bio`; the builder then records `bookingUrl` as missing
  with reason ``not_published`` unless the source gave a real one.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from camsocs_pipeline.events.common import EventDraft, EventWindow

EARLIEST_YEAR = 2000
MAX_YEARS_AHEAD = 2
MAX_DAYS_BEHIND = 366
MAX_TIMED_SPAN = timedelta(days=31)

_LINK_IN_BIO = re.compile(
    r"\blink\s+(?:is\s+)?in\s+(?:our\s+|the\s+|my\s+)?bio\b|\blinktr\.ee\b|\blinktree\b",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class CheckResult:
    keep: bool
    reason: str | None = None


def mentions_link_in_bio(*texts: str | None) -> bool:
    return any(text and _LINK_IN_BIO.search(text) for text in texts)


def check_draft(
    draft: EventDraft, window: EventWindow, *, now: datetime | None = None
) -> CheckResult:
    """Applies the rules in the module docstring; may clear `ends_at` and set
    `link_in_bio` on the draft."""
    today = (now or datetime.now(UTC)).astimezone(UTC)
    start = draft.starts_at
    if start.tzinfo is None:
        return CheckResult(False, "naive time")
    if (
        start.year < EARLIEST_YEAR
        or start.year > today.year + MAX_YEARS_AHEAD
        or start < today - timedelta(days=MAX_DAYS_BEHIND)
    ):
        return CheckResult(False, "impossible date")
    if draft.ends_at is not None and (
        draft.ends_at < start or (not draft.all_day and draft.ends_at - start > MAX_TIMED_SPAN)
    ):
        draft.ends_at = None
    if not window.overlaps(start, draft.ends_at):
        return CheckResult(False, "outside the window")
    if not draft.title.strip():
        return CheckResult(False, "no title")
    draft.link_in_bio = mentions_link_in_bio(draft.title, draft.description)
    return CheckResult(True)


__all__ = ["CheckResult", "check_draft", "mentions_link_in_bio"]
