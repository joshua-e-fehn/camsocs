"""The talks pillar's pipeline half (docs/talks-redesign-spec.md §2–§4, D7):
the talks.cam API reader, the text rules, department mapping, cross-source
dedupe, the Convex push and the `talks` stage, on synthetic data shaped like
the documented API (no talks.cam content is used or fetched)."""

from __future__ import annotations

import json
import sys
import types
from datetime import UTC, datetime, timedelta
from itertools import pairwise
from pathlib import Path
from urllib.parse import urlencode

import httpx
import pytest
import respx

import camsocs_pipeline.pipeline.load as load
from camsocs_pipeline.claims import NO_LLM_SOURCE_TYPES, NoLLMSource, llm_field
from camsocs_pipeline.events.common import LONDON, EventWindow
from camsocs_pipeline.extract.ai_gate import AiGate
from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.pipeline.load import ConvexError, ConvexLoader
from camsocs_pipeline.pipeline.report import RunReport
from camsocs_pipeline.pipeline.state import SyncState
from camsocs_pipeline.prune import prune_staging
from camsocs_pipeline.sources.base import HostGates, PoliteClient
from camsocs_pipeline.staging.store import StagingStore
from camsocs_pipeline.talks import push, stage, talkscam
from camsocs_pipeline.talks.dedupe import dedupe, title_key
from camsocs_pipeline.talks.mapping import DepartmentMapper
from camsocs_pipeline.talks.model import SOURCE_TYPES, Speaker, TalkRecord
from camsocs_pipeline.talks.registry import parse_registry
from camsocs_pipeline.talks.text import (
    guess_kind,
    is_cancelled,
    is_online,
    normalise_title,
    parse_speakers,
    plain_text,
)

FIXTURES = Path(__file__).parent / "fixtures"
SITE = "https://happy-otter-123.convex.site"
CAM = "https://talks.cam.ac.uk"
API = f"{CAM}/api/v1alpha1/talks/"
ROBOTS = "User-agent: ClaudeBot\nDisallow: /\n\nUser-agent: *\nCrawl-delay: 10\n"
NOW = datetime(2026, 10, 31, 12, 0, tzinfo=UTC)
WINDOW = talkscam.talks_window(NOW)
RETRIEVED = datetime(2026, 10, 31, 12, 0, tzinfo=UTC)

REGISTRY = parse_registry(
    [
        {
            "key": "dept-widget-studies",
            "slug": "widget-studies",
            "name": "Department of Widget Studies",
            "shortName": "Widget Studies",
            "school": "technology",
            "website": "https://widgets.example.org",
            "aliases": ["Widget Lab"],
            "venueHints": ["Example Building"],
            "talksCamListIds": ["101"],
            "sources": [
                {"kind": "ics", "url": "https://widgets.example.org/talks.ics", "label": "ICS"},
                {"kind": "rss", "url": "https://widgets.example.org/feed", "label": "RSS"},
            ],
        },
        {
            "key": "dept-history",
            "slug": "history",
            "name": "Faculty of History",
            "shortName": "History",
            "school": "humanities_social_sciences",
            "aliases": [],
            "venueHints": ["Sample Hall"],
            "sources": [
                {"kind": "drupal_uis", "url": "https://history.example.org/events", "label": "x"}
            ],
        },
        {
            "key": "dept-history-of-gadgets",
            "slug": "history-of-gadgets",
            "name": "Department of History of Gadgets",
            "shortName": "History of Gadgets",
            "school": "humanities_social_sciences",
            "aliases": ["HoG"],
        },
        {
            "key": "dept-chemistry",
            "slug": "chemistry",
            "name": "Yusuf Hamied Department of Chemistry",
            "shortName": "Chemistry",
            "school": "physical_sciences",
        },
    ]
)
MAPPER = DepartmentMapper(REGISTRY)

#: One department with a source of every kind, for the model tripwire test.
DEPT = "https://tripwire.example.org"
TRIPWIRE_REGISTRY = parse_registry(
    [
        {
            "key": "dept-tripwire",
            "slug": "tripwire",
            "name": "Department of Tripwire Studies",
            "shortName": "Tripwire Studies",
            "school": "technology",
            "website": DEPT,
            "sources": [
                {"kind": kind, "url": f"{DEPT}{path}", "label": kind}
                for kind, path in (
                    ("ics", "/talks.ics"),
                    ("rss", "/seminars/feed"),
                    ("json_api", "/events.json"),
                    ("json_ld", "/lectures"),
                    ("drupal_uis", "/seminars"),
                )
            ],
        }
    ]
)
_LECTURE = {
    "@type": "Event",
    "name": "Tripwire Lecture: an invented talk",
    "startDate": "2026-11-12T17:00:00",
    "endDate": "2026-11-12T18:00:00",
    "url": "/lectures/1",
}
#: Each source's listing: invented content, or a synthetic fixture
#: (fixtures/talks/README.md) in the markup its parser reads.
TRIPWIRE_PAGES: dict[str, tuple[bytes, str]] = {
    "/talks.ics": (
        b"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//camsocs test//EN\r\n"
        b"BEGIN:VEVENT\r\nUID:synthetic-1@tripwire.example.org\r\n"
        b"DTSTART:20261105T130000Z\r\nDTEND:20261105T140000Z\r\n"
        b"SUMMARY:Tripwire Seminar: an invented talk\r\n"
        b"LOCATION:Example Building\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
        "text/calendar",
    ),
    "/seminars/feed": (
        (FIXTURES / "talks" / "rss_cst_seminars.xml").read_bytes(),
        "application/rss+xml",
    ),
    "/events.json": (
        json.dumps(
            [
                {
                    "slug": "tripwire-colloquium",
                    "title": "Tripwire Colloquium: an invented talk",
                    "url": "/events/tripwire-colloquium/",
                    "event_date": "2026-11-19",
                }
            ]
        ).encode(),
        "application/json",
    ),
    "/lectures": (
        (
            '<html><head><script type="application/ld+json">'
            f"{json.dumps([_LECTURE])}</script></head><body></body></html>"
        ).encode(),
        "text/html",
    ),
    "/seminars": (
        (FIXTURES / "talks" / "views_cst_seminars.html").read_bytes(),
        "text/html",
    ),
}


@pytest.fixture(autouse=True)
def _no_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(load.time, "sleep", lambda _seconds: None)


def london(*args: int) -> datetime:
    return datetime(*args, tzinfo=LONDON)


