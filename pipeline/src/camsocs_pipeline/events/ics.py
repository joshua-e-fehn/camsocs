"""Generic iCalendar parsing for society feeds, the CUCBC calendar and the
University events feed (source-research §7, §10, §11).

`parse_ics(data, window)` returns one `IcsEvent` per occurrence inside the
window, with aware datetimes, de-duplicated by UID. Deterministic throughout:
no feed text reaches an LLM.

**Time zones** (in order):

1. ``VALUE=DATE`` → an all-day event from 00:00 London on its first day to
   00:00 London after its last (``DTEND`` is exclusive; none → one day).
2. A floating time (no ``TZID``, no ``Z``) is Cambridge time, Europe/London.
3. A time with a ``TZID`` or in UTC keeps its instant — **unless the zone is
   bogus**. Society calendars are often created with the wrong calendar zone:
   one Google Calendar in the landscape brief (§3 row 3) was set to Asia/Dhaka
   while every event was in Cambridge. The organiser typed Cambridge wall-clock
   times into a calendar that labelled them Dhaka time, so the *wall-clock*
   time is right and the zone is wrong. An event is re-read as Europe/London
   wall-clock time when both hold:

   a. its authoring zone — the event's ``TZID``, or for a UTC (``Z``) time the
      calendar's ``X-WR-TIMEZONE`` (Google exports Z times computed from the
      calendar zone) — is not UTC and its UTC offset at that moment differs
      from London's (so Europe/London, GMT/UTC and Europe/Dublin never
      trigger; Asia/Dhaka, America/New_York or Europe/Paris do);
   b. its ``LOCATION`` is empty, online, or names Cambridge (the word, or a CB
      postcode). Every feed we read belongs to a Cambridge organisation; an
      event that names somewhere else (a tour in Paris) keeps its zone.

   Re-read events are flagged (`IcsEvent.zone_corrected`) and their times are
   claimed as ``inferred``, never ``found``.

**Recurrence.** ``RRULE`` / ``RDATE`` / ``EXDATE`` are expanded with
python-dateutil in the event's wall-clock time (so a weekly 19:00 talk stays at
19:00 across the October clock change), only inside the window, at most
`MAX_OCCURRENCES` per series. A ``RECURRENCE-ID`` override replaces its
occurrence (a ``STATUS:CANCELLED`` override cancels it). Each occurrence's
external id is ``<UID>/<original start, UTC>``, so an override keeps the id of
the occurrence it replaces.

**De-duplication.** One event per external id: a feed listing a UID twice
keeps the copy with the highest ``SEQUENCE`` (then the latest
``LAST-MODIFIED``). A missing UID gets a stable stand-in hashed from the
summary and start.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field, replace
from datetime import UTC, date, datetime, time, timedelta, tzinfo
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import icalendar
from dateutil.rrule import rrulestr

from camsocs_pipeline.events.common import LONDON, EventWindow, london_midnight
from camsocs_pipeline.keys import sha1_hex

logger = logging.getLogger(__name__)

MAX_OCCURRENCES = 400

#: Zone names that are UTC by another name: never "bogus".
_UTC_NAMES = frozenset({"utc", "etc/utc", "z", "gmt", "etc/gmt", "universal", "zulu", "etc/zulu"})

_CAMBRIDGE = re.compile(r"\bcambridge\b|\bCB\d{1,2}\b", re.IGNORECASE)
_ONLINE = re.compile(r"\b(?:online|zoom|teams|google meet|virtual|livestream|webinar)\b", re.I)


class IcsError(ValueError):
    """The bytes are not a readable iCalendar file."""


@dataclass
class IcsEvent:
    uid: str
    external_id: str
    title: str
    starts_at: datetime
    ends_at: datetime | None
    all_day: bool
    description: str | None = None
    location: str | None = None
    url: str | None = None
    #: ``CONFIRMED`` / ``TENTATIVE`` / ``CANCELLED`` as the feed says.
    status: str | None = None
    #: The zone the times were re-read from (see the module docstring).
    zone_corrected: str | None = None
    recurring: bool = False
    categories: list[str] = field(default_factory=list)
    organizer_name: str | None = None
    sequence: int = 0
    modified: datetime | None = None
    image_url: str | None = None


@dataclass
class ParsedCalendar:
    name: str | None
    declared_zone: str | None
    events: list[IcsEvent]
    #: Events whose times were re-read as London time, by original zone.
    corrected: dict[str, int] = field(default_factory=dict)
    skipped: int = 0


# --- zones --------------------------------------------------------------------------------


def _zone_name(zone: tzinfo | None) -> str | None:
    if zone is None:
        return None
    key = getattr(zone, "key", None)
    if key:
        return str(key)
    name = getattr(zone, "_tzid", None) or str(zone)
    return str(name)


def _is_utc(zone: tzinfo | None) -> bool:
    if zone is None:
        return False
    if zone is UTC:
        return True
    name = (_zone_name(zone) or "").lower()
    return name in _UTC_NAMES


def _zone_from_name(name: str | None) -> tzinfo | None:
    if not name or not name.strip():
        return None
    try:
        return ZoneInfo(name.strip())
    except (ZoneInfoNotFoundError, ValueError):
        return None


def _offset(moment: datetime) -> timedelta | None:
    return moment.utcoffset()


def _disagrees_with_london(wall: datetime) -> bool:
    """Whether the aware `wall` time's zone has a different UTC offset than
    London at that moment (and is not plain UTC)."""
    if _is_utc(wall.tzinfo):
        return False
    return _offset(wall) != _offset(wall.astimezone(LONDON))


def _location_is_cambridge(location: str | None) -> bool:
    if not location or not location.strip():
        return True
    return bool(_CAMBRIDGE.search(location) or _ONLINE.search(location))


# --- values -------------------------------------------------------------------------------


def _text(component: Any, name: str) -> str | None:
    value = component.get(name)
    if value is None:
        return None
    if isinstance(value, list):
        value = value[0] if value else None
    text = str(value).strip() if value is not None else ""
    return text or None


def _decoded(component: Any, name: str) -> Any:
    try:
        return component.decoded(name)
    except (KeyError, ValueError, TypeError):
        return None


def _uid(component: Any) -> str:
    uid = _text(component, "UID")
    if uid:
        return uid
    start = _decoded(component, "DTSTART")
    return "nouid-" + sha1_hex(f"{_text(component, 'SUMMARY')}|{start}")[:20]


def _list_values(component: Any, name: str) -> list[Any]:
    """Every date/datetime of a multi-valued property (EXDATE, RDATE)."""
    raw = component.get(name)
    if raw is None:
        return []
    items = raw if isinstance(raw, list) else [raw]
    values: list[Any] = []
    for item in items:
        for entry in getattr(item, "dts", []) or []:
            values.append(entry.dt)
    return values


@dataclass
class _Timing:
    """A component's start/end normalised (zones fixed), plus how."""

    start: datetime
    end: datetime | None
    all_day: bool
    #: The zone the wall-clock time is expanded in.
    zone: tzinfo
    #: The authoring zone the times were re-read from, if they were.
    corrected_from: str | None = None
    #: For a re-read event, the authoring zone (to read EXDATE/UNTIL in).
    authoring: tzinfo | None = None


