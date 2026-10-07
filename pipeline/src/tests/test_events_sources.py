"""Each event source on synthetic fixtures shaped like the live pages (checked
2026-10-07), parsers first, then the stage end to end against mocked hosts."""

from __future__ import annotations

import json
from datetime import UTC, date, datetime
from pathlib import Path

import pytest
import respx

from camsocs_pipeline.events import (
    calendar_feeds,
    camdram,
    cucbc,
    playwaze,
    su_whatson,
    talks_cam,
    uni_events,
)
from camsocs_pipeline.events.common import LONDON, default_window
from camsocs_pipeline.events.ics import IcsEvent
from camsocs_pipeline.events.organisers import OrganiserIndex
from camsocs_pipeline.models.observation import EventObservation, IdentityHints, Observation
from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.pipeline.load import ConvexLoader, plan_observations
from camsocs_pipeline.pipeline.report import RunReport
from camsocs_pipeline.pipeline.state import SyncState
from camsocs_pipeline.sources.base import HostGates, PoliteClient
from camsocs_pipeline.staging.store import StagingStore

FIXTURES = Path(__file__).parent / "fixtures" / "events"
NOW = datetime(2026, 10, 7, 12, 0, tzinfo=UTC)
WINDOW = default_window(NOW)
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


def fixture(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def london(*args: int) -> datetime:
    return datetime(*args, tzinfo=LONDON)


@pytest.fixture
def ctx(tmp_path: Path, make_settings, monkeypatch: pytest.MonkeyPatch) -> StageContext:
    """A stage context whose crawler never sleeps (Crawl-delay is asserted
    through the sleeps it records instead)."""
    sleeps: list[float] = []
    settings = make_settings(min_host_interval=0.0)

    def fast_client(_settings, *, min_interval: float | None = None) -> PoliteClient:
        return PoliteClient(
            user_agent=settings.user_agent,
            cache_dir=settings.cache_dir,
            min_interval=min_interval or 0.0,
            gates=HostGates(),
            sleep=sleeps.append,
        )

    for module in (calendar_feeds, camdram, cucbc, playwaze, su_whatson, talks_cam, uni_events):
        monkeypatch.setattr(module, "polite_client", fast_client)
    run = RunReport(run_key="20261007T120000Z-abcdef", command="sync", dry_run=True)
    context = StageContext(
        settings=settings,
        report=run.stage("test"),
        run=run,
        loader=ConvexLoader("", "", dry_run=True),
        state=SyncState(),
        staging=StagingStore(tmp_path / "staging"),
        dry_run=True,
        limit=None,
    )
    context.sleeps = sleeps  # type: ignore[attr-defined]
    return context


def staged(ctx: StageContext, directory: str) -> list:
    return ctx.staging.read_latest(directory)


def fields(observation: EventObservation) -> dict:
    return {f.field: f.value for f in observation.fields if f.value is not None}


def allow(net: respx.MockRouter, origin: str, robots: str | None = None) -> None:
    if robots is None:
        net.get(f"{origin}/robots.txt").respond(404)
    else:
        net.get(f"{origin}/robots.txt").respond(200, text=robots)


# --- Camdram (§5) ------------------------------------------------------------------------


class TestCamdram:
    def test_runs_expand_to_one_event_per_night_sharing_the_show_series(self) -> None:
        diary = camdram.parse_diary(fixture("camdram_diary.json"))
        show = camdram.parse_show(fixture("camdram_show.json"))
        assert diary.skipped == 1
        run = diary.performances[0]
        drafts = camdram.performance_drafts(run, show, image="https://img/x.jpg")
        assert [d.starts_at for d in drafts] == [london(2026, 10, d, 19, 45) for d in range(13, 18)]
        assert drafts[0].external_id == "show:9001/performance:501/2026-10-13"
        assert {d.page_url for d in drafts} == {"https://www.camdram.net/shows/2026-the-test-play"}
        assert drafts[0].booking_url == "https://www.example-theatre.org/whats-on/test-play/"
        assert drafts[0].venue.known_key == "ven-adc-theatre"
        # Display order: the first society organises, the others co-host.
        assert [(o.identity.name, o.role) for o in drafts[0].organisers] == [
            ("Touring Company", "organiser"),
            ("Test Players", "co_host"),
            ("A Free-Text Society", "co_host"),
        ]
        assert drafts[0].organisers[0].identity.camdram_id == 7

    def test_a_late_run_after_the_clock_change_stays_at_its_wall_time(self) -> None:
        late = camdram.parse_diary(fixture("camdram_diary.json")).performances[2]
        assert camdram.nights(late) == [london(2026, 11, d, 21, 30) for d in (4, 5, 6, 7)]
        assert camdram.performance_drafts(late, None)[0].venue.name == "Pembroke New Cellars"

    def test_a_months_long_run_is_one_event(self) -> None:
        film = camdram.parse_diary(fixture("camdram_diary.json")).performances[3]
        drafts = camdram.performance_drafts(film, None)
        assert len(drafts) == 1
        assert drafts[0].external_id == "show:9003/performance:504"
        assert (drafts[0].starts_at, drafts[0].ends_at, drafts[0].all_day) == (
            london(2026, 5, 29, 0, 0),
            london(2026, 12, 19, 0, 0),
            True,
        )
        assert drafts[0].venue is None  # "Not applicable"

    def test_the_stage_stages_events_and_their_venues(
        self, ctx: StageContext, net: respx.MockRouter
    ) -> None:
        base = "https://www.camdram.net"
        allow(net, base, "User-agent: *\n")
        net.get(url__startswith=f"{base}/diary.json").respond(
            200, content=fixture("camdram_diary.json")
        )
        net.get(f"{base}/venues.json").respond(200, content=fixture("camdram_venues.json"))
        net.get(f"{base}/shows/2026-the-test-play.json").respond(
            200, content=fixture("camdram_show.json")
        )
        net.get(f"{base}/shows/2026-late-show.json").respond(404)
        net.get(f"{base}/shows/2026-a-short-film.json").respond(404)
        net.get(f"{base}/media/cache/preview/abc123.jpg").respond(200, content=PNG)
        ctx.settings.camdram_api_key = type(ctx.settings.camdram_api_key)("secret-token")

        camdram.run(ctx, window=WINDOW, now=NOW)

        records = staged(ctx, "camdram.events")
        venues = [r for r in records if isinstance(r, Observation)]
        events = [r for r in records if isinstance(r, EventObservation)]
        assert [(v.entity_key, v.identity.aliases) for v in venues] == [
            ("ven-adc-theatre", ["ADC"])
        ]
        assert len(events) == 6 + 4 + 1 + 1  # test play, late show, film, open day
        play = next(e for e in events if e.external_id.endswith("501/2026-10-13"))
        assert fields(play)["image"] == {"sourceUrl": f"{base}/media/cache/preview/abc123.jpg"}
        assert play.source_url == f"{base}/shows/2026-the-test-play.json"
        open_day = next(e for e in events if e.external_id.startswith("event:77/"))
        assert fields(open_day)["title"] == "Open Day"
        assert [o.identity.camdram_slug for o in open_day.unresolved_organisers] == [
            "test-dramatic-club"
        ]
        diary_call = next(c for c in net.calls if "/diary.json" in str(c.request.url))
        assert "end=2026-12-16" in str(diary_call.request.url)
        assert diary_call.request.headers["authorization"] == "Bearer secret-token"
        assert any("left out" in n or "staged 12 events" in n for n in ctx.report.notes)


# --- talks.cam (§6) ------------------------------------------------------------------------


class TestTalksCam:
    def test_the_xml_parses_deterministically(self) -> None:
        parsed = talks_cam.parse_list(fixture("talks_list.xml"))
        assert (parsed.id, parsed.name, parsed.skipped) == ("123456", "Test Society Talks", 1)
        talk = parsed.talks[0]
        assert talk.start == datetime(2026, 10, 14, 18, 30, tzinfo=UTC)
        assert talk.url == "https://talks.cam.ac.uk/talk/index/900001"

    def test_speakers_cancellations_and_foreign_series(self) -> None:
        parsed = talks_cam.parse_list(fixture("talks_list.xml"))
        owner = IdentityHints(name="Test Society", known_key="org-test-society")
        drafts = talks_cam.talk_drafts(parsed, owner)
        assert [d.external_id for d in drafts] == ["900001", "900002"]  # 900003 is another series
        first, cancelled = drafts
        assert first.speakers == [{"name": "Dr Ada Example", "affiliation": "Institute of Testing"}]
        assert cancelled.speakers == [
            {"name": "Prof B Sample"},
            {"name": "Dr C Demo", "affiliation": "Elsewhere University"},
        ]
        assert cancelled.cancelled and "cancelled" in cancelled.inferred
        assert first.organisers[0].identity.known_key == "org-test-society"

    def test_the_stage_honours_crawl_delay_and_never_uses_the_xml_organiser(
        self, ctx: StageContext, net: respx.MockRouter, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from camsocs_pipeline.events import seeds

        monkeypatch.setattr(
            talks_cam,
            "TALKS_SEEDS",
            (
                seeds.TalksSeed("123456", IdentityHints(name="Test Society"), "https://x", "d"),
                seeds.TalksSeed("654321", IdentityHints(name="Other"), "https://y", "d"),
            ),
        )
        allow(
            net,
            "https://talks.cam.ac.uk",
            "User-agent: ClaudeBot\nDisallow: /\n\nUser-agent: *\nCrawl-delay: 10\n",
        )
        net.get(url__startswith="https://talks.cam.ac.uk/show/xml/123456").respond(
            200, content=fixture("talks_list.xml")
        )
        net.get(url__startswith="https://talks.cam.ac.uk/show/xml/654321").respond(404)

        talks_cam.run(ctx, window=WINDOW, now=NOW)

        events = staged(ctx, "talks_list.events")
        assert [e.external_id for e in events] == ["900001", "900002"]
        assert all(e.source_url == "https://talks.cam.ac.uk/show/xml/123456" for e in events)
        assert all(e.fetch and e.fetch.robots_verdict == "crawl_delay" for e in events)
        assert "A Person" not in json.dumps([e.model_dump(mode="json") for e in events])
        assert any(s > 9 for s in ctx.sleeps)  # type: ignore[attr-defined]
        assert any("654321" in note for note in ctx.report.notes)


# --- CUCBC (§7) -------------------------------------------------------------------------------


class TestCucbc:
    def test_bumps_dates_are_read_from_the_sentence(self) -> None:
        bumps = cucbc.parse_bumps(fixture("cucbc_bumps.html").decode())
        assert bumps == [
            cucbc.Bumps("Lent", 2027, date(2027, 3, 2), date(2027, 3, 6)),
            cucbc.Bumps("May", 2027, date(2027, 6, 16), date(2027, 6, 19)),
        ]
        draft = cucbc.bumps_draft(bumps[0])
        assert (draft.starts_at, draft.ends_at, draft.all_day) == (
            london(2027, 3, 2, 0, 0),
            london(2027, 3, 7, 0, 0),
            True,
        )

    def test_full_term_weeks_run_thursday_to_wednesday(self) -> None:
        start = date(2026, 10, 6)  # Michaelmas 2026 Full Term (§19)
        assert cucbc.week_day(start, 1, "Thursday") == date(2026, 10, 8)
        assert cucbc.week_day(start, 9, "Friday") == date(2026, 12, 4)
        assert cucbc.week_day(start, 7, "Sunday") == date(2026, 11, 22)
        assert cucbc.week_day(start, 0, "Monday") == date(2026, 10, 5)
        assert cucbc.spec_dates("3rd/4th Monday - 4th/5th Friday", start) is None
        # Lent 2026 (Full Term from Tue 20 Jan): the published Lent Bumps dates.
        assert cucbc.spec_dates("6th Tuesday - 7th Saturday", date(2026, 1, 20)) == (
            date(2026, 3, 3),
            date(2026, 3, 7),
        )

    def test_the_timetable_gives_tbc_inferred_dates_and_organisers(self) -> None:
        rows = cucbc.parse_timetable(fixture("cucbc_timetable.html").decode())
        assert ("lent", "Second Trinity Challenge Sculls", "8th Tuesday") in {
            (r.term, r.name, r.spec) for r in rows
        }
        drafts = {d.title: d for d in cucbc.timetable_drafts(rows) if "2026-27" in d.external_id}
        assert "University Fours" not in drafts  # alternatives: skipped
        fairbairns = drafts["Fairbairn Cup - Seniors (Jesus)"]
        assert fairbairns.starts_at == london(2026, 12, 4, 0, 0)
        assert (fairbairns.status, fairbairns.inferred) == ("tbc", {"startsAt", "endsAt"})
        assert fairbairns.organisers[0].identity.college_hint == "Jesus"
        assert drafts["Emmanuel Sprint Regatta"].starts_at == london(2026, 11, 22, 0, 0)
        assert drafts["Cardinals Regatta (St. Catharine's)"].organisers[0].identity.name == (
            "St Catharine's"
        )
        assert drafts["Second Trinity Challenge Sculls"].organisers == []
        sculls = drafts["Delafield / Colquhoun Sculls"]
        assert sculls.organisers[0].identity.name == "Cambridge University Combined Boat Clubs"

    def test_the_stage_reads_the_calendar_bumps_and_timetable(
        self, ctx: StageContext, net: respx.MockRouter
    ) -> None:
        base = "https://www.cucbc.org"
        allow(net, base, "User-agent: *\nCrawl-delay: 10\nDisallow: /admin/\n")
        empty = (
            b"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Drupal iCal API//EN\r\nEND:VCALENDAR\r\n"
        )
        net.get(url__regex=rf"{base}/calendar/ical/2026-(09|10|11|12)").respond(200, content=empty)
        net.get(f"{base}/bumps").respond(200, content=fixture("cucbc_bumps.html"))
        net.get(f"{base}/college_events/timetable").respond(
            200, content=fixture("cucbc_timetable.html")
        )

        cucbc.run(ctx, window=WINDOW, now=NOW)

        titles = {fields(e)["title"] for e in staged(ctx, "cucbc.events")}
        assert titles == {
            "Emmanuel Sprint Regatta",
            "Clare Novice Regatta",
            "Fairbairn Cup - Novices (Jesus)",
            "Fairbairn Cup - Seniors (Jesus)",
        }
        assert "calendar: 0 events in 4 months" in ctx.report.notes


# --- Playwaze (§9) --------------------------------------------------------------------------------


class TestPlaywaze:
    def test_league_links_and_season_roll_over(self) -> None:
        links = playwaze.parse_league_links(fixture("sport_leagues.html").decode())
        assert [(link.slug, link.season) for link in links] == [
            ("cambridge-university-netball-25-26", "25"),
            ("cambridge-university-hockey-26-27", "26"),
        ]
        assert links[1].url.startswith("https://cambridgeuniversityleagues.playwaze.com/")
        assert playwaze.current_season(date(2026, 10, 7)) == "26"
        assert playwaze.current_season(date(2027, 3, 1)) == "26"

    def test_fixtures_parse_into_matches(self) -> None:
        page = playwaze.parse_league_page(fixture("playwaze_league.html").decode())
        assert page.base_community_id == "abc123"
        assert (
            page.title == "Cambridge University Hockey 26-27 - College Hockey League - Michaelmas"
        )
        assert [d for d, _ in page.divisions] == [
            "LeagueDivisions/LeagueSeasons/1-B_1",
            "LeagueDivisions/LeagueSeasons/1-B_2",
        ]
        fixtures = playwaze.parse_fixtures(fixture("playwaze_fixtures.html").decode())
        assert [(f.id, f.home, f.away, f.kick_off) for f in fixtures] == [
            ("Fixtures/1-B", "Pembroke Mixed 1st", "Jesus Mixed 1st", datetime(1, 1, 1, 11).time()),
            ("Fixtures/2-B", "Trinity Mixed", "Fitzwilliam Mixed", None),
        ]
        timed, untimed = (playwaze.fixture_draft(f, league="L", division="D1") for f in fixtures)
        assert (timed.title, timed.event_type, timed.starts_at) == (
            "Pembroke Mixed 1st v Jesus Mixed 1st",
            "match",
            london(2026, 10, 18, 11, 0),
        )
        assert timed.venue is None and untimed.all_day
        assert untimed.venue.name == "Wilberforce Road Sports Ground, Cambridge"

    def test_the_stage_skips_last_season_and_posts_the_fixture_form(
        self, ctx: StageContext, net: respx.MockRouter
    ) -> None:
        allow(net, "https://www.sport.cam.ac.uk")
        allow(net, "https://cambridgeuniversityleagues.playwaze.com", "user-agent: *\nallow: /\n")
        net.get(playwaze.DISCOVERY_URL).respond(200, content=fixture("sport_leagues.html"))
        net.get(
            "https://cambridgeuniversityleagues.playwaze.com/cambridge-university-hockey-26-27"
            "/abc123/league-display/Leagues/def456"
        ).respond(200, content=fixture("playwaze_league.html"))
        fixtures = net.post(
            "https://cambridgeuniversityleagues.playwaze.com/cambridge-university-hockey-26-27"
            "/abc123/fixture-fixturelist"
        ).respond(200, content=fixture("playwaze_fixtures.html"))

        playwaze.run(ctx, window=WINDOW, now=NOW)

        events = staged(ctx, "playwaze.events")
        assert sorted(e.external_id for e in events) == ["Fixtures/1-B", "Fixtures/2-B"]
        assert fixtures.call_count == 2  # one per division, de-duplicated by fixture id
        body = fixtures.calls[0].request.content.decode()
        assert "request%5BBaseCommunityId%5D=abc123" in body
        assert any("netball-25-26" in note for note in ctx.report.notes)
        assert not any("public-" in str(c.request.url) for c in net.calls)


# --- University events (§10) ---------------------------------------------------------------------


class TestUniEvents:
    def test_only_events_naming_one_student_group_are_kept(self) -> None:
        index = OrganiserIndex()
        for key, name, org_type in (
            ("org-cu-chess-club", "CU Chess Club", "society"),
            ("org-cambridge-university-chess-club-juniors", "CU Chess Club Juniors", "society"),
            ("org-department-of-x", "Department of Physics", "department"),
        ):
            index.add(
                Observation(
                    source_type="su_directory",
                    source_key=key,
                    source_url="https://x.org",
                    retrieved_at=NOW,
                    entity_type="organisation",
                    identity=IdentityHints(name=name, org_type=org_type),
                    entity_key=key,
                )
            )
        names = uni_events.society_names(index)

        def event(title: str, organizer: str | None = None) -> IcsEvent:
            return IcsEvent(
                uid="u",
                external_id="u",
                title=title,
                starts_at=NOW,
                ends_at=None,
                all_day=False,
                organizer_name=organizer,
            )

        assert uni_events.match_society(event("Simul with the CU Chess Club"), names) == (
            "org-cu-chess-club"
        )
        assert uni_events.match_society(event("x", "CU Chess Club Juniors"), names) == (
            "org-cambridge-university-chess-club-juniors"
        )
        assert uni_events.match_society(event("Department of Physics open day"), names) is None
        assert uni_events.match_society(event("Chess for all"), names) is None

    def test_robots_txt_blocks_the_feed_and_nothing_is_fetched(
        self, ctx: StageContext, net: respx.MockRouter
    ) -> None:
        allow(net, "https://webservices.admin.cam.ac.uk", "User-agent: *\nDisallow: /\n")
        feed = net.get(url__startswith="https://webservices.admin.cam.ac.uk/events/").respond(200)

        uni_events.run(ctx, window=WINDOW, now=NOW)

        assert feed.call_count == 0
        assert any("disallowed_by_robots" in note for note in ctx.report.notes)
        assert staged(ctx, "uni_events_api.events") == []


# --- society calendar feeds (§11) ----------------------------------------------------------------


LUMA_ICS = b"""BEGIN:VCALENDAR\r
VERSION:2.0\r
PRODID:-//Luma//Test Society//EN\r
BEGIN:VEVENT\r
DTSTART:20261016T163000Z\r
DTEND:20261016T173000Z\r
ORGANIZER;CN="A Person":MAILTO:calendar-invite@lu.ma\r
UID:evt-1@events.lu.ma\r
SUMMARY:Journal Club\r
DESCRIPTION:Get up-to-date information at: https://luma.com/abc123\\n\\nAddress:\\nMer\r
 idian Cambridge\\nCambridge\\, United Kingdom\\n\\nHosted by A Person\r
LOCATION:Meridian Cambridge\\, 53 Sidney St\\, Cambridge CB2 3HX\\, UK\r
STATUS:TENTATIVE\r
END:VEVENT\r
END:VCALENDAR\r
"""


class TestCalendarFeeds:
    def test_feed_urls(self) -> None:
        assert calendar_feeds.feed_url("luma", "cal-X1") == (
            "https://api.lu.ma/ics/get?entity=calendar&id=cal-X1"
        )
        assert calendar_feeds.feed_url("google", "abc@group.calendar.google.com") == (
            "https://calendar.google.com/calendar/ical/abc%40group.calendar.google.com/public/basic.ics"
        )
        assert calendar_feeds.feed_url("ics", "webcal://soc.example/cal.ics") == (
            "https://soc.example/cal.ics"
        )
        assert calendar_feeds.feed_url("ics", "ftp://nope") is None

    def test_luma_boilerplate_is_removed_and_the_page_kept(self) -> None:
        page, text = calendar_feeds.clean_luma(
            "Get up-to-date information at: https://luma.com/abc\n\nAddress:\nSomewhere\n"
            "Cambridge\n\nHosted by A Person & B Person"
        )
        assert (page, text) == ("https://luma.com/abc", None)

    def test_the_stage_reads_seeded_and_staged_feeds(
        self, ctx: StageContext, net: respx.MockRouter, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from camsocs_pipeline.events.seeds import FeedSeed

        monkeypatch.setattr(
            calendar_feeds,
            "FEED_SEEDS",
            (FeedSeed("luma", "cal-1", IdentityHints(name="Test Society"), "https://x", "d"),),
        )
        org = Observation(
            source_type="society_website",
            source_key="k",
            source_url="https://soc.example/",
            retrieved_at=NOW,
            entity_type="organisation",
            identity=IdentityHints(name="Other Society"),
            entity_key="org-other-society",
            internal={"google_calendar_ids": ["abc@group.calendar.google.com"]},
        )
        ctx.staging.write("_resolved", "20261007T000000Z-aaaaaa", [org])
        allow(net, "https://api.lu.ma", "User-agent: *\nDisallow: /insights/\n")
        allow(net, "https://calendar.google.com", "User-agent: *\nAllow: /$\nDisallow: /\n")
        net.get(url__startswith="https://api.lu.ma/ics/get").respond(200, content=LUMA_ICS)

        calendar_feeds.run(ctx, window=WINDOW, now=NOW)

        (event,) = staged(ctx, "luma.events")
        values = fields(event)
        assert (event.event_source, event.external_id) == ("luma", "evt-1@events.lu.ma")
        assert values["sourceUrl"] == values["bookingUrl"] == "https://luma.com/abc123"
        assert values["status"] == "confirmed"  # Luma's blanket TENTATIVE is ignored
        assert "description" not in values  # boilerplate only
        assert "A Person" not in json.dumps(event.model_dump(mode="json"))
        assert [o.identity.name for o in event.unresolved_organisers] == ["Test Society"]
        assert any("google" in n and "disallowed_by_robots" in n for n in ctx.report.notes)


# --- SU What's On (§12) ---------------------------------------------------------------------


class TestSuWhatsOn:
    def test_the_listing_and_event_page_parse(self) -> None:
        items = su_whatson.parse_listing(fixture("su_whatson.html").decode())
        assert [(i.organisation, i.event_page is not None) for i in items] == [
            ("Cambridge SU", False),
            ("Test Society", True),
            ("Sabbatical Officers", True),
            ("Jugglers' Association", False),
        ]
        page = su_whatson.parse_event_page(fixture("su_event.html").decode())
        assert page.title == "Test Society Freshers Meet & Greet"
        assert (page.date_text, page.time_text) == ("Friday 09 October 2026", "6pm - 8:45pm")
        assert page.description.startswith("Come along for free pizza.")

    @pytest.mark.parametrize(
        ("date_text", "time_text", "expected"),
        [
            ("Friday 09 October 2026", "6pm - 8:45pm", ((9, 18, 0), (9, 20, 45), False)),
            ("Friday 09 October 2026", "18:00 - 20:00", ((9, 18, 0), (9, 20, 0), False)),
            ("Friday 09 October 2026", "6 - 8pm", ((9, 18, 0), (9, 20, 0), False)),
            ("Friday 09 October 2026", "10pm - 1am", ((9, 22, 0), (10, 1, 0), False)),
            ("Friday 09 October 2026", None, ((9, 0, 0), (10, 0, 0), True)),
        ],
    )
    def test_when(self, date_text, time_text, expected) -> None:
        start, end, all_day = su_whatson.parse_when(date_text, time_text)
        (d1, h1, m1), (d2, h2, m2), whole_day = expected
        assert (start, end, all_day) == (
            london(2026, 10, d1, h1, m1),
            london(2026, 10, d2, h2, m2),
            whole_day,
        )

    def test_the_stage_reads_student_group_events_only(
        self, ctx: StageContext, net: respx.MockRouter
    ) -> None:
        base = "https://www.cambridgesu.co.uk"
        allow(net, base, "User-agent: *\nDisallow: /asset/\nDisallow: /login/\n")
        net.get(f"{base}/whatson/").respond(200, content=fixture("su_whatson.html"))
        page = net.get(f"{base}/events/9999/1234/").respond(200, content=fixture("su_event.html"))
        officers = net.get(f"{base}/events/16989/2342/").respond(200)

        su_whatson.run(ctx, window=WINDOW, now=NOW)

        (event,) = staged(ctx, "su_whatson.events")
        values = fields(event)
        assert event.external_id == "events/9999/1234"
        assert values["startsAt"] == int(london(2026, 10, 9, 18, 0).timestamp() * 1000)
        assert values["sourceUrl"] == f"{base}/events/9999/1234/"
        assert event.unresolved_organisers[0].identity.su_id == "9999"
        missing = {f.field: f.missing_reason for f in event.fields if f.status == "missing"}
        assert missing.get("bookingUrl") == "not_published"  # "link in our bio"
        assert (page.call_count, officers.call_count) == (1, 0)
        assert not any("/asset/" in str(c.request.url) for c in net.calls)


def test_staged_events_load_as_claims_and_organiser_sets(tmp_path: Path) -> None:
    """The load plan for a staged event: identity claims, its organiser set
    (only resolved organisers), no unresolved hint and no confidence."""
    observation = EventObservation.model_validate(
        {
            "source_type": "talks_list",
            "source_key": "900001",
            "source_url": "https://talks.cam.ac.uk/show/xml/123456",
            "retrieved_at": NOW,
            "event_source": "talks_cam",
            "external_id": "900001",
            "visibility": "public",
            "organisers": [{"identity": {"name": "S", "known_key": "org-s"}, "role": "organiser"}],
            "unresolved_organisers": [{"identity": {"name": "T"}, "role": "co_host"}],
            "fields": [
                {
                    "field": "title",
                    "value": "Talk",
                    "method": "parser",
                    "evidence": "primary",
                    "extractor": "t",
                },
                {
                    "field": "startsAt",
                    "value": 1792000000000,
                    "method": "parser",
                    "evidence": "primary",
                    "extractor": "t",
                },
            ],
        }
    )
    plan = plan_observations([observation])
    assert {c.field for c in plan.claims} >= {
        "title",
        "startsAt",
        "source",
        "externalId",
        "visibility",
        "sourceUrl",
    }
    assert [(o.org_key, o.role) for o in plan.event_organisers[0].organisers] == [
        ("org-s", "organiser")
    ]
    assert all("confidence" not in c.to_wire() for c in plan.claims)