def iso(moment: datetime) -> str:
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def raw_talk(talk_id: int, start: datetime, **overrides: object) -> dict:
    """One API result shaped like the documented API — invented content."""
    talk: dict[str, object] = {
        "id": talk_id,
        "title": "Quantum widgets in practice",
        "abstract": "<p>About <b>widgets</b>.</p><p>Second &amp; last.</p>",
        "startTime": iso(start),
        "endTime": iso(start + timedelta(hours=1)),
        "nameOfSpeaker": "Dr Ada Example (Institute of Testing)",
        "speakerUrl": "",
        "series": {
            "id": 101,
            "name": "Widget Theory Seminars",
            "details": "",
            "listType": "series",
            "exDirectory": False,
            "createdAt": "2020-01-01T00:00:00Z",
        },
        "venue": {"id": 7, "name": "Room 1, Example Building", "createdAt": "2020-01-01T00:00:00Z"},
        "specialMessage": "",
        "exDirectory": False,
        "createdAt": "2026-09-01T00:00:00Z",
        "updatedAt": "2026-09-02T00:00:00Z",
    }
    talk.update(overrides)
    return talk


def fake_api(talks: list[dict], *, page_size: int = 2, count_offset: int = 0):
    """A respx side effect paginating `talks` by the query's start window."""

    def handler(request: httpx.Request) -> httpx.Response:
        params = dict(request.url.params)
        lo = datetime.fromisoformat(params["start_time__gte"])
        hi = datetime.fromisoformat(params["start_time__lt"])
        chosen = [t for t in talks if lo <= datetime.fromisoformat(str(t["startTime"])) < hi]
        page = int(params.get("page", "1"))
        items = chosen[(page - 1) * page_size : page * page_size]
        following = None
        if page * page_size < len(chosen):
            following = f"{API}?{urlencode({**params, 'page': page + 1})}"
        return httpx.Response(
            200,
            json={
                "count": len(chosen) + count_offset,
                "next": following,
                "previous": None,
                "results": items,
            },
        )

    return handler


def client(tmp_path: Path, sleeps: list[float] | None = None) -> PoliteClient:
    return PoliteClient(
        user_agent="camsocs-test/0.1 (+https://example.org/camsocs)",
        cache_dir=tmp_path / "cache",
        min_interval=0.0,
        gates=HostGates(),
        sleep=(sleeps if sleeps is not None else []).append,
    )


def record(**overrides: object) -> TalkRecord:
    values: dict[str, object] = {
        "source_type": "talks_cam",
        "source": "talks_cam",
        "external_id": "1",
        "url": f"{CAM}/talk/index/1",
        "source_url": API,
        "title": "Quantum widgets in practice",
        "starts_at": london(2026, 11, 3, 16, 0),
        "retrieved_at": RETRIEVED,
        "talks_cam_id": 1,
    }
    values.update(overrides)
    return TalkRecord(**values)  # type: ignore[arg-type]


# --- text rules -----------------------------------------------------------------------------


class TestText:
    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("Dr Ada Example (Institute of Testing)", [("Dr Ada Example", "Institute of Testing")]),
            (
                "Prof B Sample; Dr C Demo (Elsewhere University)",
                [("Prof B Sample", None), ("Dr C Demo", "Elsewhere University")],
            ),
            ("Ada Example and Bea Sample", [("Ada Example", None), ("Bea Sample", None)]),
            (
                "Dr Ada Example (Oxbridge and Elsewhere) and Prof Bea Sample (Nowhere)",
                [("Dr Ada Example", "Oxbridge and Elsewhere"), ("Prof Bea Sample", "Nowhere")],
            ),
            # A comma means " and " belongs to the affiliation.
            (
                "Ada Example, Dept of Earth and Planetary Widgets",
                [("Ada Example", "Dept of Earth and Planetary Widgets")],
            ),
            ("Ada Example, University of Testing", [("Ada Example", "University of Testing")]),
            # One-word sides are not split: they may be one name.
            ("Smith and Jones", [("Smith and Jones", None)]),
            ("Dr Ada (Bea) Example (Widget Ltd)", [("Dr Ada (Bea) Example", "Widget Ltd")]),
            ("Dr Ada Example (TBC)", [("Dr Ada Example", None)]),
            ("TBC", []),
            ("Speaker to be confirmed", []),
            ("", []),
            (None, []),
        ],
    )
    def test_speakers_are_split_conservatively(self, text, expected) -> None:
        assert [(s.name, s.affiliation) for s in parse_speakers(text)] == expected

    def test_speakers_are_capped_and_deduplicated(self) -> None:
        names = "; ".join(f"Dr Person{n} Example" for n in range(14))
        assert len(parse_speakers(names)) == 10
        assert len(parse_speakers("Dr Ada Example; Dr Ada Example")) == 1

    def test_cancellation_is_a_word_not_a_topic(self) -> None:
        assert is_cancelled("CANCELLED: Quantum widgets")
        assert is_cancelled("Quantum widgets", "This talk has been postponed")
        assert is_cancelled("Canceled - widgets")
        assert not is_cancelled("Noise cancellation in widgets")
        assert not is_cancelled("Widgets", "")

    def test_online_needs_a_marker_or_a_meeting_link(self) -> None:
        assert is_online(venue="Online (Zoom)")
        assert is_online(venue="Microsoft Teams")
        assert is_online(venue="Room 1", special_message="Hybrid: also on live stream")
        assert is_online(title="Widgets (online)")
        assert is_online(abstract="Join at https://us02web.zoom.us/j/123")
        assert not is_online(venue="Room 1", title="Online learning for widgets")
        assert not is_online(abstract="Research teams work online and virtually")
        # Admin about the listing, or a recording's link, is no online talk.
        assert not is_online(venue="Room 1", special_message="Please register online first")
        assert not is_online(special_message="Slides will be available online afterwards")
        assert not is_online(abstract="A recording: https://youtu.be/abc123")
        assert is_online(special_message="Book online; the talk is also on Zoom")

    @pytest.mark.parametrize(
        ("title", "series", "kind"),
        [
            ("The Annual Widget Lecture", None, "lecture"),
            ("Widgets", "Gadget Lectures", "lecture"),
            ("Widget workshop", "Gadget Seminars", "workshop"),
            ("Widget Symposium 2026", None, "conference"),
            ("Graduate colloquium day", None, "conference"),
            ("Widgets", "Physics Colloquium", "seminar"),
            ("A talk about widgets", None, "seminar"),
            ("Widgets", None, "seminar"),
        ],
    )
    def test_kind_from_title_then_series(self, title, series, kind) -> None:
        assert guess_kind(title, series) == kind

    def test_plain_text_keeps_paragraphs(self) -> None:
        assert plain_text("<p>About <b>widgets</b>.</p><p>Second &amp; last.</p>") == (
            "About widgets.\nSecond & last."
        )
        assert normalise_title("CANCELLED: Quantum  Widgets!") == "quantum widgets"


