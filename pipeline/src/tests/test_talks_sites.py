"""Department-site talk collectors (talks/sites/, spec §2–§3) over pages
recorded from department sites on 2026-10-31 (fixtures/talks/), and the
verified department registry. Offline: a fake client serves the fixtures."""

from __future__ import annotations

import json
import re
from dataclasses import replace
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from urllib.parse import urlsplit

import pytest

from camsocs_pipeline.claims import NO_LLM_SOURCE_TYPES
from camsocs_pipeline.events.common import LONDON, default_window
from camsocs_pipeline.sources.base import FetchResult
from camsocs_pipeline.talks import sites, verify
from camsocs_pipeline.talks.mapping import DepartmentMapper
from camsocs_pipeline.talks.model import TalkRecord
from camsocs_pipeline.talks.registry import (
    SOURCE_KINDS,
    Department,
    DepartmentSource,
    load_registry,
)
from camsocs_pipeline.talks.sites import drupal_uis, json_api, jsonld, rss
from camsocs_pipeline.talks.sites.common import (
    SourceError,
    mirrored_talks_cam_id,
    parse_when,
    series_of,
    speakers_from,
)
from camsocs_pipeline.talks.sites.filters import (
    is_cancelled,
    is_elsewhere,
    is_online,
    is_talk,
    talk_kind,
)

FIXTURES = Path(__file__).parent / "fixtures" / "talks"
NOW = datetime(2026, 10, 31, 12, 0, tzinfo=UTC)
WINDOW = default_window(NOW)
TODAY = date(2026, 10, 31)


def fixture(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def text(name: str) -> str:
    return fixture(name).decode("utf-8")


def london(*args: int) -> datetime:
    return datetime(*args, tzinfo=LONDON)


class FakeClient:
    """Serves `pages` (URL → (body, content type)); anything else is a 404."""

    def __init__(self, pages: dict[str, tuple[bytes, str]]) -> None:
        self.pages = pages
        self.fetched: list[str] = []

    def fetch(self, url: str, **_kwargs: object) -> FetchResult:
        self.fetched.append(url)
        stamp = NOW.isoformat()
        if url not in self.pages:
            return FetchResult(url, url, "not_found", 404, stamp)
        body, content_type = self.pages[url]
        return FetchResult(url, url, "fetched", 200, stamp, body, content_type)


def dept(*sources: DepartmentSource, school: str = "biological_sciences") -> Department:
    return Department(
        key="dept-zoology",
        slug="zoology",
        name="Department of Zoology",
        short_name="Zoology",
        school=school,
        website="https://www.zoo.cam.ac.uk",
        sources=sources,
    )


def source(kind: str, url: str) -> DepartmentSource:
    return DepartmentSource(kind=kind, url=url, label="Events", checked="2026-10-31")


# --- dates in words ------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("line", "start", "end", "all_day"),
    [
        (
            "5 November 2026 * 1:00pm to 2:00pm",
            london(2026, 11, 5, 13),
            london(2026, 11, 5, 14),
            False,
        ),
        (
            "Monday, 2 November, 2026 - 13:05 to 13:55",
            london(2026, 11, 2, 13, 5),
            london(2026, 11, 2, 13, 55),
            False,
        ),
        ("Nov 3rd 2026 — 14:00 to 15:00", london(2026, 11, 3, 14), london(2026, 11, 3, 15), False),
        (
            "November 18, 2026 at 4:00 pm - 5:00 pm",
            london(2026, 11, 18, 16),
            london(2026, 11, 18, 17),
            False,
        ),
        (
            "Friday, 30 October 2026 2:00pm – 3:00pm",
            london(2026, 10, 30, 14),
            london(2026, 10, 30, 15),
            False,
        ),
        ("3 Nov 26 - 10:00", london(2026, 11, 3, 10), None, False),
        ("02/11/2026 4.15pm", london(2026, 11, 2, 16, 15), None, False),
        ("24 October 2026 to 1 November 2026", london(2026, 10, 24), london(2026, 11, 2), True),
        ("12 November, 6 - 8pm", london(2026, 11, 12, 18), london(2026, 11, 12, 20), False),
    ],
)
def test_dates_written_out(line: str, start: datetime, end: datetime | None, all_day: bool) -> None:
    assert parse_when(line, today=TODAY) == (start, end, all_day)


