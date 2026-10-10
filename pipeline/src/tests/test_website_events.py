"""Society websites' events pages (source-research §14 "Events pages"): page
discovery, structured data, the model's reading with dated-quote checks, the
upcoming-only filter and the stage — offline (respx, fake LLM)."""

from __future__ import annotations

import json
from datetime import UTC, date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest
import respx

from camsocs_pipeline.extract import dating
from camsocs_pipeline.extract.events import LlmEvent
from camsocs_pipeline.extract.when import TermCalendar
from camsocs_pipeline.models.observation import EventObservation, IdentityHints, Observation
from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.pipeline.load import ConvexLoader
from camsocs_pipeline.pipeline.report import RunReport
from camsocs_pipeline.pipeline.state import SyncState
from camsocs_pipeline.sources.base import HostGates, PoliteClient
from camsocs_pipeline.sources.policy import ROBOTS_OVERRIDE_NOTE
from camsocs_pipeline.sources.websites import events as website
from camsocs_pipeline.sources.websites.page import parse_page
from camsocs_pipeline.staging.store import StagingStore
from tests.fakes import FakeLLM

LONDON = ZoneInfo("Europe/London")
NOW = datetime(2026, 10, 9, 12, 0, tzinfo=UTC)
TODAY = date(2026, 10, 9)
SITE = "https://quokkas.example.org"
KEY = "org-cambridge-university-quokka-appreciation-society"
QUOKKAS = website.Site(KEY, "Cambridge University Quokka Appreciation Society", f"{SITE}/")


def ms(*parts: int) -> int:
    return int(datetime(*parts, tzinfo=LONDON).timestamp() * 1000)


HOME = """<html><head><title>CU Quokka Appreciation Society</title></head><body>
<nav><a href="/">Home</a> <a href="/about">About</a> <a href="/events/">Events</a>
<a href="/past-events/">Past events</a> <a href="/2024/03/term-card/">Term card 2024</a>
<a href="https://other.example.org/events">Their events</a></nav>
<main><h1>Welcome to the Quokka Appreciation Society</h1>
<p>We meet to appreciate quokkas. Everyone is welcome, no experience needed.</p></main>
</body></html>"""

EVENTS_PAGE = """<html><head><title>Events - Quokka Society</title></head><body><main>
<h1>Michaelmas 2026 events</h1>
<h2>Quokka Quiz</h2><p>Thursday 15 October, 7:30pm, The Old Library. Free for members.</p>
<h2>Welcome Picnic</h2><p>Saturday 3 October on Jesus Green. What a day it was!</p>
<h2>Quokka film night</h2><p>Coming soon, date to be announced.</p>
<h2>Summer garden party</h2><p>20 July 2027 in the Fellows' Garden.</p>
<h2>Burrow building</h2><p>Week 5 Wednesday, 2pm.</p>
<p>Contact our secretary at secretary@quokkas.example.org.</p>
</main></body></html>"""

REPLY = {
    "society_name": "Quokka Society",
    "term": "michaelmas",
    "term_year": 2026,
    "events": [
        {
            "title": "Quokka Quiz",
            "date": "2026-10-15",
            "start_time": "19:30",
            "when_quote": "Thursday 15 October, 7:30pm",
            "venue": "The Old Library",
            "event_type": "social",
        },
        {
            "title": "Welcome Picnic",
            "date": "2026-10-03",
            "when_quote": "Saturday 3 October",
        },
        {"title": "Quokka film night", "date": "2026-10-20", "when_quote": "Coming soon"},
        {"title": "Summer garden party", "date": "2027-07-20", "when_quote": "20 July 2027"},
        {
            "title": "Burrow building",
            "term_week": 5,
            "weekday": "wednesday",
            "start_time": "14:00",
            "when_quote": "Week 5 Wednesday, 2pm",
        },
    ],
}