# --- the API reader ---------------------------------------------------------------------------


class TestTalksCamApi:
    def test_window_and_slices_are_london_midnights(self) -> None:
        assert WINDOW.start == london(2026, 10, 30)
        assert WINDOW.end == london(2027, 1, 9)
        parts = talkscam.slices(WINDOW)
        assert parts[0][0] == WINDOW.start and parts[-1][1] == WINDOW.end
        assert all(a[1] == b[0] for a, b in pairwise(parts))
        assert len(parts) == 11
        # Across a clock change a slice still starts at a London midnight.
        spring = talkscam.slices(talkscam.talks_window(datetime(2027, 3, 20, tzinfo=UTC)))
        assert all(start.astimezone(LONDON).hour == 0 for start, _ in spring)

    def test_query_url_asks_for_a_utc_start_window_in_order(self) -> None:
        url = talkscam.query_url(london(2026, 11, 2), london(2026, 11, 9))
        params = dict(httpx.URL(url).params)
        assert url.startswith(API)
        assert params == {
            "start_time__gte": "2026-11-02T00:00:00Z",
            "start_time__lt": "2026-11-09T00:00:00Z",
            "ordering": "start_time",
        }

    def test_pagination_follows_next_and_checks_the_count(
        self, tmp_path: Path, net: respx.MockRouter
    ) -> None:
        net.get(f"{CAM}/robots.txt").respond(200, text=ROBOTS)
        talks = [raw_talk(n, london(2026, 11, 2, 9 + n)) for n in range(1, 6)]
        net.get(url__startswith=API).mock(side_effect=fake_api(talks))
        sleeps: list[float] = []
        with client(tmp_path, sleeps) as http:
            pages = talkscam.read_query(
                http, talkscam.query_url(london(2026, 11, 2), london(2026, 11, 3))
            )
        assert [len(page.results) for page in pages] == [2, 2, 1]
        assert len({page.url for page in pages}) == 3
        # robots.txt's Crawl-delay 10 holds between the API requests.
        assert sum(1 for s in sleeps if s > 9) >= 2

    def test_a_count_mismatch_is_a_failure_not_fewer_talks(
        self, tmp_path: Path, net: respx.MockRouter
    ) -> None:
        net.get(f"{CAM}/robots.txt").respond(404)
        talks = [raw_talk(n, london(2026, 11, 2, 9 + n)) for n in range(1, 4)]
        net.get(url__startswith=API).mock(side_effect=fake_api(talks, count_offset=1))
        with client(tmp_path) as http, pytest.raises(talkscam.TalksCamError, match="count 4"):
            talkscam.read_query(http, talkscam.query_url(london(2026, 11, 2), london(2026, 11, 3)))

    @pytest.mark.parametrize(
        ("following", "message"),
        [
            ("https://evil.example.org/api/v1alpha1/talks/?page=2", "off talks.cam"),
            (f"{CAM}/talk/index/5", "leaves the talks API"),
            (12, "not a URL"),
        ],
    )
    def test_next_stays_on_the_talks_api(self, following, message) -> None:
        with pytest.raises(talkscam.TalksCamError, match=message):
            talkscam.next_page(following, API)

    def test_next_may_be_relative_or_http(self) -> None:
        assert talkscam.next_page("?page=2", API) == f"{API}?page=2"
        assert talkscam.next_page(f"http://talks.cam.ac.uk{talkscam.API_PATH}?page=3", API) == (
            f"{API}?page=3"
        )
        assert talkscam.next_page(None, API) is None

    def test_page_cap_loops_and_bad_pages_fail(self, tmp_path: Path, net: respx.MockRouter) -> None:
        net.get(f"{CAM}/robots.txt").respond(404)
        looping = {"count": 4, "next": f"{API}?page=1", "results": [raw_talk(1, NOW)]}
        net.get(f"{API}?page=1").respond(200, json=looping)
        with client(tmp_path) as http, pytest.raises(talkscam.TalksCamError, match="repeats"):
            talkscam.read_query(http, f"{API}?page=1")
        endless = {"count": 99, "next": f"{API}?page=9", "results": [raw_talk(1, NOW)]}
        net.get(f"{API}?page=8").respond(200, json=endless)
        net.get(f"{API}?page=9").respond(200, json={**endless, "next": f"{API}?page=10"})
        with client(tmp_path) as http, pytest.raises(talkscam.TalksCamError, match="more than 2"):
            talkscam.read_query(http, f"{API}?page=8", max_pages=2)
        net.get(f"{API}?page=20").respond(200, text="<html>not json</html>")
        with client(tmp_path) as http, pytest.raises(talkscam.TalksCamError, match="not JSON"):
            talkscam.read_query(http, f"{API}?page=20")
        net.get(f"{API}?page=21").respond(503)
        quick = client(tmp_path)
        quick.max_retries = 0
        with quick, pytest.raises(talkscam.TalksCamError, match="unreachable"):
            talkscam.read_query(quick, f"{API}?page=21")

    def test_a_talk_becomes_a_record(self) -> None:
        raw = raw_talk(
            4242,
            london(2026, 11, 3, 16, 0),
            title="CANCELLED: Quantum widgets",
            specialMessage="<p>Also on <a href='https://x.example.org'>Zoom</a></p>",
            endTime=None,
        )
        talk = talkscam.parse_talk(
            raw, source_url=f"{API}?x=1", retrieved_at=RETRIEVED, mapper=MAPPER
        )
        assert talk is not None
        assert (talk.source_type, talk.source, talk.external_id) == (
            "talks_cam",
            "talks_cam",
            "4242",
        )
        assert talk.url == f"{CAM}/talk/index/4242" and talk.source_url == f"{API}?x=1"
        assert talk.talks_cam_id == 4242
        assert talk.starts_at == london(2026, 11, 3, 16, 0) and talk.ends_at is None
        assert talk.speakers == [Speaker("Dr Ada Example", "Institute of Testing")]
        assert talk.series == "Widget Theory Seminars" and talk.venue == "Room 1, Example Building"
        assert talk.abstract == "About widgets.\nSecond & last."
        assert talk.special_message == "Also on Zoom"
        assert talk.cancelled and talk.online and talk.kind == "seminar"
        assert talk.department_keys == ["dept-widget-studies"]
        wire = talk.to_wire()
        assert wire["key"] == talk.key
        assert wire["startsAt"] == int(datetime(2026, 11, 3, 16, tzinfo=UTC).timestamp() * 1000)
        assert "endsAt" not in wire

    def test_unreadable_talks_are_none(self) -> None:
        start = london(2026, 11, 3, 16)
        for broken in (
            raw_talk(1, start, title="  "),
            raw_talk(1, start, startTime="not a time"),
            raw_talk(1, start, startTime="2026-11-03T16:00:00"),  # no zone
            raw_talk("x", start),
            raw_talk(True, start),
        ):
            assert (
                talkscam.parse_talk(broken, source_url=API, retrieved_at=RETRIEVED, mapper=MAPPER)
                is None
            )

    def test_the_whole_window_is_read_in_slices_and_ex_directory_talks_are_left_out(
        self, tmp_path: Path, net: respx.MockRouter
    ) -> None:
        net.get(f"{CAM}/robots.txt").respond(200, text=ROBOTS)
        talks = [
            raw_talk(1, london(2026, 10, 30, 10)),
            raw_talk(2, london(2026, 11, 12, 10), series=None, venue=None),
            raw_talk(3, london(2026, 12, 1, 10), exDirectory=True),
            raw_talk(4, london(2027, 1, 8, 23, 30)),
            raw_talk(5, london(2026, 11, 12, 11), title=""),
        ]
        net.get(url__startswith=API).mock(side_effect=fake_api(talks))
        with client(tmp_path) as http:
            read = talkscam.read_talks_cam(http, WINDOW, MAPPER)
        assert read.complete and read.slices == read.slices_read == 11
        assert [r.talks_cam_id for r in read.records] == [1, 2, 4]
        assert read.received == 5 and read.mapped == 2
        assert read.dropped == {"ex-directory": 1, "unreadable": 1}

    def test_a_failed_slice_makes_the_read_incomplete(
        self, tmp_path: Path, net: respx.MockRouter
    ) -> None:
        net.get(f"{CAM}/robots.txt").respond(404)
        talks = [raw_talk(1, london(2026, 11, 1, 10)), raw_talk(2, london(2026, 11, 15, 10))]
        api = fake_api(talks)

        def flaky(request: httpx.Request) -> httpx.Response:
            if request.url.params["start_time__gte"].startswith("2026-11-13"):
                return httpx.Response(404)
            return api(request)

        net.get(url__startswith=API).mock(side_effect=flaky)
        with client(tmp_path) as http:
            read = talkscam.read_talks_cam(http, WINDOW, MAPPER)
        assert not read.complete and read.slices_read == 10
        assert [r.talks_cam_id for r in read.records] == [1]
        assert read.errors and read.errors[0].startswith("slice 3/11: not_found 404")

    def test_robots_disallow_means_nothing_is_read(
        self, tmp_path: Path, net: respx.MockRouter
    ) -> None:
        net.get(f"{CAM}/robots.txt").respond(200, text="User-agent: *\nDisallow: /api/\n")
        api = net.get(url__startswith=API).respond(200, json={"count": 0, "results": []})
        with client(tmp_path) as http:
            read = talkscam.read_talks_cam(http, WINDOW, MAPPER, max_slices=2)
        assert not api.called and not read.complete
        assert "disallowed_by_robots" in read.errors[1]

    def test_the_page_budget_bounds_the_read(self, tmp_path: Path, net: respx.MockRouter) -> None:
        net.get(f"{CAM}/robots.txt").respond(404)
        talks = [raw_talk(n, london(2026, 11, 2, 8) + timedelta(minutes=n)) for n in range(1, 6)]
        net.get(url__startswith=API).mock(side_effect=fake_api(talks))
        with client(tmp_path) as http:
            read = talkscam.read_talks_cam(http, WINDOW, MAPPER, max_total_pages=4)
        assert not read.complete and read.pages <= 4
        assert any("budget is spent" in error for error in read.errors)

    def test_pages_of_failed_slices_count_against_the_budget(
        self, tmp_path: Path, net: respx.MockRouter
    ) -> None:
        net.get(f"{CAM}/robots.txt").respond(404)
        api = net.get(url__startswith=API).respond(503)
        with client(tmp_path) as http:
            http.max_retries = 0
            read = talkscam.read_talks_cam(http, WINDOW, MAPPER, max_total_pages=3)
        # Three failed requests spend the budget; the other slices are not asked for.
        assert api.call_count == 3 and read.slices_read == 0 and read.pages_failed == 3
        assert sum("budget is spent" in error for error in read.errors) == 8

    def test_the_time_budget_bounds_the_read(self, tmp_path: Path, net: respx.MockRouter) -> None:
        net.get(f"{CAM}/robots.txt").respond(404)
        api = net.get(url__startswith=API).mock(side_effect=fake_api([]))
        ticks = iter(float(n) for n in range(100))
        with client(tmp_path) as http:
            read = talkscam.read_talks_cam(
                http, WINDOW, MAPPER, budget=timedelta(seconds=2.5), clock=lambda: next(ticks)
            )
        # The deadline is read at 0; slices start at 1 and 2, the third finds it spent.
        assert api.call_count == 2 and read.slices_read == 2 and not read.complete
        assert sum("time budget is spent" in error for error in read.errors) == 9
        assert len(read.unread) == 9 and not read.covers(read.unread[0][0])