@pytest.mark.parametrize(
    ("line", "start", "end"),
    [
        ("5 November 2026 Room 2.14 4pm", london(2026, 11, 5, 16), None),
        ("5 November 2026 Room 12.30 at 16:00", london(2026, 11, 5, 16), None),
        ("5 November 2026 Python 3.12 talk 5pm", london(2026, 11, 5, 17), None),
        ("5 November 2026 Room 2 - 4pm", london(2026, 11, 5, 16), None),
        ("5 November 2026, Lecture Theatre 1, 4:00pm", london(2026, 11, 5, 16), None),
        ("5 November 2026 Event LocationRoom 12.30 Event Time4pm", london(2026, 11, 5, 16), None),
        ("5 November 2026 MR2 2.15pm", london(2026, 11, 5, 14, 15), None),
        # An hour below 7 without am/pm is in the afternoon.
        ("5 November 2026 LT1 1.30", london(2026, 11, 5, 13, 30), None),
        ("5 November 2026 1.00 - 2.00", london(2026, 11, 5, 13), london(2026, 11, 5, 14)),
        ("5 November 2026 6.30 - 8.00", london(2026, 11, 5, 18, 30), london(2026, 11, 5, 20)),
        ("9 Nov 2026 19.30 - 20.45", london(2026, 11, 9, 19, 30), london(2026, 11, 9, 20, 45)),
        ("5 November 2026 9.30", london(2026, 11, 5, 9, 30), None),
    ],
)
def test_room_and_version_numbers_are_not_times(
    line: str, start: datetime, end: datetime | None
) -> None:
    assert parse_when(line, today=TODAY) == (start, end, False)


def test_a_room_number_alone_leaves_the_day_all_day() -> None:
    # No time: all day, so the detail page is read for the time.
    assert parse_when("Thursday 5 November 2026, Seminar Room 2.14", today=TODAY) == (
        london(2026, 11, 5),
        london(2026, 11, 6),
        True,
    )


def test_a_views_row_with_the_room_before_the_time() -> None:
    row = (
        '<main><div class="views-row"><h3><a href="/events/a-talk">A seminar on widgets</a></h3>'
        "<span>6 November 2026</span><span>Room 2.14</span><span>4pm</span></div></main>"
    )
    _, (item,) = drupal_uis.parse_listing(row, "https://www.zoo.cam.ac.uk/events", TODAY)
    assert (item.starts_at, item.all_day) == (london(2026, 11, 6, 16), False)


def test_a_yearless_date_needs_the_day_it_was_read() -> None:
    assert parse_when("12 November, 6pm") is None
    # Read in late October, "12 January" is the coming January.
    assert parse_when("12 January, 6pm", today=TODAY) == (london(2027, 1, 12, 18), None, False)


def test_a_time_after_midnight_in_the_clock_change_week_keeps_its_wall_time() -> None:
    # 25 October 2026 is the clock change; London wall time, not a fixed offset.
    start, _, _ = parse_when("26 October 2026, 5pm") or (None, None, None)
    assert start == london(2026, 10, 26, 17) and start.utcoffset().total_seconds() == 0


# --- the talk filter -------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("title", "categories", "mixed", "kept"),
    [
        ("Zoology Department Seminar: The internet of animals", [], False, True),
        ("Bat and rodent virus discovery in natural history museum collections", [], False, True),
        ("Bat and rodent virus discovery in natural history museum collections", [], True, False),
        ("Virtual Postgraduate Open Day", [], False, False),
        ("Antarctica Live! - Online lesson for schools", [], False, False),
        ("Curator's talk: Exhibition of Arctic maps", [], True, True),
        ("Family Fun Day", [], True, False),
        ("Preparing Kids for Capitalism", ["Macroeconomics Seminars"], False, True),
        ("Cambridge MBA profile review", ["MBA admissions events"], False, False),
        ("Christmas concert", [], False, False),
    ],
)
def test_which_items_are_talks(title: str, categories: list[str], mixed: bool, kept: bool) -> None:
    assert is_talk(title, categories, require_keyword=mixed) is kept


def test_kinds_cancellations_and_online() -> None:
    assert talk_kind("Annual Symposium on Language") == "conference"
    assert talk_kind("Methods workshop: text mining") == "workshop"
    assert talk_kind("The Wheeler Lecture 2026") == "lecture"
    assert talk_kind("Cosmology Lunch: peculiar velocities") == "seminar"
    assert talk_kind("Kate Briggs in Conversation with Louis Klee") == "other"
    assert is_cancelled("CANCELLED: Theory Workshop")
    assert is_cancelled("Theory Workshop (postponed)")
    assert not is_cancelled("Cancellation in quantum error correction")
    assert is_online("MR14 and online") and not is_online("Part II Lecture Theatre")
    assert is_elsewhere("Antalya, Türkiye") and is_elsewhere("Johannesburg, South Africa")
    assert not is_elsewhere("Cambridge, UK") and not is_elsewhere("London Road, Cambridge")
    assert not is_elsewhere("Hoyle Lecture Theatre") and not is_elsewhere(None)


def test_series_and_speakers() -> None:
    assert series_of("Zoology Department Seminar: The internet of animals") == (
        "Zoology Department Seminar"
    )
    assert series_of("The Origins of Guanzhui bian: Genetic Insights") is None
    assert speakers_from("Yan-Chuan Cai (University of Edinburgh)") == [
        {"name": "Yan-Chuan Cai", "affiliation": "University of Edinburgh"}
    ]
    assert speakers_from("Ryutaro Ohira, QuEL, Inc.") == [
        {"name": "Ryutaro Ohira", "affiliation": "QuEL, Inc."}
    ]


# --- drupal_uis: the three listing shapes -------------------------------------------------------