def _timing(component: Any, calendar_zone: tzinfo | None) -> _Timing | None:
    start = _decoded(component, "DTSTART")
    if start is None:
        return None
    end = _decoded(component, "DTEND")
    duration = _decoded(component, "DURATION")
    if isinstance(start, date) and not isinstance(start, datetime):
        first = london_midnight(start)
        if isinstance(end, date) and not isinstance(end, datetime) and end > start:
            last = london_midnight(end)
        elif isinstance(duration, timedelta) and duration >= timedelta(days=1):
            last = london_midnight(start + timedelta(days=duration.days))
        else:
            last = first + timedelta(days=1)
        return _Timing(start=first, end=last, all_day=True, zone=LONDON)

    if start.tzinfo is None:
        start = start.replace(tzinfo=LONDON)
        zone: tzinfo = LONDON
    else:
        zone = start.tzinfo
    if isinstance(end, datetime):
        end = end.replace(tzinfo=start.tzinfo) if end.tzinfo is None else end
    elif isinstance(duration, timedelta):
        end = start + duration
    else:
        end = None

    authoring: tzinfo | None = zone
    if _is_utc(zone) and calendar_zone is not None:
        authoring = calendar_zone
    timing = _Timing(start=start, end=end, all_day=False, zone=zone)
    location = _text(component, "LOCATION")
    if (
        authoring is not None
        and not _is_utc(authoring)
        and _disagrees_with_london(start.astimezone(authoring))
        and _location_is_cambridge(location)
    ):
        wall = start.astimezone(authoring).replace(tzinfo=None)
        fixed_start = wall.replace(tzinfo=LONDON)
        fixed_end = None
        if end is not None:
            fixed_end = end.astimezone(authoring).replace(tzinfo=None).replace(tzinfo=LONDON)
        return _Timing(
            start=fixed_start,
            end=fixed_end,
            all_day=False,
            zone=LONDON,
            corrected_from=_zone_name(authoring),
            authoring=authoring,
        )
    return timing