def client(tmp_path: Path) -> PoliteClient:
    return PoliteClient(
        user_agent="camsocs-test/0.1",
        cache_dir=tmp_path / "cache",
        min_interval=0,
        gates=HostGates(),
        sleep=lambda _s: None,
        now=lambda: NOW,
    )


def serve(net: respx.MockRouter, robots: str = "User-agent: *\nAllow: /\n") -> None:
    net.get(f"{SITE}/robots.txt").respond(200, text=robots)
    net.get(f"{SITE}/").respond(200, text=HOME, headers={"content-type": "text/html"})
    net.get(f"{SITE}/events").respond(
        200, text=EVENTS_PAGE, headers={"content-type": "text/html; charset=utf-8"}
    )


def values(event: EventObservation) -> dict:
    return {f.field: f.value for f in event.fields if f.value is not None}


# --- discovery ----------------------------------------------------------------------------


def test_events_pages_are_inside_the_site_current_and_few() -> None:
    home = parse_page(f"{SITE}/", HOME)
    assert website.event_pages(home, today=TODAY) == [f"{SITE}/events"]
    assert not website.home_lists_events(home)
    listing = parse_page(f"{SITE}/", "<main><h2>Upcoming events</h2><p>Quiz.</p></main>")
    assert website.home_lists_events(listing)
    nofollow = parse_page(
        f"{SITE}/", HOME.replace("<head>", '<head><meta name="robots" content="nofollow">')
    )
    assert website.event_pages(nofollow, today=TODAY) == []


def test_sites_are_the_home_pages_enrichment_read() -> None:
    def record(url: str, **internal) -> Observation:
        return Observation(
            source_type="society_website",
            source_key=url,
            source_url=url,
            retrieved_at=NOW,
            entity_type="organisation",
            identity=IdentityHints(name="Quokkas", known_key=KEY),
            entity_key=KEY,
            internal=internal,
        )

    from camsocs_pipeline.claims import parser_field

    stated = record("http://quokkas.example.org")
    stated.fields.append(
        parser_field("website", f"{SITE}/", extractor="website.final_url", evidence="primary")
    )
    home = record(f"{SITE}/", website_domain="quokkas.example.org", website_health={"x": 1})
    about = record(f"{SITE}/about")
    (site,) = website.sites_from([about, stated, home])
    assert (site.home_url, site.stated_urls) == (f"{SITE}/", ("http://quokkas.example.org",))


# --- structured data -----------------------------------------------------------------------------


def test_structured_events_are_read_by_a_parser() -> None:
    graph = {
        "@context": "https://schema.org",
        "@graph": [
            {"@type": "WebPage", "name": "Events"},
            {
                "@type": "SocialEvent",
                "name": "Quokka Quiz",
                "startDate": "2026-10-15T19:30:00+01:00",
                "endDate": "2026-10-15T21:00:00+01:00",
                "location": {
                    "@type": "Place",
                    "name": "The Old Library",
                    "address": {"@type": "PostalAddress", "addressLocality": "Cambridge"},
                },
                "url": f"{SITE}/events/quiz",
                "eventStatus": "https://schema.org/EventCancelled",
            },
            {
                "@type": "Event",
                "name": "Open day",
                "startDate": "2026-10-17",
                "endDate": "2026-10-18",
            },
        ],
    }
    html = (
        f'<html><head><script type="application/ld+json">{json.dumps(graph)}</script></head></html>'
    )
    page = parse_page(f"{SITE}/events", html)
    items = website.structured_events(page)
    assert [item["name"] for item in items] == ["Quokka Quiz", "Open day"]
    quiz, open_day = (website.structured_draft(item, QUOKKAS) for item in items)
    assert quiz is not None and open_day is not None
    assert quiz.starts_at == datetime(2026, 10, 15, 19, 30, tzinfo=LONDON)
    assert quiz.venue is not None and quiz.venue.name == "The Old Library, Cambridge"
    assert quiz.cancelled is True and quiz.page_url == f"{SITE}/events/quiz"
    assert quiz.external_id == f"{KEY}:2026-10-15:quokka-quiz"
    assert open_day.all_day
    assert open_day.ends_at == datetime(2026, 10, 19, tzinfo=LONDON)  # endDate is inclusive