# --- mapping ----------------------------------------------------------------------------------


class TestMapping:
    def test_list_id_first(self) -> None:
        assert MAPPER.departments_for(series_id=101, series_name="Chemistry Seminars") == [
            "dept-widget-studies"
        ]
        assert MAPPER.departments_for(series_id="101") == ["dept-widget-studies"]

    def test_whole_words_case_insensitive_longest_first(self) -> None:
        assert MAPPER.departments_for(series_id=9, series_name="the widget lab tea talks") == [
            "dept-widget-studies"
        ]
        assert MAPPER.departments_for(series_name="Biochemistry Seminars") == []
        # "History" inside "History of Gadgets" does not count twice.
        assert MAPPER.departments_for(series_name="History of Gadgets Seminar") == [
            "dept-history-of-gadgets"
        ]
        assert MAPPER.departments_for(series_name="Joint History and Chemistry Colloquium") == [
            "dept-chemistry",
            "dept-history",
        ]

    def test_a_plain_word_must_name_the_subject(self) -> None:
        assert MAPPER.departments_for(series_name="Chemistry Seminars") == ["dept-chemistry"]
        assert MAPPER.departments_for(series_name="Chemistry: a lunchtime talk") == [
            "dept-chemistry"
        ]
        assert MAPPER.departments_for(series_name="Computational Chemistry Seminar") == []
        assert MAPPER.departments_for(series_name="History of Chemistry Seminar") == []
        assert MAPPER.departments_for(series_name="CU Chemistry Society") == []
        assert MAPPER.departments_for(series_name="Widgets and Chemistry Seminar") == []

    def test_an_acronym_matches_only_with_its_capitals(self) -> None:
        assert MAPPER.departments_for(series_name="HoG reading group") == [
            "dept-history-of-gadgets"
        ]
        assert MAPPER.departments_for(series_name="Hog roast talk") == []

    def test_venue_only_when_the_series_says_nothing(self) -> None:
        assert MAPPER.departments_for(series_name="Café Scientifique", venue="Sample Hall") == [
            "dept-history"
        ]
        assert MAPPER.departments_for(series_name="Chemistry Talks", venue="Sample Hall") == [
            "dept-chemistry"
        ]
        assert MAPPER.departments_for(series_name="Unrelated", venue="Elsewhere") == []