def _wall(value: Any, timing: _Timing) -> datetime | None:
    """A recurrence value (EXDATE, RDATE, RECURRENCE-ID, UNTIL) as a naive
    wall-clock time in the expansion zone, matching how occurrences are made."""
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value
        zone = timing.authoring if timing.corrected_from else timing.zone
        return value.astimezone(zone).replace(tzinfo=None)
    if isinstance(value, date):
        if timing.all_day:
            return datetime.combine(value, time(0, 0))
        start_wall = timing.start.astimezone(timing.zone).replace(tzinfo=None)
        return datetime.combine(value, start_wall.time())
    return None


def _rule_text(component: Any, timing: _Timing) -> list[str]:
    rules = component.get("RRULE")
    if rules is None:
        return []
    items = rules if isinstance(rules, list) else [rules]
    texts: list[str] = []
    for rule in items:
        parts = {key: list(values) for key, values in dict(rule).items()}
        if parts.get("UNTIL"):
            until = parts["UNTIL"][0]
            if isinstance(until, date) and not isinstance(until, datetime):
                wall_until = datetime.combine(until, time(23, 59, 59))
            else:
                wall_until = _wall(until, timing) or until
            parts["UNTIL"] = [wall_until]
        text = icalendar.vRecur(parts).to_ical().decode("ascii")
        texts.append(f"RRULE:{text}")
    return texts


def _stamp(moment: datetime) -> str:
    return moment.strftime("%Y%m%dT%H%M%S")


def _occurrences(component: Any, timing: _Timing, window: EventWindow) -> list[datetime]:
    """Wall-clock starts (naive, in the expansion zone) inside the window;
    empty for an event that does not recur."""
    rules = _rule_text(component, timing)
    rdates = [w for w in (_wall(v, timing) for v in _list_values(component, "RDATE")) if w]
    if not rules and not rdates:
        return []
    start_wall = timing.start.astimezone(timing.zone).replace(tzinfo=None)
    lines = [f"DTSTART:{_stamp(start_wall)}", *rules]
    # DTSTART is always the first instance (RFC 5545), even off-pattern.
    lines.append("RDATE:" + ",".join(_stamp(w) for w in [start_wall, *rdates]))
    excluded = [w for w in (_wall(v, timing) for v in _list_values(component, "EXDATE")) if w]
    if excluded:
        lines.append("EXDATE:" + ",".join(_stamp(w) for w in excluded))
    try:
        rules_set = rrulestr("\n".join(lines), forceset=True, ignoretz=True)
    except (ValueError, TypeError) as error:
        logger.warning(
            "%s: unreadable recurrence (%s); first instance only", _uid(component), error
        )
        return [start_wall]
    span = (timing.end - timing.start) if timing.end is not None else timedelta(0)
    low = (window.start.astimezone(timing.zone) - span).replace(tzinfo=None)
    high = window.end.astimezone(timing.zone).replace(tzinfo=None)
    found: list[datetime] = []
    for occurrence in rules_set.between(low, high, inc=True):
        found.append(occurrence)
        if len(found) >= MAX_OCCURRENCES:
            logger.warning("%s: more than %d occurrences, cut", _uid(component), MAX_OCCURRENCES)
            break
    return found


# --- the parser ------------------------------------------------------------------------------


def _external_id(uid: str, original_start: datetime, all_day: bool) -> str:
    if all_day:
        return f"{uid}/{original_start.astimezone(LONDON):%Y%m%d}"
    return f"{uid}/{original_start.astimezone(UTC):%Y%m%dT%H%M%SZ}"


def _base_event(component: Any, uid: str, timing: _Timing) -> IcsEvent:
    categories: list[str] = []
    raw_categories = component.get("CATEGORIES")
    for item in raw_categories if isinstance(raw_categories, list) else [raw_categories]:
        for category in getattr(item, "cats", []) or []:
            if str(category).strip():
                categories.append(str(category).strip())
    organizer = component.get("ORGANIZER")
    organizer_name = None
    if organizer is not None and hasattr(organizer, "params"):
        organizer_name = (organizer.params.get("CN") or "").strip() or None
    modified = _decoded(component, "LAST-MODIFIED") or _decoded(component, "DTSTAMP")
    image = None
    for name in ("IMAGE", "ATTACH"):
        value = _text(component, name)
        if value and value.startswith(("http://", "https://")):
            image = value
            break
    url = _text(component, "URL")
    return IcsEvent(
        uid=uid,
        external_id=uid,
        title=_text(component, "SUMMARY") or "",
        starts_at=timing.start,
        ends_at=timing.end,
        all_day=timing.all_day,
        description=_text(component, "DESCRIPTION"),
        location=_text(component, "LOCATION"),
        url=url if url and url.startswith(("http://", "https://")) else None,
        status=(_text(component, "STATUS") or "").upper() or None,
        zone_corrected=timing.corrected_from,
        categories=categories,
        organizer_name=organizer_name,
        sequence=_sequence(component),
        modified=modified if isinstance(modified, datetime) else None,
        image_url=image,
    )