def test_uis_cards_give_date_time_and_venue() -> None:
    shape, items = drupal_uis.parse_listing(
        text("uis_listing_zoology.html"), "https://www.zoo.cam.ac.uk/events", TODAY
    )
    assert shape == "tailwind"
    assert [(i.starts_at, i.ends_at) for i in items] == [
        (london(2026, 11, 5, 13), london(2026, 11, 5, 14)),
        (london(2026, 11, 12, 13), london(2026, 11, 12, 14)),
    ]
    first = items[0]
    assert first.title.startswith("Zoology Department Seminar: Bat and rodent virus discovery")
    assert first.venue == "Part II Lecture Theatre, Department of Zoology"
    assert first.url.startswith("https://www.zoo.cam.ac.uk/events/zoology-department-seminar-bat")


def _cards(base: str, days: list[date], page: int, last: int) -> bytes:
    """A synthetic tailwind listing page: one seminar card per day."""
    cards = "".join(
        f'<a class="card-link" href="/events/seminar-{day.isoformat()}">'
        f'<h3 data-testid="card-heading">Department Seminar: invented talk {day.isoformat()}</h3>'
        f'<p data-testid="card-subheading">{day.day} {day:%B %Y} * 1:00pm to 2:00pm</p></a>'
        for day in days
    )
    pager = f'<a rel="next" href="{base}?page={page + 1}">Next</a>' if page < last else ""
    return f"<html><body><main>{cards}{pager}</main></body></html>".encode()


def _paged(base: str, pages: list[list[date]]) -> dict[str, tuple[bytes, str]]:
    last = len(pages) - 1
    return {
        (base if n == 0 else f"{base}?page={n}"): (_cards(base, days, n, last), "text/html")
        for n, days in enumerate(pages)
    }


def test_an_ascending_listing_that_starts_in_the_past_is_read_on() -> None:
    base = "https://www.zoo.cam.ac.uk/events"
    past = [date(2026, 10, d) for d in range(10, 15)]
    november = [date(2026, 11, d) for d in range(2, 12)]
    client = FakeClient(_paged(base, [past, november[:5], november[5:]]))
    zoology = dept(source("drupal_uis", base))
    read = sites.read(zoology, zoology.sources[0], client, WINDOW)
    assert [u for u in client.fetched if "/events/" not in u] == [
        base,
        f"{base}?page=1",
        f"{base}?page=2",
    ]
    assert len(read.records) == 10 and read.dropped["outside the window"] == 5


def test_a_newest_first_archive_stops_at_its_first_past_page() -> None:
    base = "https://www.zoo.cam.ac.uk/events"
    past = [date(2026, 10, d) for d in range(14, 9, -1)]
    older = [date(2026, 9, d) for d in range(14, 9, -1)]
    client = FakeClient(_paged(base, [past, older]))
    zoology = dept(source("drupal_uis", base))
    read = sites.read(zoology, zoology.sources[0], client, WINDOW)
    assert [u for u in client.fetched if "/events/" not in u] == [base]
    assert read.records == []


def test_an_ascending_listing_stops_past_the_window_and_notes_the_page_cap() -> None:
    base = "https://www.zoo.cam.ac.uk/events"
    inside = [date(2026, 11, 2), date(2026, 11, 3)]
    beyond = [date(2027, 3, 1), date(2027, 3, 2)]
    client = FakeClient(_paged(base, [inside, beyond, [date(2027, 3, 3), date(2027, 3, 4)]]))
    zoology = dept(source("drupal_uis", base))
    sites.read(zoology, zoology.sources[0], client, WINDOW)
    assert [u for u in client.fetched if "/events/" not in u] == [base, f"{base}?page=1"]
    days = [date(2026, 11, 2) + timedelta(days=n) for n in range(2 * 9)]
    many = FakeClient(_paged(base, [days[n : n + 2] for n in range(0, len(days), 2)]))
    read = sites.read(zoology, zoology.sources[0], many, WINDOW)
    assert any("page cap" in note for note in read.notes)


class CachingClient:
    """A client with the polite client's cache rules (`fresh_for`, `cached`),
    whose clock the test moves."""

    def __init__(self, pages: dict[str, tuple[bytes, str]], now: datetime) -> None:
        self.pages = pages
        self.now = now
        self.cache: dict[str, FetchResult] = {}

    def fetch(self, url: str, *, fresh_for: timedelta | None = None, **_: object) -> FetchResult:
        hit = self.cache.get(url)
        if fresh_for and hit and self.now - datetime.fromisoformat(hit.fetched_at) < fresh_for:
            return replace(hit, from_cache=True)
        body, content_type = self.pages[url]
        result = FetchResult(url, url, "fetched", 200, self.now.isoformat(), body, content_type)
        self.cache[url] = result
        return result

    def cached(self, url: str) -> FetchResult | None:
        return self.cache.get(url)