# --- dedupe -----------------------------------------------------------------------------------


class TestDedupe:
    def test_same_talks_cam_id_merges_and_talks_cam_wins(self) -> None:
        cam = record(department_keys=[])
        dept = record(
            source_type="dept_drupal",
            source="dept-history#0",
            external_id="https://history.example.org/events/widgets",
            url="https://history.example.org/events/widgets",
            title="A different spelling",
            department_keys=["dept-history"],
        )
        (merged,) = dedupe([dept, cam])
        assert merged.source_type == "talks_cam" and merged.url == cam.url
        assert merged.department_keys == ["dept-history"]

    def test_same_title_and_london_minute_merges(self) -> None:
        cam = record(department_keys=["dept-widget-studies"])
        dept = record(
            source_type="dept_ics",
            source="dept-history#0",
            external_id="uid-1@example.org",
            title="Quantum Widgets in Practice!",
            starts_at=london(2026, 11, 3, 16, 0, 30),
            talks_cam_id=None,
            department_keys=["dept-history"],
        )
        later = record(
            source_type="dept_ics",
            source="dept-history#0",
            external_id="uid-2@example.org",
            starts_at=london(2026, 11, 3, 17, 0),
            talks_cam_id=None,
        )
        merged = dedupe([dept, later, cam])
        assert [r.external_id for r in merged] == ["1", "uid-2@example.org"]
        assert merged[0].department_keys == ["dept-widget-studies", "dept-history"]

    def test_placeholder_titles_never_match(self) -> None:
        a = record(title="TBC", external_id="1", talks_cam_id=1)
        b = record(title="Title to be confirmed", external_id="2", talks_cam_id=2)
        c = record(title="Title to be confirmed", external_id="3", talks_cam_id=3)
        assert title_key(a) is None and title_key(b) is None
        assert len(dedupe([a, b, c])) == 3

    @pytest.mark.parametrize(
        "title",
        ["Journal Club", "Group meeting", "Departmental Seminar", "Weekly lab meeting", "WIP"],
    )
    def test_generic_slot_titles_never_match(self, title: str) -> None:
        a = record(title=title, external_id="1", talks_cam_id=1)
        b = record(title=title, external_id="2", talks_cam_id=2, department_keys=["dept-history"])
        assert title_key(a) is None
        assert len(dedupe([a, b])) == 2
        # A real title that only starts like one still matches.
        assert title_key(record(title="Group meetings in widget colonies")) is not None

    def test_groups_are_transitive_and_the_choice_is_deterministic(self) -> None:
        cam = record(talks_cam_id=7, external_id="7", abstract="short")
        copy = record(talks_cam_id=8, external_id="8", abstract="a much longer abstract")
        dept = record(
            source_type="dept_rss",
            source="dept-widget-studies#1",
            external_id="guid-1",
            talks_cam_id=8,
            title="Unrelated title",
            department_keys=["dept-widget-studies"],
        )
        (merged,) = dedupe([cam, copy, dept])
        assert [r.external_id for r in dedupe([dept, copy, cam])] == ["8"]
        assert merged.external_id == "8"
        assert merged.department_keys == ["dept-widget-studies"]
        # A cancelled cross-listed copy loses to a listed one.
        listed = record(talks_cam_id=9, external_id="9")
        cancelled = record(talks_cam_id=10, external_id="10", cancelled=True, abstract="longer")
        assert dedupe([cancelled, listed])[0].external_id == "9"


# --- wire and push ----------------------------------------------------------------------------


def convex(net: respx.MockRouter) -> dict[str, respx.Route]:
    return {
        "departments": net.post(f"{SITE}/api/pipeline/talks/departments").respond(
            200, json={"inserted": 4, "updated": 0, "unchanged": 0}
        ),
        "batch": net.post(f"{SITE}/api/pipeline/talks/batch").mock(
            side_effect=lambda request: httpx.Response(
                200,
                json={
                    "inserted": len(json.loads(request.content)["talks"]),
                    "updated": 0,
                    "unchanged": 0,
                },
            )
        ),
        "sweep": net.post(f"{SITE}/api/pipeline/talks/sweep").respond(200, json={"missing": 3}),
        "runs": net.post(f"{SITE}/api/pipeline/talks/runs").respond(200, json={"ok": True}),
    }


def bodies(route: respx.Route) -> list[dict]:
    return [json.loads(call.request.content) for call in route.calls]


