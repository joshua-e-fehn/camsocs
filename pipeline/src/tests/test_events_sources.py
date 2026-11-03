"""Each event source on synthetic fixtures shaped like the live pages (checked
2026-10-07), parsers first, then the stage end to end against mocked hosts."""

from __future__ import annotations

import json
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest
import respx

from camsocs_pipeline.claims import parser_field
from camsocs_pipeline.events import (
    calendar_feeds,
    camdram,
    cucbc,
    playwaze,
    su_whatson,
    talks_cam,
    uni_events,
)
from camsocs_pipeline.events.checks import check_draft
from camsocs_pipeline.events.common import LONDON, default_window
from camsocs_pipeline.events.ics import IcsEvent
from camsocs_pipeline.models.observation import EventObservation, IdentityHints, Observation
from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.pipeline.load import ConvexLoader, plan_observations
from camsocs_pipeline.pipeline.report import RunReport
from camsocs_pipeline.pipeline.state import SyncState
from camsocs_pipeline.resolve.lookup import OrgLookup
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
        # What was staged is the stage's output, not "nothing to do".
        assert ctx.report.inserted == len(records) == 13
        assert str(ctx.report).startswith("test: 13 new")


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

    def test_the_stage_never_reaches_a_model(
        self,
        ctx: StageContext,
        net: respx.MockRouter,
        monkeypatch: pytest.MonkeyPatch,
        llm_tripwire: list[str],
    ) -> None:
        """Hard rule (AGENTS.md, source-research §6): talks.cam content never
        reaches a model. The stage runs end to end on the synthetic list, not
        as a dry run (a dry run skips the model on purpose), with every way to
        a model wired to fail the test (`llm_tripwire`)."""
        from camsocs_pipeline.events import seeds

        ctx.dry_run = False

        monkeypatch.setattr(
            talks_cam,
            "TALKS_SEEDS",
            (seeds.TalksSeed("123456", IdentityHints(name="Test Society"), "https://x", "d"),),
        )
        allow(net, "https://talks.cam.ac.uk")
        net.get(url__startswith="https://talks.cam.ac.uk/show/xml/123456").respond(
            200, content=fixture("talks_list.xml")
        )

        talks_cam.run(ctx, window=WINDOW, now=NOW)

        assert llm_tripwire == []
        assert [e.external_id for e in staged(ctx, "talks_list.events")] == ["900001", "900002"]


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
        communities = playwaze.parse_communities(fixture("sport_leagues.html").decode())
        assert [(c.slug, c.season) for c in communities] == [
            ("cambridge-university-netball-25-26", "25"),
            ("cambridge-university-hockey-26-27", "26"),
            ("cambridge-university-rugby-football-union-25-", "25"),
        ]
        tiles = (
            '<a href="/cambridge-university-hockey-26-27/abc123/league-display/Leagues/def456">'
            'Men</a><a href="/cambridge-university-hockey-26-27/abc123/league-display/Leagues/'
            'ghi789">Women</a>'
        )
        assert [
            league.league_id for league in playwaze.community_leagues(tiles, communities[1])
        ] == [
            "def456",
            "ghi789",
        ]

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
        # The community's tiles page lists a second league Sport Cambridge
        # does not link (its page is gone here).
        hockey = "https://cambridgeuniversityleagues.playwaze.com/cambridge-university-hockey-26-27"
        net.get(f"{hockey}/abc123/PublicTiles").respond(
            200,
            text=(
                '<a href="/cambridge-university-hockey-26-27/abc123/league-display/Leagues/'
                'def456">Men</a><a href="/cambridge-university-hockey-26-27/abc123/'
                'league-display/Leagues/ghi789">Women</a>'
            ),
        )
        second = net.get(f"{hockey}/abc123/league-display/Leagues/ghi789").respond(404)
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
        assert any("rugby-football-union-25-" in note for note in ctx.report.notes)
        assert second.call_count == 1
        assert not any("public-" in str(c.request.url) for c in net.calls)


# --- University events (§10): synthetic fixtures shaped like the live API (2026-11-02) ----------

UNI_HOST = "https://webservices.admin.cam.ac.uk"
UNI_API = f"{UNI_HOST}/events/api"
WHATSON_PAGE = "http://www.admin.cam.ac.uk/whatson/detail.shtml?uid="