def test_a_feed_longer_than_the_detail_cap_is_covered_over_daily_runs() -> None:
    base = "https://www.zoo.cam.ac.uk/events"
    days = [date(2026, 11, 2) + timedelta(days=n % 30) for n in range(50)]
    cards = "".join(
        f'<a class="card-link" href="/events/seminar-{n}">'
        f'<h3 data-testid="card-heading">Department Seminar: invented talk {n}</h3></a>'
        for n in range(50)
    )
    pages = {base: (f"<html><body><main>{cards}</main></body></html>".encode(), "text/html")}
    for n, day in enumerate(days):
        page = f'<main><time datetime="{day}T13:00:00">{day}</time></main>'
        pages[f"{base}/seminar-{n}"] = (f"<html><body>{page}</body></html>".encode(), "text/html")
    zoology = dept(source("drupal_uis", base))
    # Four daily runs ending now: the cache ages are real (`DETAIL_STALE`).
    client = CachingClient(pages, datetime.now(UTC) - timedelta(days=3))
    counts = []
    for _run in range(4):
        counts.append(len(sites.read(zoology, zoology.sources[0], client, WINDOW).records))
        client.now += timedelta(days=1, minutes=5)
    assert counts == [40, 50, 50, 50]


def test_uis_pager_and_repeated_cards() -> None:
    html = text("uis_listing_ames_page0.html")
    base = "https://www.ames.cam.ac.uk/events"
    _, items = drupal_uis.parse_listing(html, base, TODAY)
    # The page lists one seminar under two URLs (``…-corpus-based`` and ``…-0``).
    assert len(items) == 3 and items[1].title == items[2].title
    nxt = drupal_uis.next_page(html, base, 0)
    assert nxt is not None and nxt.startswith(base) and nxt.endswith("page=1")
    pages = {base: (fixture("uis_listing_ames_page0.html"), "text/html")}
    ames = replace(dept(source("drupal_uis", base), school="arts_humanities"), key="dept-ames")
    # Page 2 cannot be read: the source was not read completely (no sweep).
    with pytest.raises(SourceError):
        sites.collect(ames, ames.sources[0], FakeClient(pages), WINDOW)
    pages[nxt] = (b"<html><body><main><p>No more events.</p></main></body></html>", "text/html")
    client = FakeClient(pages)
    records = sites.collect(ames, ames.sources[0], client, WINDOW)
    assert len(records) == 2 and client.fetched.count(nxt) == 1


def test_uis_detail_page_json_ld_and_prose() -> None:
    detail = jsonld.read_detail(
        text("uis_detail_zoology.html"),
        "https://www.zoo.cam.ac.uk/events/zoology-department-seminar-internet-animals",
    )
    assert (detail.starts_at, detail.ends_at) == (london(2027, 2, 18, 13), london(2027, 2, 18, 14))
    assert detail.title == "Zoology Department Seminar: The internet of animals"
    assert detail.abstract and "Internet of Animals" in detail.abstract
    # The page links a talks.cam *list*, not a talk: no talk id.
    assert detail.talks_cam_id is None


def test_ucam_talks_mirrors_carry_the_talks_cam_id() -> None:
    # Synthetic mirror pages: real talks.cam content must never reach a model
    # (spec §1), so these fixtures are invented in the mirrors' markup.
    shape, items = drupal_uis.parse_listing(
        text("ucam_talks_damtp.html"), "https://www.damtp.cam.ac.uk/events", date(2026, 11, 1)
    )
    assert shape == "ucam_talks"
    assert [i.talks_cam_id for i in items] == [900001, 900002]
    first = items[0]
    assert first.title == "An invented seminar on fluid flows"
    assert first.starts_at.isoformat() == "2026-11-04T14:00:00+00:00"
    assert first.venue == "Example Room MR2"
    assert [s["name"] for s in first.speakers] == ["Alex Example"]
    shape, items = drupal_uis.parse_listing(
        text("ucam_talks_chemistry.html"),
        "https://www.ch.cam.ac.uk/events",
        date(2026, 11, 1),
    )
    assert shape == "ucam_talks"
    assert [i.talks_cam_id for i in items] == [900003]
    assert items[0].url == "https://www.ch.cam.ac.uk/talk/900003"


def test_views_rows_read_rdfa_time_and_labelled_fields() -> None:
    shape, cst = drupal_uis.parse_listing(
        text("views_cst_seminars.html"), "https://www.cst.cam.ac.uk/seminars", TODAY
    )
    assert shape == "views"
    assert cst[0].starts_at == datetime(2026, 11, 2, 13, 5, tzinfo=UTC)
    assert cst[0].talks_cam_id == 900101
    assert cst[0].series == "Invented Systems Talks"
    assert cst[0].speakers == [
        {"name": "Sam Placeholder", "affiliation": "Example Institute of Computing"}
    ]
    _, econ = drupal_uis.parse_listing(
        text("views_econ_seminars.html"), "https://www.econ.cam.ac.uk/seminars/upcoming", TODAY
    )
    first = econ[0]
    assert first.title.startswith("The Parental Investment Rat Race")
    assert first.speakers == [{"name": "Hyunjae Kang", "affiliation": "Kyoto University"}]
    assert first.venue == "Meade Room"
    assert first.series == "Empirical Microeconomics Seminars"
    assert (first.starts_at, first.ends_at) == (
        datetime(2026, 11, 2, 13, tzinfo=UTC),
        datetime(2026, 11, 2, 14, tzinfo=UTC),
    )
    _, janeway = drupal_uis.parse_listing(
        text("views_janeway.html"), "https://www.janeway.econ.cam.ac.uk/seminars-talks", TODAY
    )
    assert (janeway[0].starts_at, janeway[0].ends_at) == (
        london(2026, 10, 30, 14),
        london(2026, 10, 30, 15),
    )
    assert janeway[0].venue == "Keynes Room, Faculty of Economics"