# --- the model's reading -------------------------------------------------------------------


@pytest.mark.parametrize(
    ("event", "kept"),
    [
        ({"date": "2026-10-15", "when_quote": "Thursday 15 October, 7:30pm"}, True),
        ({"date": "2026-10-15", "when_quote": "Oct 15th"}, True),
        ({"date": "2026-10-15", "when_quote": "15/10"}, True),
        # The quote must hold the date's own day number…
        ({"date": "2026-10-16", "when_quote": "Thursday 15 October, 7:30pm"}, False),
        # … and be on the page.
        ({"date": "2026-10-15", "when_quote": "15 October 2026"}, False),
        ({"date": "2026-10-20", "when_quote": "Coming soon"}, False),
        ({"term_week": 5, "weekday": "wednesday", "when_quote": "Week 5 Wednesday, 2pm"}, True),
        ({"term_week": 5, "weekday": "wednesday", "when_quote": "Week 5"}, False),
        ({"relative_day": "tomorrow", "when_quote": "Thursday 15 October, 7:30pm"}, False),
        ({"date": "2026-10-15"}, False),
    ],
)
def test_every_event_needs_a_dated_quote_on_the_page(event: dict, kept: bool) -> None:
    text = website.page_text(parse_page(f"{SITE}/events", EVENTS_PAGE)) + (
        " Thursday 15 October, 7:30pm Oct 15th 15/10 Coming soon Week 5 Wednesday, 2pm"
    )
    assert dating.dated_quote(LlmEvent(title="x", **event), text) is kept


def test_a_site_yields_its_upcoming_dated_events(tmp_path: Path, net: respx.MockRouter) -> None:
    serve(net, robots="User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nDisallow: /events\n")
    llm = FakeLLM(lambda _text, _tier: REPLY)
    with client(tmp_path) as polite:
        result = website.read_site(
            polite, QUOKKAS, llm=llm, memo=None, calendar=TermCalendar.default(), now=NOW
        )

    by_title = {values(e)["title"]: e for e in result.events}
    # Past (3 Oct), no dated quote (film night) and nine-plus months ahead
    # (July 2027) are left out; Week 5 Wednesday resolves in Michaelmas 2026.
    assert sorted(by_title) == ["Burrow building", "Quokka Quiz"]
    assert result.tally.dropped == {
        "no dated quote on the page": 1,
        "past": 1,
        "more than nine months ahead": 1,
    }
    quiz = by_title["Quokka Quiz"]
    assert (quiz.source_type, quiz.event_source) == ("society_website", "website")
    assert quiz.external_id == f"{KEY}:2026-10-15:quokka-quiz"
    assert quiz.visibility == "public"
    assert [o.identity.known_key for o in quiz.organisers] == [KEY]
    assert values(quiz)["startsAt"] == ms(2026, 10, 15, 19, 30)
    starts = next(f for f in quiz.fields if f.field == "startsAt")
    # "Thursday 15 October" states no year: the year is our inference, so
    # the start is inferred (its words stay in valueRaw).
    assert starts.status == "inferred" and starts.value_raw == "Thursday 15 October, 7:30pm"
    assert values(by_title["Burrow building"])["startsAt"] == ms(2026, 11, 11, 14, 0)
    # robots.txt disallows /events and blocks GPTBot: the society's own page
    # is read (D3) and the sources row says so; contacts never reach the model.
    assert quiz.fetch is not None and quiz.fetch.robots_verdict == "disallowed"
    assert ROBOTS_OVERRIDE_NOTE in (quiz.fetch.access_note or "")
    # GPTBot is blocked: the page reached the model only through the D3
    # override of that AI opt-out, and its events say so too.
    assert "ai_optout_override:society" in (quiz.fetch.access_note or "")
    assert "secretary@" not in llm.calls[0]["text"]
    assert llm.calls[0]["version"] == "website_events_v1" and llm.calls[0]["tier"] == "bulk"