class TestPush:
    def test_personal_crsid_addresses_never_leave_in_free_text(self) -> None:
        wire = record(
            abstract="Email ab123@cam.ac.uk to register, or seminars@widgets.cam.ac.uk.",
            special_message="Questions to zz99@cam.ac.uk",
        ).to_wire()
        assert "ab123@" not in str(wire["abstract"]) and "zz99@" not in str(wire["specialMessage"])
        assert "[personal email withheld]" in str(wire["abstract"])
        assert "seminars@widgets.cam.ac.uk" in str(wire["abstract"])

    def test_wire_caps_hold(self) -> None:
        wire = record(
            title="W" * 900,
            abstract="A" * 9000,
            special_message="S" * 2000,
            series="R" * 400,
            venue="V" * 400,
            speakers=[Speaker(f"Dr Person{n}", "X" * 400) for n in range(12)],
        ).to_wire()
        assert len(wire["title"]) == 500 and len(wire["abstract"]) == 4000
        assert len(wire["specialMessage"]) == 1000
        assert len(wire["series"]) == 300 and len(wire["venue"]) == 300
        assert len(wire["speakers"]) == 10
        assert all(len(s["affiliation"]) == 300 for s in wire["speakers"])
        assert None not in wire.values()

    def test_talks_go_in_batches_of_200_with_the_run_id(self, net: respx.MockRouter) -> None:
        routes = convex(net)
        records = [record(external_id=str(n), talks_cam_id=n) for n in range(450)]
        with ConvexLoader(SITE, "test-key") as loader:
            result = push.push_talks(loader, "run-1", records)
        sent = bodies(routes["batch"])
        assert [len(body["talks"]) for body in sent] == [200, 200, 50]
        assert all(body["runId"] == "run-1" for body in sent)
        assert result.inserted == 450 and result.requests == 3
        auth = routes["batch"].calls[0].request.headers["authorization"]
        assert auth == "Bearer test-key"

    def test_sweep_and_run_payloads(self, net: respx.MockRouter) -> None:
        routes = convex(net)
        window = EventWindow(london(2026, 10, 30), london(2027, 1, 9))
        with ConvexLoader(SITE, "test-key") as loader:
            assert push.sweep(loader, "run-1", window, []) == 0
            assert not routes["sweep"].called
            missing = push.sweep(loader, "run-1", window, ["talks_cam", "dept-a#0", "talks_cam"])
            push.post_run(
                loader,
                push.RunSummary(
                    run_id="run-1",
                    started_at=NOW,
                    finished_at=NOW + timedelta(minutes=3),
                    status="partial",
                    sources_ok=2,
                    sources_failed=1,
                    talks_received=5,
                    errors=["dept-a#1: ValueError"],
                ),
            )
        assert missing == 3
        assert bodies(routes["sweep"]) == [
            {
                "runId": "run-1",
                "from": int(window.start.timestamp() * 1000),
                "to": int(window.end.timestamp() * 1000),
                "sources": ["dept-a#0", "talks_cam"],
            }
        ]
        (run,) = bodies(routes["runs"])
        assert run["status"] == "partial" and run["sourcesFailed"] == 1
        assert run["finishedAt"] - run["startedAt"] == 180_000
        assert set(run) == {
            "runId",
            "status",
            "startedAt",
            "finishedAt",
            "sourcesOk",
            "sourcesFailed",
            "talksReceived",
            "inserted",
            "updated",
            "unchanged",
            "missing",
            "errors",
        }


# --- the stage --------------------------------------------------------------------------------


@pytest.fixture
def stage_ctx(tmp_path: Path, make_settings, monkeypatch: pytest.MonkeyPatch):
    """A `talks` stage context: the test registry, a crawler that records its
    sleeps instead of sleeping, and a loader against the mocked deployment."""
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

    monkeypatch.setattr(stage, "polite_client", fast_client)
    monkeypatch.setattr(stage, "load_registry", lambda: REGISTRY)

    def build(*, dry_run: bool = False, limit: int | None = None) -> StageContext:
        run = RunReport(run_key="20261031T120000Z-abcdef", command="sync", dry_run=dry_run)
        context = StageContext(
            settings=settings,
            report=run.stage("talks"),
            run=run,
            loader=ConvexLoader(SITE, "test-key", dry_run=dry_run),
            state=SyncState(),
            staging=StagingStore(settings.staging_dir),
            dry_run=dry_run,
            limit=limit,
        )
        context.sleeps = sleeps  # type: ignore[attr-defined]
        return context

    return build


def cam_talks() -> list[dict]:
    return [
        raw_talk(1, london(2026, 11, 3, 16, 0)),
        raw_talk(
            2,
            london(2026, 11, 4, 13, 0),
            title="Gadgets at noon",
            series={"id": 555, "name": "Lunchtime Series"},
            venue={"id": 9, "name": "Elsewhere"},
            nameOfSpeaker="Prof Bea Sample",
        ),
    ]


@pytest.fixture
def sites(monkeypatch: pytest.MonkeyPatch):
    """Installs a fake `talks.sites` module whose `collect` is the given function."""

    def install(collect) -> None:
        module = types.ModuleType(stage.SITES_MODULE)
        module.collect = collect  # type: ignore[attr-defined]
        monkeypatch.setitem(sys.modules, stage.SITES_MODULE, module)

    return install


def staged_lines(ctx: StageContext) -> list[dict]:
    path = stage.staging_path(ctx.settings.staging_dir, ctx.run.run_key)
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