def test_article_teasers_skip_their_wrapper_and_keep_type_labels() -> None:
    base = "https://www.murrayedwards.cam.ac.uk/news-events/upcoming-events"
    shape, items = drupal_uis.parse_listing(text("articles_murray_edwards.html"), base, TODAY)
    assert shape == "articles"
    assert [i.title for i in items][:2] == [
        "AI, Art and Morality",
        "Feminism, Disability Access & AI",
    ]
    assert (items[0].starts_at, items[0].ends_at) == (
        london(2026, 11, 3, 17, 30),
        london(2026, 11, 3, 18, 30),
    )
    assert items[0].categories == ["Talk"]
    college = replace(
        dept(source("drupal_uis", base), school="other"),
        key="dept-murray-edwards-college",
        name="Murray Edwards College",
    )
    client = FakeClient({base: (fixture("articles_murray_edwards.html"), "text/html")})
    read = sites.read(college, college.sources[0], client, WINDOW)
    # A college listing needs a talk word: the "Talk" label gives it.
    assert [r.title for r in read.records][:2] == [i.title for i in items][:2]


#: A link that only a talks.cam mirror's own page carries: CST's
#: ``/seminars/list/<id>``, the ucam_talks module's ``/talk/<id>``.
_MIRROR_LINK = re.compile(r"/seminars/list/\d+|/(?:research/)?talk/\d+\b|talks\.cam\.ac\.uk/talk/")


def test_fixtures_that_carry_a_talks_cam_mirror_link_are_synthetic() -> None:
    """A mirror page holds talks.cam text, which must never be recorded here
    (spec §1): such a fixture is written by hand and says so."""
    readme = (FIXTURES / "README.md").read_text(encoding="utf-8")
    for path in sorted(FIXTURES.iterdir()):
        if path.name == "README.md":
            continue
        body = path.read_text(encoding="utf-8", errors="replace")
        if not _MIRROR_LINK.search(body):
            continue
        assert "Synthetic fixture" in body[:600], path.name
        row = next(line for line in readme.splitlines() if f"`{path.name}`" in line)
        assert "synthetic" in row.lower(), path.name


def test_one_source_keeps_distinct_placeholder_talks_at_one_minute() -> None:
    def record(n: int, title: str, talks_cam_id: int | None) -> TalkRecord:
        return TalkRecord(
            source_type="dept_drupal",
            source="dept-zoology#0",
            external_id=f"https://www.zoo.cam.ac.uk/events/{n}",
            url=f"https://www.zoo.cam.ac.uk/events/{n}",
            source_url="https://www.zoo.cam.ac.uk/events",
            title=title,
            starts_at=london(2026, 11, 5, 16),
            retrieved_at=NOW,
            talks_cam_id=talks_cam_id,
        )

    placeholders = [record(n, "Title TBA", 1000 + n) for n in range(3)]
    assert len(sites._unique(placeholders)) == 3
    # Two talks.cam talks with one real title at one minute are two talks.
    title = "Widgets in the wild"
    assert len(sites._unique([record(1, title, 1), record(2, title, 2)])) == 2
    # One talk under two URLs (AMES) is still one.
    assert len(sites._unique([record(1, title, None), record(2, title, None)])) == 1
    assert len(sites._unique([record(1, title, 7), record(2, title, None)])) == 1


def test_mirror_urls() -> None:
    assert mirrored_talks_cam_id("https://www.cst.cam.ac.uk/seminars/list/900101") == 900101
    assert mirrored_talks_cam_id("https://www.ch.cam.ac.uk/talk/273598") == 273598
    assert mirrored_talks_cam_id("https://www.example.org/seminars/list/1") is None


# --- rss ---------------------------------------------------------------------------------------


def test_a_drupal_feed_dates_items_in_its_description() -> None:
    elements = rss.feed_items(fixture("rss_cst_seminars.xml"))
    item, _ = rss.parse_item(elements[0], "https://www.cst.cam.ac.uk/seminars/feed", NOW)
    assert item is not None
    assert (item.starts_at, item.ends_at) == (
        datetime(2026, 11, 2, 13, 5, tzinfo=UTC),
        datetime(2026, 11, 2, 13, 55, tzinfo=UTC),
    )
    assert item.talks_cam_id == 900101


