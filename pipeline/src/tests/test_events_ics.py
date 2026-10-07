"""iCalendar parsing: time zones (incl. the bogus-zone heuristic), recurrence
expansion inside the window, and de-duplication by UID (events/ics.py)."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from camsocs_pipeline.events.common import LONDON, EventWindow, default_window
from camsocs_pipeline.events.ics import IcsError, parse_ics

NOW = datetime(2026, 10, 7, 12, 0, tzinfo=UTC)
WINDOW = default_window(NOW)  # 30 Sep – 16 Dec 2026, London


def calendar(*events: str, header: str = "") -> bytes:
    body = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\n" + header
    for event in events:
        body += "BEGIN:VEVENT\r\n" + event.strip().replace("\n", "\r\n") + "\r\nEND:VEVENT\r\n"
    return (body + "END:VCALENDAR\r\n").encode()


def london(*args: int) -> datetime:
    return datetime(*args, tzinfo=LONDON)


def by_id(parsed) -> dict:
    return {event.external_id: event for event in parsed.events}


class TestTimeZones:
    def test_floating_times_are_cambridge_time(self) -> None:
        parsed = parse_ics(calendar("UID:a\nSUMMARY:Talk\nDTSTART:20261014T190000"), WINDOW)
        assert parsed.events[0].starts_at == london(2026, 10, 14, 19, 0)
        assert parsed.events[0].zone_corrected is None

    def test_utc_and_london_zones_keep_their_instant(self) -> None:
        parsed = parse_ics(
            calendar(
                "UID:utc\nSUMMARY:A\nDTSTART:20261014T180000Z\nDTEND:20261014T190000Z",
                "UID:ldn\nSUMMARY:B\nDTSTART;TZID=Europe/London:20261015T190000",
                "UID:win\nSUMMARY:C\nDTSTART;TZID=GMT Standard Time:20261016T190000",
            ),
            WINDOW,
        )
        events = by_id(parsed)
        assert events["utc"].starts_at == london(2026, 10, 14, 19, 0)
        assert events["utc"].ends_at == london(2026, 10, 14, 20, 0)
        assert events["ldn"].starts_at == london(2026, 10, 15, 19, 0)
        assert events["win"].starts_at == london(2026, 10, 16, 19, 0)
        assert not parsed.corrected

    def test_a_bogus_calendar_zone_is_re_read_as_london_wall_time(self) -> None:
        # Google exports Z times computed from the calendar zone: the organiser
        # typed 18:00 into a calendar labelled Asia/Dhaka (UTC+6) → 12:00Z.
        parsed = parse_ics(
            calendar(
                "UID:g\nSUMMARY:Concert\nDTSTART:20261015T120000Z\nDTEND:20261015T140000Z\n"
                "LOCATION:West Road Concert Hall\\, Cambridge CB3 9DP",
                header="X-WR-TIMEZONE:Asia/Dhaka\r\n",
            ),
            WINDOW,
        )
        event = parsed.events[0]
        assert event.starts_at == london(2026, 10, 15, 18, 0)
        assert event.ends_at == london(2026, 10, 15, 20, 0)
        assert event.zone_corrected == "Asia/Dhaka"
        assert parsed.corrected == {"Asia/Dhaka": 1}

    def test_a_bogus_event_zone_is_re_read_when_the_location_is_empty_or_online(self) -> None:
        parsed = parse_ics(
            calendar(
                "UID:a\nSUMMARY:Talk\nDTSTART;TZID=America/New_York:20261020T190000",
                "UID:b\nSUMMARY:Call\nDTSTART;TZID=Asia/Dhaka:20261021T180000\nLOCATION:Zoom",
            ),
            WINDOW,
        )
        events = by_id(parsed)
        assert events["a"].starts_at == london(2026, 10, 20, 19, 0)
        assert events["b"].starts_at == london(2026, 10, 21, 18, 0)

    def test_an_event_that_names_somewhere_else_keeps_its_zone(self) -> None:
        parsed = parse_ics(
            calendar(
                "UID:trip\nSUMMARY:Trip\nDTSTART;TZID=Europe/Paris:20261016T100000\n"
                "LOCATION:Musée d'Orsay\\, Paris"
            ),
            WINDOW,
        )
        event = parsed.events[0]
        assert event.starts_at.astimezone(UTC) == datetime(2026, 10, 16, 8, 0, tzinfo=UTC)
        assert event.zone_corrected is None

    def test_a_zone_with_londons_offset_is_never_bogus(self) -> None:
        parsed = parse_ics(
            calendar("UID:d\nSUMMARY:X\nDTSTART;TZID=Europe/Dublin:20261014T190000"),
            WINDOW,
        )
        assert parsed.events[0].zone_corrected is None

    def test_all_day_events_run_from_london_midnight_to_midnight(self) -> None:
        parsed = parse_ics(
            calendar(
                "UID:one\nSUMMARY:Fair\nDTSTART;VALUE=DATE:20261020",
                "UID:two\nSUMMARY:Camp\nDTSTART;VALUE=DATE:20261024\nDTEND;VALUE=DATE:20261026",
            ),
            WINDOW,
        )
        events = by_id(parsed)
        assert events["one"].all_day
        assert (events["one"].starts_at, events["one"].ends_at) == (
            london(2026, 10, 20, 0, 0),
            london(2026, 10, 21, 0, 0),
        )
        # 25 Oct is the clock change: still midnight London on both ends.
        assert events["two"].ends_at == london(2026, 10, 26, 0, 0)


class TestRecurrence:
    def test_weekly_events_keep_their_wall_time_across_the_clock_change(self) -> None:
        parsed = parse_ics(
            calendar(
                "UID:w\nSUMMARY:Weekly\nDTSTART;TZID=Europe/London:20261014T190000\n"
                "DTEND;TZID=Europe/London:20261014T200000\nRRULE:FREQ=WEEKLY;COUNT=4"
            ),
            WINDOW,
        )
        starts = [event.starts_at for event in parsed.events]
        assert starts == [london(2026, 10, d, 19, 0) for d in (14, 21, 28)] + [
            london(2026, 11, 4, 19, 0)
        ]
        assert [e.starts_at.astimezone(UTC).hour for e in parsed.events] == [18, 18, 19, 19]
        assert all(event.recurring for event in parsed.events)
        assert parsed.events[0].external_id == "w/20261014T180000Z"

    def test_exdate_until_and_the_window_bound_the_expansion(self) -> None:
        parsed = parse_ics(
            calendar(
                "UID:w\nSUMMARY:Weekly\nDTSTART;TZID=Europe/London:20260902T190000\n"
                "RRULE:FREQ=WEEKLY;UNTIL=20261021T235959Z\n"
                "EXDATE;TZID=Europe/London:20261014T190000"
            ),
            WINDOW,
        )
        # Starts before the window (2 Sep): only 30 Sep … 21 Oct, minus 14 Oct.
        assert [e.starts_at.date().isoformat() for e in parsed.events] == [
            "2026-09-30",
            "2026-10-07",
            "2026-10-21",
        ]

    def test_an_unbounded_rule_stops_at_the_window(self) -> None:
        parsed = parse_ics(
            calendar("UID:d\nSUMMARY:Daily\nDTSTART:20261001T080000Z\nRRULE:FREQ=DAILY"),
            WINDOW,
        )
        assert parsed.events[-1].starts_at < WINDOW.end
        assert len(parsed.events) == 76  # 1 Oct … 15 Dec

    def test_overrides_move_or_cancel_one_occurrence(self) -> None:
        parsed = parse_ics(
            calendar(
                "UID:w\nSUMMARY:Weekly\nDTSTART;TZID=Europe/London:20261014T190000\n"
                "RRULE:FREQ=WEEKLY;COUNT=3",
                "UID:w\nRECURRENCE-ID;TZID=Europe/London:20261021T190000\n"
                "DTSTART;TZID=Europe/London:20261021T200000\nSUMMARY:Weekly (moved)",
                "UID:w\nRECURRENCE-ID;TZID=Europe/London:20261028T190000\n"
                "DTSTART;TZID=Europe/London:20261028T190000\nSUMMARY:Weekly\nSTATUS:CANCELLED",
            ),
            WINDOW,
        )
        events = by_id(parsed)
        moved = events["w/20261021T180000Z"]
        assert (moved.title, moved.starts_at) == ("Weekly (moved)", london(2026, 10, 21, 20, 0))
        assert events["w/20261028T190000Z"].status == "CANCELLED"
        assert len(parsed.events) == 3

    def test_a_bogus_zone_is_corrected_before_expanding(self) -> None:
        parsed = parse_ics(
            calendar(
                "UID:r\nSUMMARY:Rehearsal\nDTSTART;TZID=Asia/Dhaka:20261020T180000\n"
                "RRULE:FREQ=WEEKLY;COUNT=2\nEXDATE;TZID=Asia/Dhaka:20261027T180000\n"
                "RDATE;TZID=Asia/Dhaka:20261029T180000"
            ),
            WINDOW,
        )
        assert [e.starts_at for e in parsed.events] == [
            london(2026, 10, 20, 18, 0),
            london(2026, 10, 29, 18, 0),
        ]
        assert all(e.zone_corrected == "Asia/Dhaka" for e in parsed.events)


class TestDeduplication:
    def test_a_uid_listed_twice_keeps_the_highest_sequence(self) -> None:
        parsed = parse_ics(
            calendar(
                "UID:dup\nSEQUENCE:1\nSUMMARY:Old title\nDTSTART:20261018T180000Z",
                "UID:dup\nSEQUENCE:3\nSUMMARY:New title\nDTSTART:20261018T190000Z",
                "UID:dup\nSEQUENCE:2\nSUMMARY:Middle title\nDTSTART:20261018T170000Z",
            ),
            WINDOW,
        )
        assert [(e.external_id, e.title) for e in parsed.events] == [("dup", "New title")]

    def test_a_missing_uid_gets_a_stable_stand_in(self) -> None:
        source = calendar("SUMMARY:No uid\nDTSTART:20261018T180000Z")
        first, second = parse_ics(source, WINDOW), parse_ics(source, WINDOW)
        assert first.events[0].uid.startswith("nouid-")
        assert first.events[0].uid == second.events[0].uid

    def test_events_outside_the_window_are_left_out(self) -> None:
        parsed = parse_ics(
            calendar(
                "UID:old\nSUMMARY:Old\nDTSTART:20250101T180000Z",
                "UID:far\nSUMMARY:Far\nDTSTART:20270601T180000Z",
            ),
            WINDOW,
        )
        assert parsed.events == []


def test_unreadable_input_is_an_error() -> None:
    with pytest.raises(IcsError):
        parse_ics(b"<html>not a calendar</html>", WINDOW)


def test_window_months_cover_every_month_touched() -> None:
    window = EventWindow(london(2026, 9, 30, 0, 0), london(2026, 12, 16, 0, 0))
    assert window.months() == [(2026, 9), (2026, 10), (2026, 11), (2026, 12)]