def _programme(ident: str, title: str, published: bool = True) -> dict:
    return {
        "@id": ident,
        "@publicationState": "PUBLISHED" if published else "UNPUBLISHED",
        "title": title,
        "description": "A programme.",
        "primaryContact": {"name": "Staff Person", "emailAddress": "staff.person@example.invalid"},
        "accountEnquiriesEmail": "staff.person@example.invalid",
        "useOrganiser": False,
    }


UNI_PROGRAMMES = {
    "results": {
        "totalResults": 5,
        "returnedResults": 5,
        "list": [
            _programme("11", "What's On"),
            _programme("700", "Cambridge Festival 2026"),
            _programme("710", "Schools Days 2026"),
            _programme("720", "Open Cambridge 2026", published=False),
            _programme("730", "Open Cambridge 2025"),
        ],
    }
}


def _entry(uuid: str, title: str, day: str, start: str = "", end: str = "", **extra) -> dict:
    entry = {
        "@programmeId": "11",
        "title": title,
        "eventUid": uuid,
        "url": f"{WHATSON_PAGE}{uuid}",
        "eventId": 1000,
        "startDate": day,
        "startTime": start,
        "endDate": day,
        "endTime": end,
        "vagueTiming": "NOT_VAGUE",
        "earliestStartDate": day,
        "latestStartDate": day,
        "shortDescription": f"About {title}.",
        "cancelled": False,
        "lastModified": "2026-09-01T10:00:00.000+01:00",
        "venue": "West Hall",
        "roomDetails": "",
        "cost": "Free",
    }
    entry.update(extra)
    return entry


_CONCERT = "aaaa1111-0000-4000-8000-000000000001"
_TALK = "bbbb2222-0000-4000-8000-000000000002"
_SHOW = "cccc3333-0000-4000-8000-000000000003"
_CLASS = "dddd4444-0000-4000-8000-000000000004"
_RECORDING = "eeee5555-0000-4000-8000-000000000005"
_GARDEN = "ffff6666-0000-4000-8000-000000000006"

UNI_CALENDAR = {
    "results": {
        "resultSetSize": 20000,
        "totalResults": 33,
        "returnedResults": 33,
        "list": [
            _entry(
                _CONCERT,
                "Autumn Serenades with the CU Quokka Orchestra",
                "14/10/2026",
                "19:30:00",
                "21:30:00",
                cost="£8 (£5 concessions)",
                imageUrl="/events/uploadedImages/ab/image_1001_g1_tiny.jpg",
            ),
            _entry(
                _TALK,
                "The Physics of Puddles",
                "20/10/2026",
                "17:00:00",
                "18:00:00",
                venue="Department of Imaginary Physics",
                roomDetails="Lecture Theatre 2",
            ),
            *[
                _entry(
                    _SHOW,
                    "Maps of Nowhere",
                    f"{day:02d}/10/2026",
                    "10:00:00",
                    "17:00:00",
                    earliestStartDate="15/09/2026",
                    latestStartDate="30/11/2026",
                    venue="Museum of Invented Places",
                )
                for day in range(1, 21)
            ],
            *[
                _entry(_CLASS, "Life Drawing for Beginners", day, "18:00:00", "20:00:00")
                for day in ("08/10/2026", "15/10/2026", "22/10/2026", "29/10/2026", "05/11/2026")
            ],
            _entry(_RECORDING, "Recorded lecture: Moss", "10/10/2026", venue=""),
            _entry(
                _GARDEN,
                "Garden open evening",
                "25/10/2026",
                "18:00:00",
                "20:00:00",
                cancelled=True,
                shortDescription="An evening in a garden.",
            ),
        ],
    }
}