def test_a_past_pubdate_is_a_post_date_and_a_future_one_an_event() -> None:
    elements = rss.feed_items(fixture("rss_cms_events.xml"))
    feed = "https://cms.mus.cam.ac.uk/events/index.xml"
    item, link = rss.parse_item(elements[0], feed, NOW)
    assert item is None and link == "https://cms.mus.cam.ac.uk/events/2026-safiyyah-nawaz/"
    earlier = datetime(2026, 10, 1, tzinfo=UTC)
    item, _ = rss.parse_item(elements[0], feed, earlier)
    assert item is not None and item.starts_at == datetime(2026, 10, 30, 14, 30, tzinfo=UTC)


def test_law_feed_items_are_dated_from_their_pages() -> None:
    feed = "https://www.law.cam.ac.uk/press/events/feed.xml/10"
    first = "https://www.law.cam.ac.uk/press/events/2026/11/cels-lunchtime-seminar-social-pathology-eu-law"
    client = FakeClient(
        {
            feed: (fixture("rss_law_events.xml"), "application/rss+xml"),
            first: (fixture("law_detail.html"), "text/html"),
        }
    )
    law = replace(dept(source("rss", feed), school="humanities_social_sciences"), key="dept-law")
    read = sites.read(law, law.sources[0], client, WINDOW)
    assert [r.url for r in read.records] == [first]
    talk = read.records[0]
    assert talk.starts_at == datetime(2026, 11, 4, 13, tzinfo=UTC)
    assert talk.venue == "Faculty of Law, B16"
    assert talk.title == "CELS Lunchtime Seminar: 'Social Pathology in EU law'"
    assert talk.speakers[0].name == "Dr Ana Bobić"
    assert talk.source_type == "dept_rss" and talk.source == "dept-law#0"
    # The second item's page is missing: it is dropped, and the read noted it.
    assert read.dropped == {"no event date": 1} and len(read.notes) == 1


# --- ics and json -----------------------------------------------------------------------------


def test_ics_feed_school_lessons_and_exhibitions_are_not_talks() -> None:
    url = "https://www.bas.ac.uk/events/list/?ical=1"
    client = FakeClient({url: (fixture("ics_bas_events.ics"), "text/calendar")})
    bas = dept(source("ics", url), school="other")
    read = sites.read(bas, bas.sources[0], client, WINDOW)
    # "Online lesson for schools" by its title, "Ice Station RGS" by its category.
    assert read.dropped == {"not a talk": 2} and read.records == []


SEMINAR_ICS = b"""BEGIN:VCALENDAR\r
VERSION:2.0\r
BEGIN:VEVENT\r
UID:42@example.org\r
DTSTART:20261110T160000\r
DTEND:20261110T170000\r
SUMMARY:Polar Oceans Seminar: Sea ice in a warming world\r
LOCATION:Aurora Innovation Centre\r
DESCRIPTION:See https://talks.cam.ac.uk/talk/index/271234 for details.\r
CATEGORIES:Seminar\r
STATUS:CANCELLED\r
END:VEVENT\r
END:VCALENDAR\r
"""


def test_ics_floating_times_are_london_and_status_cancels() -> None:
    url = "https://www.bas.ac.uk/events/list/?ical=1"
    bas = dept(source("ics", url), school="other")
    read = sites.read(
        bas, bas.sources[0], FakeClient({url: (SEMINAR_ICS, "text/calendar")}), WINDOW
    )
    [talk] = read.records
    assert (talk.starts_at, talk.ends_at) == (london(2026, 11, 10, 16), london(2026, 11, 10, 17))
    assert talk.cancelled and talk.talks_cam_id == 271234 and talk.kind == "seminar"
    assert talk.source_type == "dept_ics" and talk.venue == "Aurora Innovation Centre"


def test_json_shapes() -> None:
    shape, tribe = json_api.parse_payload(
        json.loads(fixture("json_tribe_neuroscience.json")),
        "https://neuroscience.cam.ac.uk/wp-json/tribe/events/v1/events",
    )
    assert shape == "tribe" and tribe[0].starts_at == london(2026, 11, 4, 18)
    assert tribe[0].title.startswith("Neurotechnology and the Future of Thought")
    shape, aicam = json_api.parse_payload(
        json.loads(fixture("json_aicam_events.json")), "https://www.ai.cam.ac.uk/events.json"
    )
    assert shape == "dated_array" and aicam[0].all_day
    assert aicam[0].url == "https://www.ai.cam.ac.uk/events/ai-for-science-summit-2026/"
    shape, cjbs = json_api.parse_payload(
        json.loads(fixture("json_cjbs_search.json")),
        "https://www.jbs.cam.ac.uk/wp-json/cjbs-event/v1/search?pagination=1",
    )
    assert shape == "cjbs" and cjbs[1].starts_at == london(2026, 11, 2, 12, 30)
    assert cjbs[1].ends_at == london(2026, 11, 2, 13, 30)
    with pytest.raises(ValueError):
        json_api.parse_payload([{"id": 1, "date": "2026-10-01"}], "https://x.example.org/")