class TestStage:
    def test_without_department_parsers_talks_cam_still_posts_and_is_swept(
        self, stage_ctx, net: respx.MockRouter, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(stage, "SITES_MODULE", "camsocs_pipeline.talks.no_such_sites")
        net.get(f"{CAM}/robots.txt").respond(200, text=ROBOTS)
        net.get(url__startswith=API).mock(side_effect=fake_api(cam_talks()))
        routes = convex(net)
        ctx = stage_ctx()

        stage.run(ctx, now=NOW)

        assert ctx.report.ok and ctx.report.inserted == 2
        (departments,) = bodies(routes["departments"])
        assert [d["key"] for d in departments["departments"]] == [d.key for d in REGISTRY]
        (batch,) = bodies(routes["batch"])
        assert [t["externalId"] for t in batch["talks"]] == ["1", "2"]
        assert batch["talks"][0]["departmentKeys"] == ["dept-widget-studies"]
        assert batch["talks"][1]["departmentKeys"] == []
        assert bodies(routes["sweep"])[0]["sources"] == ["talks_cam"]
        (run,) = bodies(routes["runs"])
        assert run["status"] == "ok" and run["talksReceived"] == 2 and run["missing"] == 3
        assert [line["key"] for line in staged_lines(ctx)] == [t["key"] for t in batch["talks"]]
        notes = "\n".join(ctx.report.notes)
        assert "talks.cam: 2 talks, 1 mapped to departments" in notes
        assert "dept sources: 0 ok, 0 failed, 3 skipped" in notes
        assert "no department parsers" in notes
        # Crawl-delay: talks.cam requests at least 10 s apart.
        assert sum(1 for s in ctx.sleeps if s > 9) >= 10
        assert ctx.report.metrics["talksCamMapped"] == 1

    def test_a_deployment_without_the_talks_routes_fails_before_any_crawl(
        self, stage_ctx, net: respx.MockRouter, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(stage, "SITES_MODULE", "camsocs_pipeline.talks.no_such_sites")
        departments = net.post(f"{SITE}/api/pipeline/talks/departments").respond(
            404, text="No matching routes found"
        )
        api = net.get(url__startswith=API).mock(side_effect=fake_api(cam_talks()))
        robots = net.get(f"{CAM}/robots.txt").respond(200, text=ROBOTS)
        ctx = stage_ctx()

        with pytest.raises(load.ConvexError):
            stage.run(ctx, now=NOW)

        assert departments.called and not api.called and not robots.called
        assert any("talks/departments not accepted" in note for note in ctx.report.notes)

    def test_department_sources_through_the_hook(
        self, stage_ctx, sites, net: respx.MockRouter
    ) -> None:
        def collect(dept, source, client, window):
            assert isinstance(client, PoliteClient) and window == WINDOW
            if source.kind == "rss":
                raise NotImplementedError(source.kind)
            if source.kind == "drupal_uis":
                raise RuntimeError("Do not print: Quantum widgets in practice")
            return [
                # The talks.cam talk, linked from the department page.
                record(
                    source_type="dept_ics",
                    source="whatever",
                    external_id="uid-1@widgets.example.org",
                    url="https://widgets.example.org/talks/1",
                    talks_cam_id=2,
                    starts_at=london(2026, 11, 4, 13, 0),
                ),
                record(
                    source_type="dept_ics",
                    source="whatever",
                    external_id="uid-2@widgets.example.org",
                    title="A department-only talk",
                    talks_cam_id=None,
                    starts_at=london(2026, 11, 5, 13, 0),
                ),
                record(
                    source_type="dept_ics",
                    external_id="uid-3@widgets.example.org",
                    title="Long ago",
                    talks_cam_id=None,
                    starts_at=london(2026, 9, 1, 13, 0),
                ),
                record(source_type="talks_cam", external_id="999", talks_cam_id=999),
            ]

        sites(collect)
        net.get(f"{CAM}/robots.txt").respond(404)
        net.get(url__startswith=API).mock(side_effect=fake_api(cam_talks()))
        routes = convex(net)
        ctx = stage_ctx()

        stage.run(ctx, now=NOW)

        (batch,) = bodies(routes["batch"])
        by_id = {t["externalId"]: t for t in batch["talks"]}
        assert set(by_id) == {"1", "2", "uid-2@widgets.example.org"}
        # The talks.cam record won and gained the department.
        assert by_id["2"]["departmentKeys"] == ["dept-widget-studies"]
        assert by_id["2"]["url"] == f"{CAM}/talk/index/2"
        own = by_id["uid-2@widgets.example.org"]
        assert own["source"] == "dept-widget-studies#0"
        assert own["departmentKeys"][0] == "dept-widget-studies"
        assert bodies(routes["sweep"])[0]["sources"] == ["dept-widget-studies#0", "talks_cam"]
        (run,) = bodies(routes["runs"])
        assert run["status"] == "partial"
        assert run["sourcesOk"] == 2 and run["sourcesFailed"] == 1
        assert run["errors"] == ["dept-history#0: RuntimeError"]
        notes = "\n".join(ctx.report.notes)
        assert "dept sources: 1 ok, 1 failed, 1 skipped" in notes
        assert "dept-history#0: failed (RuntimeError)" in notes
        assert "dept sources skipped: 1 no parser for rss" in notes
        assert "1 outside the window" in notes and "1 wrong source type" in notes
        # Notes are counts, keys and exception types — never a source's words.
        payloads = json.dumps(bodies(routes["runs"])) + notes
        for words in ("Quantum widgets", "Gadgets at noon", "Bea Sample", "Do not print"):
            assert words not in payloads

    def test_a_failed_batch_means_no_sweep_and_an_error_run(
        self, stage_ctx, net: respx.MockRouter, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(stage, "SITES_MODULE", "camsocs_pipeline.talks.no_such_sites")
        net.get(f"{CAM}/robots.txt").respond(404)
        net.get(url__startswith=API).mock(side_effect=fake_api(cam_talks()))
        routes = convex(net)
        routes["batch"].mock(return_value=httpx.Response(400, json={"error": "bad talk"}))
        ctx = stage_ctx()

        with pytest.raises(ConvexError):
            stage.run(ctx, now=NOW)

        assert not routes["sweep"].called
        (run,) = bodies(routes["runs"])
        assert run["status"] == "error" and run["errors"] == ["push: ConvexError"]

    def test_an_incomplete_talks_cam_read_is_not_swept(
        self, stage_ctx, net: respx.MockRouter, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(stage, "SITES_MODULE", "camsocs_pipeline.talks.no_such_sites")
        net.get(f"{CAM}/robots.txt").respond(404)
        net.get(url__startswith=API).mock(side_effect=fake_api(cam_talks(), count_offset=1))
        routes = convex(net)
        ctx = stage_ctx()

        stage.run(ctx, now=NOW)

        assert not routes["batch"].called and not routes["sweep"].called
        (run,) = bodies(routes["runs"])
        assert run["status"] == "error" and run["sourcesFailed"] == 1
        assert any("count 3 but 2" in error for error in run["errors"])

    def test_a_dry_run_stages_but_posts_nothing(
        self, stage_ctx, net: respx.MockRouter, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(stage, "SITES_MODULE", "camsocs_pipeline.talks.no_such_sites")
        net.get(f"{CAM}/robots.txt").respond(404)
        net.get(url__startswith=API).mock(side_effect=fake_api(cam_talks()))
        routes = convex(net)
        ctx = stage_ctx(dry_run=True, limit=1)

        stage.run(ctx, now=NOW)

        assert not any(route.called for route in routes.values())
        assert [line["externalId"] for line in staged_lines(ctx)] == ["1", "2"]
        notes = "\n".join(ctx.report.notes)
        assert "1/11 slices, incomplete" in notes and "dry run: 2 talks not posted" in notes

    def test_the_stage_never_reaches_a_model(
        self,
        stage_ctx,
        net: respx.MockRouter,
        monkeypatch: pytest.MonkeyPatch,
        llm_tripwire: list[str],
    ) -> None:
        """Hard rule (AGENTS.md, source-research §6): talks.cam content never
        reaches a model. The whole stage runs, not as a dry run — talks.cam,
        every department parser (one source of each kind, each answering with
        a listing it reads), dedupe, staging, the push — with every way to a
        model wired to fail the test (`llm_tripwire`), on invented data only."""
        monkeypatch.setattr(stage, "load_registry", lambda: TRIPWIRE_REGISTRY)
        net.get(f"{CAM}/robots.txt").respond(200, text=ROBOTS)
        net.get(url__startswith=API).mock(side_effect=fake_api(cam_talks()))
        net.get(f"{DEPT}/robots.txt").respond(404)
        for path, (body, content_type) in TRIPWIRE_PAGES.items():
            net.get(f"{DEPT}{path}").respond(
                200, content=body, headers={"content-type": content_type}
            )
        routes = convex(net)
        ctx = stage_ctx()

        stage.run(ctx, now=NOW)

        assert llm_tripwire == []
        assert not ctx.dry_run and routes["batch"].called
        notes = "\n".join(ctx.report.notes)
        assert "dept sources: 5 ok, 0 failed, 0 skipped" in notes
        # Swept only when read whole with at least one talk: every parser ran
        # and kept something.
        (sweep,) = bodies(routes["sweep"])
        assert sweep["sources"] == [*(f"dept-tripwire#{i}" for i in range(5)), "talks_cam"]

    def test_department_budget_and_limit_skip_sources(self) -> None:
        calls: list[str] = []

        def collect(dept, source, client, window):
            calls.append(dept.key)
            return []

        ticks = iter([0.0, 0.0, 10_000.0, 10_000.0])
        read = stage.read_departments(
            REGISTRY,
            None,
            WINDOW,
            collector=collect,
            clock=lambda: next(ticks),  # type: ignore[arg-type]
        )
        assert [o.status for o in read.outcomes] == ["ok", "skipped", "skipped"]
        assert read.outcomes[1].reason == "time budget"
        limited = stage.read_departments(REGISTRY, None, WINDOW, collector=collect, limit=1)  # type: ignore[arg-type]
        assert [o.reason for o in limited.outcomes] == [None, "--limit", "--limit"]

    def test_an_empty_read_is_never_swept(self) -> None:
        cam = talkscam.TalksCamRead(slices=1, slices_read=1)
        dept = stage.DepartmentRead(outcomes=[stage.SourceOutcome("dept-a#0", "ok", talks=0)])
        assert cam.complete and stage.sweep_sources(cam, dept) == []

    def test_a_partial_talks_cam_read_never_posts_a_second_row_for_a_mirrored_talk(
        self,
    ) -> None:
        slices = talkscam.slices(WINDOW)
        missed = slices[1]
        inside = missed[0] + timedelta(hours=16)
        mirror = record(
            source_type="dept_drupal",
            source="dept-history#0",
            external_id="https://history.example.org/talk/5",
            url="https://history.example.org/talk/5",
            starts_at=inside,
            talks_cam_id=5,
            department_keys=["dept-history"],
        )
        own = record(
            source_type="dept_drupal",
            source="dept-chemistry#0",
            external_id="https://chem.example.org/events/a",
            url="https://chem.example.org/events/a",
            starts_at=inside,
            title="A department talk talks.cam never lists",
            talks_cam_id=None,
            department_keys=["dept-chemistry"],
        )
        outcomes = [
            stage.SourceOutcome("dept-history#0", "ok", talks=1),
            stage.SourceOutcome("dept-chemistry#0", "ok", talks=1),
        ]
        dept = stage.DepartmentRead(records=[mirror, own], outcomes=outcomes)
        # Day 1: talks.cam complete; the mirror copy merges into the talks.cam row.
        day1 = talkscam.TalksCamRead(
            slices=len(slices), slices_read=len(slices), records=[record(talks_cam_id=5)]
        )
        kept, held = stage.hold_unread_mirrors(dept.records, day1)
        assert kept == [mirror, own] and held == set()
        # Day 2: the slice holding the talk failed. The copy is held back (it
        # would post under its own key beside day 1's row) and its source is
        # not swept, so nothing it posted before goes missing.
        day2 = talkscam.TalksCamRead(
            slices=len(slices), slices_read=len(slices) - 1, unread=[missed], errors=["slice 2"]
        )
        kept, held = stage.hold_unread_mirrors(dept.records, day2)
        assert kept == [own] and held == {"dept-history#0"}
        assert stage.sweep_sources(day2, dept, held) == ["dept-chemistry#0"]

    def test_the_hook_is_optional_but_a_broken_one_fails(
        self, monkeypatch: pytest.MonkeyPatch, sites
    ) -> None:
        monkeypatch.setattr(stage, "SITES_MODULE", "camsocs_pipeline.talks.no_such_sites")
        assert stage.load_site_collector()[1] == "skipped"
        monkeypatch.setattr(stage, "SITES_MODULE", "camsocs_pipeline.talks.sites")
        sites(None)
        assert stage.load_site_collector()[1:] == ("failed", "talks.sites has no collect()")


# --- the zero-LLM rule and retention ----------------------------------------------------------


def test_no_talk_source_ever_reaches_a_model() -> None:
    assert set(SOURCE_TYPES) <= NO_LLM_SOURCE_TYPES
    gate = AiGate(client=None)
    for source_type in SOURCE_TYPES:
        assert gate.verdict("https://widgets.example.org/talks", source_type) == "refused"
        with pytest.raises(NoLLMSource):
            llm_field(
                "description",
                "x",
                quote="x",
                source_text="x",
                source_type=source_type,
                model="gpt-6-luna",
                prompt_version="v1",
                evidence="primary",
            )


def test_prune_keeps_the_latest_talks_staging_file(tmp_path: Path) -> None:
    import os

    folder = tmp_path / "talks"
    folder.mkdir()
    old = datetime(2026, 1, 1, tzinfo=UTC).timestamp()
    for name in ("20260101T000000Z-aaaaaa.jsonl", "20260102T000000Z-bbbbbb.jsonl"):
        (folder / name).write_text("{}\n")
        os.utime(folder / name, (old, old))
    result = prune_staging(tmp_path, timedelta(days=90), now=NOW)
    assert [p.name for p in folder.iterdir()] == ["20260102T000000Z-bbbbbb.jsonl"]
    assert result.files["staging"] == 1