UNI_ICS = b"""BEGIN:VCALENDAR\r
VERSION:2.0\r
PRODID:-//Example//Events//EN\r
BEGIN:VEVENT\r
UID:aaaa1111-0000-4000-8000-000000000001:2026-10-14{19:30:00.000:PT7200S}\r
DTSTAMP:20261007T120000Z\r
DTSTART:20261014T193000\r
DTEND:20261014T213000\r
SUMMARY:Autumn Serenades with the CU Quokka Orchestra\r
CATEGORIES:Music,All Ages,In person\r
DESCRIPTION:An evening of invented serenades.\r
LOCATION:West Hall \r
STATUS:CONFIRMED\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:bbbb2222-0000-4000-8000-000000000002:2026-10-20{17:00:00.000:PT3600S}\r
DTSTAMP:20261007T120000Z\r
DTSTART:20261020T170000\r
DTEND:20261020T180000\r
SUMMARY:The Physics of Puddles\r
CATEGORIES:Talks,Adults,In person,Step-free access\r
DESCRIPTION:A long description of puddles\\, their depth and their surprisi\r
 ng physics.\r
LOCATION:Department of Imaginary Physics\r
STATUS:CONFIRMED\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:cccc3333-0000-4000-8000-000000000003:2026-09-15{10:00:00.000:PT25200S}\r
DTSTAMP:20261007T120000Z\r
DTSTART:20260915T100000\r
DTEND:20260915T170000\r
RRULE:FREQ=WEEKLY;BYDAY=TU,WE,TH,FR,SA;UNTIL=20261130T235959Z\r
SUMMARY:Maps of Nowhere\r
CATEGORIES:Exhibitions,All Ages,In person\r
DESCRIPTION:Maps of places that never were.\r
STATUS:CONFIRMED\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:cccc3333-0000-4000-8000-000000000003:2026-09-20{12:00:00.000:PT14400S}\r
DTSTAMP:20261007T120000Z\r
DTSTART:20260920T120000\r
DTEND:20260920T160000\r
RRULE:FREQ=WEEKLY;BYDAY=SU;UNTIL=20261130T235959Z\r
RELATED-TO;RELTYPE=SIBLING:cccc3333-0000-4000-8000-000000000003\r
SUMMARY:Maps of Nowhere\r
CATEGORIES:Exhibitions,Families\r
DESCRIPTION:Sunday hours.\r
STATUS:CONFIRMED\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:dddd4444-0000-4000-8000-000000000004:2026-10-08{18:00:00.000:PT7200S}\r
DTSTAMP:20261007T120000Z\r
DTSTART:20261008T180000\r
DTEND:20261008T200000\r
RRULE:FREQ=WEEKLY;COUNT=5\r
SUMMARY:Life Drawing for Beginners\r
CATEGORIES:Courses/Workshops,Adults,In person\r
DESCRIPTION:Bring a pencil.\r
STATUS:CONFIRMED\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:eeee5555-0000-4000-8000-000000000005:2026-10-10{null}\r
DTSTAMP:20261007T120000Z\r
DTSTART;VALUE=DATE:20261010\r
SUMMARY:Recorded lecture: Moss\r
CATEGORIES:Available on Demand,Talks\r
DESCRIPTION:A recording.\r
STATUS:CONFIRMED\r
END:VEVENT\r
END:VCALENDAR\r
"""


# --- University events (§10) ---------------------------------------------------------------------