def test_judge_admissions_events_are_not_talks() -> None:
    url = "https://www.jbs.cam.ac.uk/wp-json/cjbs-event/v1/search?pagination=1"
    data = json.loads(fixture("json_cjbs_search.json"))
    data["pages"] = 1
    client = FakeClient({url: (json.dumps(data).encode(), "application/json")})
    jbs = dept(source("json_api", url), school="technology")
    read = sites.read(jbs, jbs.sources[0], client, WINDOW)
    assert read.dropped.get("not a talk", 0) >= 1
    assert all("MBA" not in r.title for r in read.records)


# --- collect(): the hook -------------------------------------------------------------------


def test_collect_reads_listing_then_detail_pages() -> None:
    listing = "https://www.zoo.cam.ac.uk/events"
    first = (
        "https://www.zoo.cam.ac.uk/events/zoology-department-seminar-bat-and-rodent-virus"
        "-discovery-natural-history-museum-collections"
    )
    client = FakeClient(
        {
            listing: (fixture("uis_listing_zoology.html"), "text/html"),
            first: (fixture("uis_detail_zoology.html"), "text/html"),
        }
    )
    zoology = dept(source("drupal_uis", listing))
    window = default_window(NOW, horizon_days=120)
    records = sites.collect(zoology, zoology.sources[0], client, window)
    assert len(records) == 2
    talk = records[0]
    assert talk.source_type == "dept_drupal"
    assert talk.source == "dept-zoology#0"
    assert talk.department_keys == ["dept-zoology"]
    assert talk.series == "Zoology Department Seminar"
    # The detail page (recorded for another seminar) supplies its JSON-LD times.
    assert talk.starts_at == london(2027, 2, 18, 13)
    assert talk.abstract and "Departmental Seminars" in talk.abstract
    # The second card's page is missing: the card alone still makes a talk.
    assert records[1].starts_at == london(2026, 11, 12, 13) and records[1].abstract is None
    assert all(urlsplit(u).netloc == "www.zoo.cam.ac.uk" for u in client.fetched)
    wire = talk.to_wire()
    assert wire["sourceType"] == "dept_drupal" and wire["kind"] == "seminar"


def test_a_failed_listing_raises_and_an_unknown_kind_is_not_implemented() -> None:
    zoology = dept(source("drupal_uis", "https://www.zoo.cam.ac.uk/events"))
    with pytest.raises(SourceError):
        sites.collect(zoology, zoology.sources[0], FakeClient({}), WINDOW)
    odd = dept(source("termcard", "https://www.zoo.cam.ac.uk/termcard"))
    with pytest.raises(NotImplementedError):
        sites.collect(odd, odd.sources[0], FakeClient({}), WINDOW)


def test_verify_reports_counts_only() -> None:
    listing = "https://www.zoo.cam.ac.uk/events"
    client = FakeClient({listing: (fixture("uis_listing_zoology.html"), "text/html")})
    zoology = dept(source("drupal_uis", listing), source("rss", "https://www.zoo.cam.ac.uk/feed"))
    checks = verify.verify([zoology], client, now=NOW, workers=1)
    assert [c.status for c in checks] == ["ok", "error"]
    line = checks[0].line()
    assert line.startswith("dept-zoology#0 drupal_uis ok upcoming=2")
    assert "Bat and rodent" not in line and "Part II" not in line
    assert "not_found 404" in (checks[1].error or "")


# --- the registry and the AI gate --------------------------------------------------------------


def test_the_registry_is_valid_and_only_lists_readable_sources() -> None:
    registry = load_registry()
    assert len(registry) >= 100
    assert set(sites.PARSERS) == set(SOURCE_KINDS)
    banned = ("talks.cam.ac.uk", "calendar.google.com", "events.cam.ac.uk", "webservices.admin")
    for department in registry:
        assert department.sources or department.talks_cam_list_ids, department.key
        for src in department.sources:
            assert src.checked == "2026-10-31", department.key
            assert not any(b in src.url for b in banned), src.url
    schools = {d.school for d in registry}
    assert schools == {
        "arts_humanities",
        "humanities_social_sciences",
        "biological_sciences",
        "clinical_medicine",
        "physical_sciences",
        "technology",
        "other",
    }


def test_every_talk_source_type_is_refused_by_the_ai_gate() -> None:
    assert sites.SITE_SOURCE_TYPES <= NO_LLM_SOURCE_TYPES
    assert "talks_cam" in NO_LLM_SOURCE_TYPES


# --- review fixes ----------------------------------------------------------------------------


def test_json_ld_listing_items_without_their_own_url_stay_apart() -> None:
    listing = "https://www.example.cam.ac.uk/seminars"
    events = [
        {"@type": "Event", "name": "Seminar: one", "startDate": "2026-11-04T13:00:00"},
        {"@type": "Event", "name": "Seminar: two", "startDate": "2026-11-11T13:00:00"},
        {
            "@type": "Event",
            "name": "Seminar: three",
            "url": "/seminars/three",
            "startDate": "2026-11-18T13:00:00",
        },
    ]
    script = f'<script type="application/ld+json">{json.dumps(events)}</script>'
    page = f"<html><head>{script}</head><body></body></html>"
    client = FakeClient({listing: (page.encode(), "text/html")})
    unit = dept(source("json_ld", listing))
    records = sites.collect(unit, unit.sources[0], client, WINDOW)
    assert [r.title for r in records] == ["Seminar: one", "Seminar: two", "Seminar: three"]
    assert len({r.key for r in records}) == 3
    assert records[2].url == "https://www.example.cam.ac.uk/seminars/three"