def _sequence(component: Any) -> int:
    value = _decoded(component, "SEQUENCE")
    return value if isinstance(value, int) else 0


def _newer(candidate: IcsEvent, current: IcsEvent) -> bool:
    if candidate.sequence != current.sequence:
        return candidate.sequence > current.sequence
    if candidate.modified and current.modified:
        return candidate.modified.astimezone(UTC) > current.modified.astimezone(UTC)
    return False


def parse_ics(data: bytes, window: EventWindow) -> ParsedCalendar:
    """See the module docstring. Raises `IcsError` for unreadable input."""
    try:
        calendar = icalendar.Calendar.from_ical(data)
    except (ValueError, IndexError, KeyError) as error:
        raise IcsError(f"not an iCalendar file: {error}") from error
    if calendar.name != "VCALENDAR":
        raise IcsError("not a VCALENDAR")
    declared_name = _text(calendar, "X-WR-TIMEZONE")
    calendar_zone = _zone_from_name(declared_name)
    parsed = ParsedCalendar(
        name=_text(calendar, "X-WR-CALNAME"), declared_zone=declared_name, events=[]
    )

    masters: dict[str, Any] = {}
    overrides: dict[str, list[Any]] = {}
    for component in calendar.walk("VEVENT"):
        uid = _uid(component)
        if component.get("RECURRENCE-ID") is not None:
            overrides.setdefault(uid, []).append(component)
        elif uid not in masters or _sequence(component) > _sequence(masters[uid]):
            masters[uid] = component

    events: dict[str, IcsEvent] = {}

    def keep(event: IcsEvent) -> None:
        if not window.overlaps(event.starts_at, event.ends_at):
            return
        current = events.get(event.external_id)
        if current is None or _newer(event, current):
            events[event.external_id] = event
        if event.zone_corrected:
            parsed.corrected[event.zone_corrected] = (
                parsed.corrected.get(event.zone_corrected, 0) + 1
            )

    for uid, component in masters.items():
        timing = _timing(component, calendar_zone)
        if timing is None:
            parsed.skipped += 1
            continue
        base = _base_event(component, uid, timing)
        starts = _occurrences(component, timing, window)
        if not starts:
            keep(base)
            continue
        replaced: dict[str, Any] = {}
        for override in overrides.get(uid, []):
            rid = _wall(_decoded(override, "RECURRENCE-ID"), timing)
            if rid is not None:
                replaced[rid.isoformat()] = override
        span = (timing.end - timing.start) if timing.end is not None else None
        expansion_zone = LONDON if timing.corrected_from else timing.zone
        for wall in starts:
            original = wall.replace(tzinfo=expansion_zone)
            external_id = _external_id(uid, original, timing.all_day)
            override = replaced.pop(wall.isoformat(), None)
            if override is not None:
                override_timing = _timing(override, calendar_zone) or timing
                event = _base_event(override, uid, override_timing)
            else:
                event = replace(
                    base,
                    starts_at=original,
                    ends_at=original + span if span is not None else None,
                    categories=list(base.categories),
                )
            event.external_id = external_id
            event.recurring = True
            keep(event)
        # Overrides that moved an occurrence from outside the expanded set.
        for wall_iso, override in replaced.items():
            override_timing = _timing(override, calendar_zone)
            if override_timing is None:
                continue
            original = datetime.fromisoformat(wall_iso).replace(tzinfo=expansion_zone)
            event = _base_event(override, uid, override_timing)
            event.external_id = _external_id(uid, original, timing.all_day)
            event.recurring = True
            keep(event)

    parsed.events = sorted(events.values(), key=lambda e: (e.starts_at, e.external_id))
    return parsed


__all__ = ["MAX_OCCURRENCES", "IcsError", "IcsEvent", "ParsedCalendar", "parse_ics"]