class TestUniEvents:
    def test_only_events_naming_one_student_group_are_kept(self) -> None:
        index = OrgLookup()
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

    def test_a_cu_name_or_a_distinctive_alias_credits_its_group(self) -> None:
        """ENG-36: the programme names a group as "CU …", "Cambridge
        University …" or by an alias, not always by its listing's name."""
        index = OrgLookup()
        for key, name, aliases, short, org_type in (
            (
                "org-jazz",
                "Cambridge University Jazz Orchestra",
                ["CU Jazz Orchestra"],
                "CUJO",
                "society",
            ),
            (
                "org-gilbert",
                "The Quokka Players",
                ["Cambridge Gilbert and Sullivan Society"],
                "CUGSS",
                "theatre_company",
            ),
            ("org-german", "German Society", ["German Soc"], None, "society"),
            ("org-french", "French Society", [], None, "society"),
            ("org-cu-society", "Cambridge University Society", [], None, "society"),
            ("org-museums", "University of Cambridge Museums", [], None, "uni_office"),
        ):
            fields = [parser_field("name", name, extractor="t", evidence="primary")]
            fields.append(parser_field("aliases", aliases, extractor="t", evidence="primary"))
            if short:
                fields.append(parser_field("shortName", short, extractor="t", evidence="primary"))
            index.add(
                Observation(
                    source_type="su_directory",
                    source_key=key,
                    source_url="https://x.org",
                    retrieved_at=NOW,
                    entity_type="organisation",
                    identity=IdentityHints(name=name, org_type=org_type),
                    entity_key=key,
                    fields=fields,
                )
            )
        names = uni_events.society_names(index)

        def credited(title: str, organizer: str | None = None) -> str | None:
            event = IcsEvent(
                uid="u",
                external_id="u",
                title=title,
                starts_at=NOW,
                ends_at=None,
                all_day=False,
                organizer_name=organizer,
            )
            return uni_events.match_society(event, names)

        # The group's own words after any of the University's names.
        assert credited("Big band night | CU Jazz Orchestra") == "org-jazz"
        assert credited("x", "University of Cambridge  Jazz Orchestra") == "org-jazz"
        assert credited("Sonic Tapestries", "Cambridge University Jazz Orchestra") == "org-jazz"
        # A distinctive alias, and the CU form of a name without it.
        assert credited("The Cambridge Gilbert and Sullivan Society: Iolanthe") == "org-gilbert"
        assert credited("CU German Society film night") == "org-german"
        # Whole words only; never an acronym or a two-word alias.
        assert credited("Jazz Orchestras of the world") is None
        assert credited("CUJO plays Ellington") is None
        assert credited("German Soc pub night") is None
        # The University itself, alone or with a word every group shares, is
        # nobody's; nor is a University office.
        assert credited("University of Cambridge Museums late") is None
        assert credited("Cambridge University Society lecture") is None
        assert credited("A Cambridge University open day") is None
        # Two groups named side by side are no single organiser.
        assert credited("German Society and French Society joint social") is None
        # The programme's organiser is read before the title.
        assert credited("CU Jazz Orchestra", "German Society") == "org-german"

    def test_a_university_name_pattern_needs_the_groups_own_words(self) -> None:
        assert uni_events.name_pattern("University of Cambridge") is None
        assert uni_events.name_pattern("Cambridge University") is None
        assert uni_events.name_pattern("CU Soc") is None
        assert uni_events.name_pattern("CU Ski") is None  # too short to be distinctive
        pattern = uni_events.name_pattern("CU Chess Club")
        assert pattern is not None and pattern.search("Cambridge University Chess Club")
        assert uni_events.name_pattern("Chess Club", alias=True) is None
        assert uni_events.name_pattern("Chess Club") is not None

    def test_the_stage_lists_every_public_university_event(
        self, ctx: StageContext, net: respx.MockRouter
    ) -> None:
        society = Observation(
            source_type="su_directory",
            source_key="org-cu-quokka-orchestra",
            source_url="https://x.org",
            retrieved_at=NOW,
            entity_type="organisation",
            identity=IdentityHints(name="CU Quokka Orchestra", org_type="society"),
            entity_key="org-cu-quokka-orchestra",
        )
        ctx.staging.write("_resolved", "20261007T000000Z-aaaaaa", [society])
        # robots.txt shuts everyone out; the recorded permission (D3a) lets
        # the events API and its images be read, nothing else.
        allow(net, UNI_HOST, "User-agent: *\nDisallow: /\n")
        listing = net.get(f"{UNI_API}/programmes.json").respond(200, json=UNI_PROGRAMMES)
        whats_on = net.get(uni_events.calendar_url("11", "json")).respond(200, json=UNI_CALENDAR)
        details = net.get(uni_events.calendar_url("11", "ics")).respond(200, content=UNI_ICS)
        festival = net.get(uni_events.calendar_url("700", "json")).respond(
            200, json={"results": {"totalResults": 0, "returnedResults": 0}}
        )
        festival_ics = net.get(uni_events.calendar_url("700", "ics")).respond(200)
        poster = net.get(f"{UNI_HOST}/events/uploadedImages/ab/image_1001_g1_very_large.jpg")
        poster.respond(200, content=PNG)
        other = net.get(url__regex=r"/events/api/programmes/(710|720|730)/").respond(200)

        uni_events.run(ctx, window=WINDOW, now=NOW)

        events = {e.external_id: e for e in staged(ctx, "uni_events_api.events")}
        concert = events["aaaa1111-0000-4000-8000-000000000001/20261014T183000Z"]
        talk = events["bbbb2222-0000-4000-8000-000000000002/20261020T160000Z"]
        run = events["cccc3333-0000-4000-8000-000000000003/run"]
        classes = [k for k in events if k.startswith("dddd4444-")]
        evening = events["ffff6666-0000-4000-8000-000000000006/20261025T180000Z"]
        assert len(events) == 9 and len(classes) == 5  # a weekly class is not folded
        assert not any(k.startswith("eeee5555-") for k in events)  # on demand only

        # A society named in the title is the organiser, second-hand.
        assert [o.identity.known_key for o in concert.organisers] == ["org-cu-quokka-orchestra"]
        assert {f.evidence for f in concert.fields} == {"secondary"}
        values = fields(concert)
        assert values["price"] == {
            "free": False,
            "text": "£8 (£5 concessions)",
            "minPence": 500,
            "maxPence": 800,
        }
        assert values["image"] == {"sourceUrl": str(poster.calls[0].request.url)}
        assert values["sourceUrl"] == f"{WHATSON_PAGE}aaaa1111-0000-4000-8000-000000000001"
        assert values["eventType"] == "performance"
        # Every other event is the University's: no organiser, primary.
        assert talk.organisers == [] and talk.unresolved_organisers == []
        assert {f.evidence for f in talk.fields} == {"primary"}
        values = fields(talk)
        assert values["eventType"] == "talk"
        assert not any(f.field == "eventType" and f.status == "inferred" for f in talk.fields)
        assert values["price"] == {"free": True, "text": "Free"}
        assert values["description"].startswith("A long description of puddles")
        assert talk.venue is not None
        assert talk.venue.name == "Department of Imaginary Physics (Lecture Theatre 2)"
        # A daily exhibition is one all-day run over its whole series.
        values = fields(run)
        assert values["allDay"] is True and values["eventType"] == "exhibition"
        assert values["startsAt"] == int(london(2026, 9, 15).timestamp() * 1000)
        assert values["endsAt"] == int(london(2026, 12, 1).timestamp() * 1000)
        # No categories (nothing in the iCalendar export): a guessed type, the
        # short description, and the occurrence's own cancellation.
        values = fields(evening)
        assert values["cancelled"] is True and values["eventType"] == "other"
        assert any(f.field == "eventType" and f.status == "inferred" for f in evening.fields)
        assert values["description"] == "An evening in a garden."

        notes = " | ".join(ctx.report.notes)
        assert "What's On, Cambridge Festival 2026" in notes
        assert "20 occurrences folded into 1 runs" in notes
        assert "on demand, not a dated event" in notes
        for event in events.values():
            assert event.fetch is not None
            assert event.fetch.robots_verdict == "disallowed"
            assert (event.fetch.access_note or "").split("; ") == [
                "robots_override:permission",
                "ai_optout_override:permission",
            ]
            assert event.source_url == uni_events.calendar_url("11", "json")
        # Few requests: the list, What's On's two, the festival's empty
        # calendar (so not its export), one image; no other programme.
        assert (listing.call_count, whats_on.call_count, details.call_count) == (1, 1, 1)
        assert (festival.call_count, festival_ics.call_count, other.call_count) == (1, 0, 0)
        assert poster.call_count == 1
        assert not any("_tiny" in str(c.request.url) for c in net.calls)
        # Staff contacts are never kept: not in staging, not in the raw cache.
        everything = [p.read_bytes() for p in ctx.settings.cache_dir.rglob("*") if p.is_file()]
        everything += [p.read_bytes() for p in ctx.staging.root.rglob("*") if p.is_file()]
        assert not any(b"staff.person" in blob for blob in everything)

    def test_a_programme_whose_export_fails_is_skipped(
        self, ctx: StageContext, net: respx.MockRouter
    ) -> None:
        allow(net, UNI_HOST, "User-agent: *\nDisallow: /\n")
        net.get(f"{UNI_API}/programmes.json").respond(
            200, json={"results": {"list": [_programme("11", "What's On")]}}
        )
        net.get(uni_events.calendar_url("11", "json")).respond(200, json=UNI_CALENDAR)
        export = net.get(uni_events.calendar_url("11", "ics")).respond(500)

        uni_events.run(ctx, window=WINDOW, now=NOW)

        # Read without its categories, every event would change type,
        # description and folding, and change back the next day.
        assert export.call_count >= 1
        assert staged(ctx, "uni_events_api.events") == []
        assert any("What's On: skipped, iCalendar export" in n for n in ctx.report.notes)

    def test_a_folded_series_stays_folded_as_its_days_pass(
        self, ctx: StageContext, net: respx.MockRouter
    ) -> None:
        # Six daily talks, 10-15 October: five or more in the calendar fold
        # them; three days later four are left, and the run must not come
        # apart into single talks beside the run already posted.
        series = "abab7777-0000-4000-8000-000000000007"
        days = [f"{day:02d}/10/2026" for day in range(10, 16)]
        export = (
            "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Example//Events//EN\r\n"
            f"BEGIN:VEVENT\r\nUID:{series}:2026-10-10{{13:00:00.000:PT3600S}}\r\n"
            "DTSTAMP:20261007T120000Z\r\nDTSTART:20261010T130000\r\n"
            "SUMMARY:Lunchtime Talks on Imaginary Birds\r\nCATEGORIES:Talks,Adults\r\n"
            "END:VEVENT\r\nEND:VCALENDAR\r\n"
        ).encode()
        allow(net, UNI_HOST, "User-agent: *\nDisallow: /\n")
        net.get(f"{UNI_API}/programmes.json").respond(
            200, json={"results": {"list": [_programme("11", "What's On")]}}
        )
        net.get(uni_events.calendar_url("11", "ics")).respond(200, content=export)
        calendar = net.get(uni_events.calendar_url("11", "json"))

        def listing(listed: list[str]) -> dict:
            entries = [
                _entry(
                    series,
                    "Lunchtime Talks on Imaginary Birds",
                    day,
                    "13:00:00",
                    "14:00:00",
                    earliestStartDate=days[0],
                    latestStartDate=days[-1],
                )
                for day in listed
            ]
            return {"results": {"totalResults": len(entries), "list": entries}}

        seen: list[set[str]] = []
        for today, listed in (
            (datetime(2026, 10, 9, 5, tzinfo=UTC), days),
            (datetime(2026, 10, 12, 5, tzinfo=UTC), days[2:]),
        ):
            ctx.run.run_key = f"{today:%Y%m%dT%H%M%SZ}-abcdef"
            calendar.respond(200, json=listing(listed))
            # By its count alone, the series folds on the first day only.
            occurrences = uni_events.read_calendar(json.dumps(listing(listed)).encode())
            folds = uni_events.should_fold(occurrences.occurrences, ["Talks"])
            assert folds == (len(listed) >= uni_events.FOLD_MIN_OCCURRENCES)
            uni_events.run(ctx, window=default_window(today), now=today)
            seen.append({e.external_id for e in staged(ctx, "uni_events_api.events")})

        assert seen == [{f"{series}/run"}, {f"{series}/run"}]

    def test_a_series_older_than_a_year_starts_on_a_stable_day(self) -> None:
        today = date(2026, 11, 2)
        now = datetime(2026, 11, 2, 23, 0, tzinfo=UTC)
        horizon = date(2027, 2, 1)

        def run_of(first: str, last: str | None, listed: list[date]) -> object:
            every = [
                uni_events.Occurrence(
                    uuid="u",
                    title="A permanent display of invented maps",
                    starts_at=london(day.year, day.month, day.day, 10),
                    ends_at=None,
                    all_day=False,
                    series_first=datetime.strptime(first, "%Y-%m-%d").date(),
                    series_last=datetime.strptime(last, "%Y-%m-%d").date() if last else None,
                )
                for day in listed
            ]
            draft = uni_events.event_draft(every[0], None)
            return uni_events.fold_runs(every, every, draft, now=now, horizon=horizon)

        daily = [date(2026, 11, 2) + timedelta(days=n) for n in range(92)]
        # Open since 2021, no last day: the start is the first of the month
        # 11 months back, the end the last day of the last listed month, both
        # inferred, and unchanged as the listed days pass.
        old = run_of("2021-01-01", None, daily)
        assert old.starts_at == london(2025, 12, 1)
        assert old.ends_at == london(2027, 3, 1)
        assert {"startsAt", "endsAt"} <= old.inferred
        later = run_of("2021-01-01", None, daily[20:])
        assert (later.starts_at, later.ends_at) == (old.starts_at, old.ends_at)
        assert check_draft(old, default_window(now), now=now).keep
        # At the edge of the reach the run is anchored, never dropped as an
        # impossible date; a day inside it keeps its own first day.
        edge = run_of(str(today - timedelta(days=365)), None, daily)
        assert edge.starts_at == london(2025, 12, 1)
        assert check_draft(edge, default_window(now), now=now).keep
        inside = run_of(str(today - timedelta(days=364)), "2027-01-15", daily[:75])
        assert inside.starts_at == london(2025, 11, 3) and "startsAt" not in inside.inferred
        assert inside.ends_at == london(2027, 1, 16) and "endsAt" not in inside.inferred
        assert check_draft(inside, default_window(now), now=now).keep
        # A series that visibly ends inside the calendar ends with its last
        # occurrence, even without a last day.
        short = run_of("2026-10-30", None, daily[:6])
        assert short.ends_at == london(2026, 11, 8) and "endsAt" in short.inferred

    def test_programmes_are_whats_on_and_this_years_festivals(self) -> None:
        programmes = uni_events.read_programmes(json.dumps(UNI_PROGRAMMES).encode())
        chosen = uni_events.select_programmes(programmes, WINDOW)
        assert [p.title for p in chosen] == ["What's On", "Cambridge Festival 2026"]
        spring = default_window(datetime(2027, 2, 1, tzinfo=UTC))
        assert [p.id for p in uni_events.select_programmes(programmes, spring)] == ["11"]
        assert not any(hasattr(p, "primaryContact") for p in programmes)

    def test_cost_texts_become_prices(self) -> None:
        assert uni_events.price_from("FREE, booking recommended") == {
            "free": True,
            "text": "FREE, booking recommended",
        }
        assert uni_events.price_from("£25 per person")["minPence"] == 2500  # type: ignore[index]
        assert uni_events.price_from("Free for members, £3.50 others") == {
            "free": False,
            "text": "Free for members, £3.50 others",
            "minPence": 350,
            "maxPence": 350,
        }
        assert uni_events.price_from("n/a") is None
        assert uni_events.price_from(None) is None

    def test_images_are_read_at_their_largest_derived_size(self) -> None:
        tiny = "/events/uploadedImages/8b/image_1_0f0f_tiny.jpg"
        assert uni_events.image_url(tiny) == (
            f"{UNI_HOST}/events/uploadedImages/8b/image_1_0f0f_very_large.jpg"
        )
        assert uni_events.image_url("https://elsewhere.example/x_tiny.jpg") is None
        assert uni_events.image_url("/events/doc/x_tiny.jpg") is None

    def test_the_export_adds_categories_and_descriptions_by_uuid(self) -> None:
        details = uni_events.read_details(UNI_ICS)
        exhibition = details["cccc3333-0000-4000-8000-000000000003"]
        # Siblings (the Sunday hours) add their categories.
        assert exhibition.categories == ["Exhibitions", "All Ages", "In person", "Families"]
        assert uni_events.event_type_of(exhibition.categories) == "exhibition"
        assert uni_events.event_type_of(["Courses/Workshops", "Adults"]) == "workshop"
        assert uni_events.event_type_of(["Adults", "In person"]) is None
        assert uni_events.on_demand_only(["Available on Demand", "Talks"], None)
        assert not uni_events.on_demand_only(["Available on Demand", "In person"], None)


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