def test_a_date_only_feed_event_is_all_day() -> None:
    feed = (
        b'<rss version="2.0" xmlns:ev="http://purl.org/rss/1.0/modules/event/"><channel>'
        b"<item><title>Annual lecture</title><link>https://www.example.cam.ac.uk/e/1</link>"
        b"<ev:startdate>2026-11-05</ev:startdate><ev:enddate>2026-11-06</ev:enddate></item>"
        b"</channel></rss>"
    )
    item, _ = rss.parse_item(rss.feed_items(feed)[0], "https://www.example.cam.ac.uk/feed", NOW)
    assert item is not None and item.all_day
    assert item.starts_at == london(2026, 11, 5)
    assert item.ends_at == london(2026, 11, 7)


def test_detail_pages_follow_a_listing_that_redirected_to_another_host() -> None:
    listing = "https://zoo.cam.ac.uk/events"
    moved = "https://www.zoo.cam.ac.uk/events"
    detail = (
        "https://www.zoo.cam.ac.uk/events/zoology-department-seminar-bat-and-rodent-virus"
        "-discovery-natural-history-museum-collections"
    )

    class Redirecting(FakeClient):
        def fetch(self, url: str, **kwargs: object) -> FetchResult:
            result = super().fetch(moved if url == listing else url, **kwargs)
            return replace(result, url=url) if url == listing else result

    client = Redirecting(
        {
            moved: (fixture("uis_listing_zoology.html"), "text/html"),
            detail: (fixture("uis_detail_zoology.html"), "text/html"),
        }
    )
    unit = dept(source("drupal_uis", listing))
    window = default_window(NOW, horizon_days=120)
    sites.collect(unit, unit.sources[0], client, window)
    assert detail in client.fetched


def test_cambridge_venues_named_after_other_places_are_kept() -> None:
    assert not is_elsewhere("Ancient India & Iran Trust, 23 Brooklands Avenue")
    assert not is_elsewhere("The Edinburgh Building")
    assert is_elsewhere("Senate House, London")


@pytest.mark.parametrize(
    ("series", "venue", "keys"),
    [
        # A plain word that is not the series' subject.
        ("Chemical Engineering Seminar", None, []),
        ("Mathematical Physics Seminar", None, []),
        ("Theoretical Physics Colloquium", None, []),
        ("Cabinet of Natural History", None, []),
        ("History of Medicine Seminars", None, []),
        ("English Legal History Seminar", None, []),
        ("Art Conservation Lectures", None, []),
        # Student societies.
        ("CU History Society", None, []),
        ("Cambridge University Physics Society", None, []),
        ("Cambridge Union Law Society", None, []),
        ("Medicine and Ethics Society", None, []),
        ("Psychology Society Talks", None, []),
        ("Women in Engineering Society talk", None, []),
        # An acronym only with its capitals.
        ("Arc welding for beginners", None, []),
        ("ARC seminar", None, ["dept-autism-research-centre"]),
        # A shared building names no department.
        ("Invented Lecture", "West Road Concert Hall", []),
        ("Invented Lecture", "Keith Peters Building", []),
        ("Invented Lecture", "David Attenborough Building", []),
        ("Invented Lecture", "Maxwell Centre", []),
        ("Invented Lecture", "Madingley Hall", []),
        # What still maps.
        ("Physics Colloquium", None, ["dept-physics"]),
        ("Zoology Department Seminar", None, ["dept-zoology"]),
        ("Genetics Seminar Series", None, ["dept-genetics"]),
        ("Biochemistry Seminar: invited speakers", None, ["dept-biochemistry"]),
        ("Department of Physics Seminar", None, ["dept-physics"]),
        ("History Faculty Seminar", None, ["dept-history"]),
        ("CST Wednesday Seminar", None, ["dept-computer-science-and-technology"]),
        ("Joint Engineering and Chemistry Seminar", None, ["dept-engineering", "dept-chemistry"]),
        ("Invented Lecture", "Bragg Building", ["dept-physics"]),
    ],
)
def test_registry_mapping_of_series_names(series: str, venue: str | None, keys: list[str]) -> None:
    mapper = DepartmentMapper(load_registry())
    assert mapper.departments_for(series_name=series, venue=venue) == keys


def test_registry_names_and_aliases_map_to_one_department_each() -> None:
    owner: dict[str, str] = {}
    for department in load_registry():
        for term in {department.name, department.short_name, *department.aliases}:
            key = term.lower()
            assert owner.setdefault(key, department.key) == department.key, (term, owner[key])
            # Whole-word matches of two letters ("JI", "CL") hit unrelated series;
            # "4C" (Carbon Credits) is the one distinctive exception.
            assert len(term) >= 3 or term == "4C", (department.key, term)