def test_the_stage_stages_events_and_carries_unreached_sites(
    tmp_path: Path, net: respx.MockRouter, make_settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    serve(net)
    settings = make_settings(min_host_interval=0.0)
    run = RunReport(run_key="20261009T120000Z-abcdef", command="sync", dry_run=False)
    staging = StagingStore(tmp_path / "staging")
    home = Observation(
        source_type="society_website",
        source_key=f"{SITE}/",
        source_url=f"{SITE}/",
        retrieved_at=NOW,
        entity_type="organisation",
        identity=IdentityHints(name=QUOKKAS.org_name, known_key=KEY),
        entity_key=KEY,
        internal={"website_domain": "quokkas.example.org", "website_health": {"last_status": 200}},
    )
    staging.write("society_website", "20261008T000000Z-aaaaaa", [home])
    ctx = StageContext(
        settings=settings,
        report=run.stage("website_events"),
        run=run,
        loader=ConvexLoader("", "", dry_run=True),
        state=SyncState(),
        staging=staging,
        dry_run=False,
        limit=None,
    )
    fake = FakeLLM(lambda _text, _tier: REPLY)
    monkeypatch.setattr(website, "LLMClient", lambda _settings: fake)
    monkeypatch.setattr(type(settings), "require_llm", lambda _self: None)

    website.run(ctx, now=NOW)

    staged = staging.read_latest("society_website.events")
    assert sorted(values(e)["title"] for e in staged) == ["Burrow building", "Quokka Quiz"]
    assert any("1 read for events" in n and "2 events from 1 sites" in n for n in ctx.report.notes)
    # What it staged is the stage's output, so the run report does not say "nothing to do".
    assert (ctx.report.inserted, ctx.report.unchanged) == (2, 0)

    # A --limit run that reaches no site keeps the events it did not re-read.
    ctx.limit = 0
    ctx.report.notes.clear()
    ctx.report.inserted = 0
    website.run(ctx, now=NOW)
    assert len(staging.read_latest("society_website.events")) == 2
    assert any("2 carried forward" in n for n in ctx.report.notes)
    assert (ctx.report.inserted, ctx.report.unchanged) == (0, 2)


@pytest.mark.parametrize(
    ("event", "problem"),
    [
        ({"date": "2026-10-15", "when_quote": "Thursday 15 October"}, None),
        ({"date": "2027-03-05", "when_quote": "Fri 5 March 2027"}, None),
        ({"date": "2026-10-20", "when_quote": "20 October"}, None),  # within eight weeks
        # Last year's programme, read in October: 5 March 2027 is a Friday.
        ({"date": "2027-03-05", "when_quote": "Thursday 5 March"}, "weekday"),
        ({"date": "2027-03-05", "when_quote": "5 March"}, "months ahead"),
        ({"date": "2027-03-05", "when_quote": "5 March 2026"}, "year"),
        ({"term_week": 3, "weekday": "wednesday", "when_quote": "Week 3 Wednesday"}, None),
    ],
)
def test_a_dates_year_must_be_stated_or_checkable(event: dict, problem: str | None) -> None:
    found = dating.year_problem(LlmEvent(title="x", **event), TODAY)
    assert (found is None) if problem is None else (found is not None and problem in found)


def test_last_seasons_pages_give_no_yearless_dates() -> None:
    from datetime import date

    read_on = date(2026, 10, 10)
    # A 2020-21 archive whose weekdays fall on this year's dates as well.
    archive = dating.page_dating("Events 2021 · Sat, 19 Dec · Zoom", read_on)
    assert archive.stale is not None
    # A fixtures table scored "2025-26", and a post about the 2025/2026 season.
    assert dating.page_dating("Fixtures · Score 2025-26 · 26th October", read_on).stale
    assert dating.page_dating("The upcoming 2025/2026 season … 2026", read_on).stale
    # This year's page, or a page naming no year at all.
    assert dating.page_dating("Michaelmas 2026 events", read_on).current
    nothing = dating.page_dating("Thursday 15 October, 7:30pm", read_on)
    assert nothing.stale is None and not nothing.current
    event = {"date": "2026-12-19", "when_quote": "Sat, 19 Dec"}
    assert dating.year_problem(LlmEvent(title="x", **event), read_on, archive)
    # A weekday alone is one signal; with this year or the term named it is two.
    assert "only its weekday" in (
        dating.year_problem(LlmEvent(title="x", **event), read_on, nothing) or ""
    )
    with_term = dating.PageDating(term=True)
    assert dating.year_problem(LlmEvent(title="x", **event), read_on, with_term) is None


def test_a_page_whose_weekdays_agree_on_this_year_dates_its_events() -> None:
    from datetime import date

    read_on = date(2026, 10, 10)

    def read(day: str, quote: str) -> LlmEvent:
        return LlmEvent(title="x", date=day, when_quote=quote)

    # This year's programme with last year's "next event" left above it
    # (10 October 2025 was a Friday): three dates agree, one does not.
    current = [
        read("2026-10-10", "Friday, 10 October 16:30"),
        read("2026-10-10", "Saturday, 10 October 16:30"),
        read("2026-10-17", "Saturday, 17 October 20:00"),
        read("2026-10-29", "Thursday, 29 October 19:00"),
    ]
    assert dating.weekdays_agree(current)
    agreeing = dating.PageDating(weekdays=True)
    assert dating.year_problem(current[2], read_on, agreeing) is None
    # The leftover still fails its own weekday.
    assert "weekday" in (dating.year_problem(current[0], read_on, agreeing) or "")
    # Two agreeing dates are not enough; nor three among many that disagree
    # (an old archive matches one weekday in seven by chance).
    assert not dating.weekdays_agree(current[1:3])
    archive = [
        *current[1:],
        *(read(f"2026-11-{day:02d}", f"Monday {day} November") for day in (3, 10, 17, 24)),
    ]
    assert not dating.weekdays_agree(archive)
    # A stated year is no yearless date and counts neither way.
    stated = [read(f"2026-10-{d}", f"Saturday {d} October 2026") for d in (10, 17, 24)]
    assert not dating.weekdays_agree(stated)


def test_a_page_that_says_noai_on_a_general_host_never_reaches_the_model(
    tmp_path: Path, net: respx.MockRouter
) -> None:
    from camsocs_pipeline.models.observation import FetchInfo
    from camsocs_pipeline.pipeline.load import _merged_notes
    from camsocs_pipeline.sources.websites.page import parse_page
    from camsocs_pipeline.sources.websites.site import ai_reading

    with client(tmp_path) as polite:
        net.get("https://www.cmf.org.uk/robots.txt").respond(200, text="User-agent: *\nAllow: /\n")
        page = parse_page(
            "https://www.cmf.org.uk/events/",
            '<meta name="robots" content="noai"><p>Events</p>',
        )
        assert ai_reading(polite, page) == "refused"
        net.get(f"{SITE}/robots.txt").respond(200, text="User-agent: *\nAllow: /\n")
        own = parse_page(f"{SITE}/events", '<meta name="robots" content="noai"><p>Events</p>')
        assert ai_reading(polite, own) == "override"
    # Two records of one URL: the source row keeps both notes.
    assert (
        _merged_notes(
            "robots_override:society", FetchInfo(access_note="ai_optout_override:society")
        )
        == "robots_override:society; ai_optout_override:society"
    )