GOOGLE_ICS = b"""BEGIN:VCALENDAR\r
VERSION:2.0\r
PRODID:-//Google Inc//Google Calendar 70.9054//EN\r
X-WR-TIMEZONE:Europe/London\r
BEGIN:VEVENT\r
DTSTART:20261020T180000Z\r
DTEND:20261020T200000Z\r
UID:g-1@google.com\r
SUMMARY:Committee-free social\r
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
        google = net.get(
            "https://calendar.google.com/calendar/ical/abc%40group.calendar.google.com/public/basic.ics"
        ).respond(200, content=GOOGLE_ICS)

        calendar_feeds.run(ctx, window=WINDOW, now=NOW)

        (event,) = staged(ctx, "luma.events")
        values = fields(event)
        assert (event.event_source, event.external_id) == ("luma", "evt-1@events.lu.ma")
        assert values["sourceUrl"] == values["bookingUrl"] == "https://luma.com/abc123"
        assert values["status"] == "confirmed"  # Luma's blanket TENTATIVE is ignored
        assert "description" not in values  # boilerplate only
        assert "A Person" not in json.dumps(event.model_dump(mode="json"))
        assert [o.identity.name for o in event.unresolved_organisers] == ["Test Society"]
        # D3: calendar.google.com disallows crawlers, but a public ICS feed a
        # society links is read under the society override, which the event's
        # `sources` row records next to the honest "disallowed" verdict.
        assert google.call_count == 1
        (from_google,) = staged(ctx, "ics_feed.events")
        assert fields(from_google)["title"] == "Committee-free social"
        assert from_google.fetch.robots_verdict == "disallowed"
        assert from_google.fetch.access_note == "robots_override:society"
        assert [o.identity.known_key for o in from_google.organisers] == ["org-other-society"]

    def test_other_pages_on_google_calendar_keep_their_robots_txt(
        self, ctx: StageContext, net: respx.MockRouter, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(calendar_feeds, "FEED_SEEDS", ())
        org = Observation(
            source_type="society_website",
            source_key="k",
            source_url="https://soc.example/",
            retrieved_at=NOW,
            entity_type="organisation",
            identity=IdentityHints(name="Other Society"),
            entity_key="org-other-society",
            internal={"ics_urls": ["https://calendar.google.com/calendar/embed?src=abc"]},
        )
        ctx.staging.write("_resolved", "20261007T000000Z-aaaaaa", [org])
        allow(net, "https://calendar.google.com", "User-agent: *\nAllow: /$\nDisallow: /\n")
        embed = net.get(url__startswith="https://calendar.google.com/calendar/embed")

        calendar_feeds.run(ctx, window=WINDOW, now=NOW)

        assert embed.call_count == 0
        assert any("disallowed_by_robots" in n for n in ctx.report.notes)

    def test_the_university_programme_is_never_read_as_a_society_feed(
        self, ctx: StageContext, net: respx.MockRouter, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The recorded permission (D3a) is the uni_events stage's: a society
        # website or SU profile that links What's On's subscribe link, in
        # either form, does not make it that society's feed.
        monkeypatch.setattr(calendar_feeds, "FEED_SEEDS", ())
        feed = uni_events.calendar_url("11", "ics").split("?")[0]
        orgs = [
            Observation(
                source_type=source_type,
                source_key=key,
                source_url="https://soc.example/",
                retrieved_at=NOW,
                entity_type="organisation",
                identity=IdentityHints(name=key),
                entity_key=f"org-{key}",
                internal={"ics_urls": [link]},
            )
            for source_type, key, link in (
                ("society_website", "website-society", feed),
                ("su_profile", "profile-society", feed.replace("https://", "webcal://")),
            )
        ]
        ctx.staging.write("_resolved", "20261007T000000Z-aaaaaa", orgs)
        allow(net, UNI_HOST, "User-agent: *\nDisallow: /\n")
        programme = net.get(url__startswith=f"{UNI_API}/").respond(200, content=UNI_ICS)

        assert calendar_feeds.collect_feeds(OrgLookup.for_stage(ctx)) == []
        calendar_feeds.run(ctx, window=WINDOW, now=NOW)

        assert programme.call_count == 0
        assert not any(str(c.request.url).startswith(UNI_HOST) for c in net.calls)
        assert staged(ctx, "ics_feed.events") == []
        assert any("1 linked feeds not read" in n for n in ctx.report.notes)


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
            # The start borrows the end's pm only if it then starts before the end.
            ("Friday 09 October 2026", "11 - 1pm", ((9, 11, 0), (9, 13, 0), False)),
            ("Friday 09 October 2026", "10 - 12pm", ((9, 10, 0), (9, 12, 0), False)),
            ("Friday 09 October 2026", "12 - 2pm", ((9, 12, 0), (9, 14, 0), False)),
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
