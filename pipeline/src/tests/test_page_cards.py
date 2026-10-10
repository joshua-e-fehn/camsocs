"""Term cards and posters a society's events page shows as images
(source-research §14 "Events pages", §21): which files are cards, which are
old, the shared card-reading path with its date rules, and `website_events`
reading them — offline (respx, a fake vision model that tells the images apart
by colour)."""

from __future__ import annotations

import base64
import io
import json
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pytest
import respx
from PIL import Image

from camsocs_pipeline.events.common import Tally
from camsocs_pipeline.extract import dating
from camsocs_pipeline.extract.cards import CardHints, card_events
from camsocs_pipeline.extract.events import CallBudget, LlmEvent, OverBudget
from camsocs_pipeline.extract.memo import LLMMemo
from camsocs_pipeline.extract.when import TermCalendar
from camsocs_pipeline.models.observation import EventObservation
from camsocs_pipeline.sources.base import FetchResult, HostGates, PoliteClient
from camsocs_pipeline.sources.policy import AI_OVERRIDE_NOTE, SOCIETY_WEBSITE
from camsocs_pipeline.sources.termcards import (
    NOT_A_CARD_FILE,
    PageFile,
    Skipped,
    TermcardFile,
    card_images,
    card_stale_reason,
    dated_this_year,
    fetch_card_file,
    original_url,
    page_files,
    published_on,
    published_this_year,
    stale_reason,
)
from camsocs_pipeline.sources.websites import events as website
from tests.fakes import make_pdf

LONDON = ZoneInfo("Europe/London")
NOW = datetime(2026, 10, 9, 12, 0, tzinfo=UTC)
TODAY = date(2026, 10, 9)
SITE = "https://quokkas.example.org"
UPLOADS = f"{SITE}/wp-content/uploads"
KEY = "org-cambridge-university-quokka-appreciation-society"
QUOKKAS = website.Site(KEY, "Cambridge University Quokka Appreciation Society", f"{SITE}/")
FIXTURE = Path(__file__).parent / "fixtures" / "websites" / "events_page_cards_synthetic.html"
PAGE = FIXTURE.read_text(encoding="utf-8")


def ms(*parts: int) -> int:
    return int(datetime(*parts, tzinfo=LONDON).timestamp() * 1000)


def png(colour: str, size: tuple[int, int] = (800, 450), fmt: str = "PNG") -> bytes:
    out = io.BytesIO()
    Image.new("RGB", size, colour).save(out, format=fmt)
    return out.getvalue()


def values(event: EventObservation) -> dict[str, Any]:
    return {f.field: f.value for f in event.fields if f.value is not None}


def fields(event: EventObservation) -> dict[str, Any]:
    return {f.field: f for f in event.fields}


# --- which files are cards ------------------------------------------------------------------


def test_the_cards_a_page_shows_are_its_term_cards_and_posters() -> None:
    found = card_images(PAGE, f"{SITE}/our-events/")
    assert [item.url for item in found] == [
        # Naming a term: newest first.
        f"{SITE}/files/Quokka-Michaelmas-2026-termcard.pdf",
        f"{SITE}/files/Lent 2026 Termcard.pdf",
        # Then page order; the slideshow's repeats and the srcset's copies are
        # one file each, the largest copy taken.
        f"{UPLOADS}/2026/10/quokka-mich-03.png",
        f"{UPLOADS}/2026/10/quokka-mich-01.png",
        f"{UPLOADS}/2026/10/quokka-mich-02.png",
        # Right under "Upcoming" and no camera's photo.
        f"{UPLOADS}/2026/09/b4b7fcbd0237.webp",
        f"{UPLOADS}/2025/10/michaelmas-termcard.png",
    ]
    # Left out: the header's logo, the footer's sponsor strip, the Instagram
    # widget, an icon, a strip-shaped banner, photos under "Social events",
    # a camera's photo, the sponsors' and the past events' images.
    urls = " ".join(item.url for item in found)
    for absent in (
        "logo",
        "sponsor-strip",
        "cdninstagram",
        "termcard-icon",
        "events-banner",
        "IMG_2041",
        "DSC01367",
        "acme-corp",
        "termcard-easter",
    ):
        assert absent not in urls
    slide = next(item for item in found if item.url.endswith("quokka-mich-01.png"))
    assert slide.headings == ("– MICHAELMAS TERM 2026 EVENTS –", "TERM CARD")


def test_old_cards_are_known_before_any_request() -> None:
    found = {item.url.rsplit("/", 1)[-1]: item for item in card_images(PAGE, f"{SITE}/x")}
    assert card_stale_reason(found["Lent 2026 Termcard.pdf"], TODAY) == "names a past term"
    assert "uploaded before" in (card_stale_reason(found["michaelmas-termcard.png"], TODAY) or "")
    assert card_stale_reason(found["quokka-mich-01.png"], TODAY) is None
    # A file that names nothing is dated by the heading right above it; its
    # own words win over the heading.
    hashed = PageFile(url=f"{SITE}/settings/656cbd87.png", label="656cbd87.png")
    assert card_stale_reason(
        PageFile(hashed.url, hashed.label, headings=("Lent Term 2025",)), TODAY
    ) == ("names a past term")
    assert (
        card_stale_reason(PageFile(hashed.url, hashed.label, headings=("Mich 2026",)), TODAY)
        is None
    )
    own = PageFile(hashed.url, hashed.label, alt="Michaelmas Term 2026", headings=("Lent 2026",))
    assert card_stale_reason(own, TODAY) is None
    assert dated_this_year(own, TODAY)
    assert not dated_this_year(PageFile(f"{SITE}/a.png", "Lent 2026 card"), TODAY)
    assert dated_this_year(PageFile(f"{UPLOADS}/2026/10/a.png", "a.png"), TODAY)


@pytest.mark.parametrize(
    ("text", "reason"),
    [
        ("http://curac.example.org/files/2024 Lent.pdf", "only earlier years"),
        ("speakers_event_2025.jpg", "only earlier years"),
        ("Term Card Easter 2026 term-card-easter-1.png", "past term"),
        ("Lent 26’ Term Card", "past term"),
        ("lent '23 termcard", "past term"),
        ("lt2026-term-card.png", "past term"),
        ("Easter%202026%20Termcard.pdf", "past term"),
        ("https://www.soc.example/sites/default/files/2024-10/card.png", "uploaded before"),
        ("http://curac.example.org/files/2020Lent.pdf", "only earlier years"),
        # A year in a host name or inside an id is no date; a time is no year.
        ("https://cambridge-2012-society.example.org/termcard.png", None),
        ("https://static.wixstatic.com/media/f0bb45_a36b2019c~mv2.png", None),
        ("Easter 12:00 service poster.png", None),
        ("termcard-2026-27.pdf", None),
        ("https://soc.example/wp-content/uploads/2026/10/term-michel-27-03.png", None),
    ],
)
def test_more_old_cards_are_recognised(text: str, reason: str | None) -> None:
    found = stale_reason(text, TODAY)
    assert (found is None) if reason is None else (found is not None and reason in found)


def test_resized_copies_lead_back_to_the_upload() -> None:
    assert original_url(f"{UPLOADS}/2026/10/card-1024x576.png") == f"{UPLOADS}/2026/10/card.png"
    # Only WordPress names its copies so; elsewhere the size is the file's name.
    assert original_url(f"{SITE}/img/poster-1080x1080.png") == f"{SITE}/img/poster-1080x1080.png"
    wix = "https://static.wixstatic.com/media/7a8a0f_6dae~mv2.jpg/v1/fill/w_287,h_407,q_80/a.jpg"
    assert original_url(wix) == "https://static.wixstatic.com/media/7a8a0f_6dae~mv2.jpg"
    assert original_url(f"{SITE}/p.png?w=727") == f"{SITE}/p.png"
    sanity = "https://cdn.example.org/a-613x682.png?w=10&h=10&q=50&blur=3&auto=format"
    assert original_url(sanity) == "https://cdn.example.org/a-613x682.png"
    # Drupal's image styles need their token.
    drupal = f"{SITE}/sites/default/files/styles/large/public/card.png?itok=Ab12"
    assert original_url(drupal) == drupal


def test_srcsets_with_commas_in_their_urls_give_the_widest_copy() -> None:
    html = (
        '<main><h2>Term card</h2><img srcset="https://static.wixstatic.com/media/a~mv2.png/'
        "v1/fill/w_300,h_200/a.png 300w, https://static.wixstatic.com/media/a~mv2.png/v1/fill/"
        'w_900,h_600/a.png 900w" alt="Our term card"></main>'
    )
    (item,) = page_files(html, SITE)
    assert item.url.endswith("w_900,h_600/a.png")
    assert item.size == (900, 600)


def test_a_card_is_dated_by_its_upload_path_or_its_servers_date() -> None:
    fetched = "2026-10-10T09:00:00+00:00"
    assert published_on(f"{UPLOADS}/2026/10/a.png", None, fetched) == date(2026, 10, 1)
    assert published_on(f"{SITE}/a.png", "Tue, 06 Oct 2026 15:26:22 GMT", fetched) == date(
        2026, 10, 6
    )
    # A server that stamps every answer with the time of the request.
    assert published_on(f"{SITE}/a.png", "Sat, 10 Oct 2026 09:00:00 GMT", fetched) is None
    assert published_this_year(date(2026, 10, 1), TODAY)
    assert not published_this_year(date(2026, 4, 1), TODAY)


def client(tmp_path: Path) -> PoliteClient:
    return PoliteClient(
        user_agent="camsocs-test/0.1",
        cache_dir=tmp_path / "cache",
        min_interval=0,
        gates=HostGates(),
        sleep=lambda _s: None,
        now=lambda: NOW,
    )


def test_a_card_file_is_never_followed_as_a_page(tmp_path: Path, net: respx.MockRouter) -> None:
    net.get(f"{SITE}/robots.txt").respond(200, text="User-agent: *\nAllow: /\n")
    net.get(f"{SITE}/card.png").respond(
        200, text='<a href="/termcard.pdf">Term card</a>', headers={"content-type": "text/html"}
    )
    linked = net.get(f"{SITE}/termcard.pdf")
    instagram = net.get(url__regex=r".*cdninstagram.*")
    with client(tmp_path) as polite:
        skipped = fetch_card_file(polite, f"{SITE}/card.png", SOCIETY_WEBSITE.bound_to(SITE))
        meta = fetch_card_file(polite, "https://scontent-lhr8-1.cdninstagram.com/v/a.jpg")
    assert isinstance(skipped, Skipped) and skipped.reason == NOT_A_CARD_FILE
    assert isinstance(meta, Skipped) and meta.reason == "a social network: links only"
    assert linked.call_count == 0 and instagram.call_count == 0


# --- the date rules -----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("event", "kept"),
    [
        ({"date": "2026-10-15", "when_quote": "THU 15th October // 7.30PM"}, True),
        # A card prints the month once, above its rows.
        ({"date": "2026-10-15", "when_quote": "15"}, True),
        ({"date": "2026-11-18", "when_quote": "18-29 Nov"}, True),
        ({"date": "2026-10-16", "when_quote": "THU 15th October"}, False),
        ({"date": "2026-10-16"}, False),
        ({"term_week": 3, "weekday": "monday", "when_quote": "Week 3 Monday"}, True),
        # A calendar grid's column, without its row's week.
        ({"term_week": 1, "weekday": "tuesday", "when_quote": "TUESDAY"}, False),
        ({"term_week": 3, "when_quote": "During week 3"}, False),
        ({"relative_day": "tonight", "date": "2026-10-15", "when_quote": "15 tonight"}, False),
    ],
)
def test_a_card_event_needs_its_date_in_a_quote(event: dict, kept: bool) -> None:
    assert dating.card_dated_quote(LlmEvent(title="x", **event)) is kept


def test_cards_add_two_signals_for_a_yearless_date() -> None:
    def problem(day: str, quote: str, signals: dating.PageDating) -> str | None:
        return dating.year_problem(LlmEvent(title="x", date=day, when_quote=quote), TODAY, signals)

    nothing = dating.PageDating()
    # Within eight weeks nearness is the second signal, weekday or not.
    assert problem("2026-10-15", "Thu 15 October", nothing) is None
    assert problem("2026-10-15", "15 October", nothing) is None
    # Months ahead: a card published this academic year, or a term named
    # with its year that holds the date, dates it.
    assert "months ahead" in (problem("2027-01-21", "21 January", nothing) or "")
    assert problem("2027-01-21", "21 January", dating.PageDating(fresh=True)) is None
    lent = (date(2027, 1, 14), date(2027, 3, 26))
    assert problem("2027-01-21", "21 January", dating.PageDating(term_span=lent)) is None
    # A weekday that does not fall on the date is last year's card, or a slip:
    # never kept, whatever else dates the card.
    fresh = dating.PageDating(fresh=True, current=True, term=True)
    assert "weekday" in (problem("2026-10-08", "WED 8th October", fresh) or "")
    # A page about an earlier season gives no yearless dates at all.
    stale = dating.PageDating(stale="the page names no year since last season", fresh=True)
    assert problem("2026-10-15", "Thu 15 October", stale)


# --- reading a card --------------------------------------------------------------------------


def image_card(url: str = f"{UPLOADS}/2026/10/quokka-mich-01.png", **fetch: Any) -> TermcardFile:
    result = FetchResult(
        url=url,
        final_url=url,
        outcome="fetched",
        status=200,
        fetched_at="2026-10-09T12:00:00+00:00",
        **fetch,
    )
    return TermcardFile(url, "image", png("red"), "c" * 64, result)


CARD_REPLY: dict[str, Any] = {
    "society_name": "CU Quokka Appreciation Society",
    "events": [
        # Last year's weekday on this year's card: the date is in doubt.
        {"title": "Pub Night", "date": "2026-10-15", "when_quote": "WED 15th October // 7.30PM"},
        {
            "title": "Quokka Pub Night",
            "date": "2026-10-15",
            "start_time": "19:30",
            "when_quote": "THU 15th October / The Eagle / 7.30PM",
            "venue": "The Eagle",
            "event_type": "social",
        },
        {"title": "Formal Swap", "term_week": 3, "when_quote": "During week 3"},
        {"title": "Burrow building", "term_week": 5, "weekday": "wednesday",
         "when_quote": "Week 5 Wednesday"},
        {"title": "Lent Ball", "date": "2027-01-21", "when_quote": "21 January"},
    ],
}  # fmt: skip


def read(
    reply: dict[str, Any], card: TermcardFile | None = None, **kwargs: Any
) -> tuple[list[EventObservation], Tally, Any]:
    from tests.fakes import FakeLLM

    llm = FakeLLM(lambda _text, _tier: reply)
    tally = Tally()
    events = card_events(
        card or image_card(),
        org_key=KEY,
        org_name=QUOKKAS.org_name,
        listed_url=f"{SITE}/our-events/",
        now=NOW,
        llm=llm,
        memo=kwargs.pop("memo", None),
        calendar=TermCalendar.default(),
        notes=[],
        drops=tally,
        **kwargs,
    )
    return events, tally, llm


def test_an_image_card_is_read_with_the_page_beside_it() -> None:
    hints = CardHints(
        term_text="quokka-mich-01 – MICHAELMAS TERM 2026 EVENTS – / TERM CARD",
        page=dating.page_dating("MICHAELMAS TERM 2026 EVENTS TERM CARD", TODAY),
    )
    events, tally, llm = read(CARD_REPLY, hints=hints)
    by_title = {values(e)["title"]: e for e in events}
    assert sorted(by_title) == ["Burrow building", "Lent Ball", "Quokka Pub Night"]
    assert tally.dropped == {
        "the weekday does not fall on that date": 1,
        "no dated quote on the card": 1,
    }
    # The heading names the term: Week 5 Wednesday of Michaelmas 2026.
    burrow = fields(by_title["Burrow building"])
    assert burrow["startsAt"].value == ms(2026, 11, 11)
    pub = by_title["Quokka Pub Night"]
    assert values(pub)["startsAt"] == ms(2026, 10, 15, 19, 30)
    assert (pub.source_type, pub.event_source, pub.visibility) == ("termcard", "termcard", "public")
    assert pub.source_url == f"{UPLOADS}/2026/10/quokka-mich-01.png"
    assert pub.external_id == f"{KEY}:2026-10-15:quokka-pub-night"
    assert [o.identity.known_key for o in pub.organisers] == [KEY]
    # An image has no text to find a quote in: every value is inferred.
    assert {f.status for f in pub.fields if f.method == "llm"} == {"inferred"}
    assert fields(pub)["startsAt"].value_raw == "THU 15th October / The Eagle / 7.30PM"
    # A yearless date months ahead stands on a card uploaded this academic year.
    assert values(by_title["Lent Ball"])["startsAt"] == ms(2027, 1, 21)
    # The model's reference date is the week the card was uploaded (/2026/10/).
    assert "Reference date: Thursday 1 October 2026" in llm.calls[0]["text"]
    assert llm.calls[0]["tier"] == "strong" and llm.calls[0]["images"] == 1


def test_a_card_that_nothing_dates_keeps_only_near_dates() -> None:
    card = image_card(f"{SITE}/cards/termcard.png")
    events, tally, _llm = read(CARD_REPLY, card)
    # No sign the Lent date is this year's; the card names no term, but its
    # dated row falls in Michaelmas 2026, so Week 5 is read in it — inferred.
    by_title = {values(e)["title"]: e for e in events}
    assert sorted(by_title) == ["Burrow building", "Quokka Pub Night"]
    assert tally.dropped["a date without its year or weekday, months ahead"] == 1
    burrow = fields(by_title["Burrow building"])
    assert burrow["startsAt"].value == ms(2026, 11, 11)
    assert burrow["startsAt"].status == "inferred" and burrow["startsAt"].evidence_quote is None


def test_the_runs_vision_budget_spares_cached_replies(tmp_path: Path) -> None:
    memo = LLMMemo(tmp_path / "llm")
    budget = CallBudget(1)
    read(CARD_REPLY, memo=memo, budget=budget)
    assert budget.used == 1
    # The same card again is a cached reply, which costs nothing…
    _events, _tally, llm = read(CARD_REPLY, memo=memo, budget=budget)
    assert llm.calls == [] and budget.used == 1
    # … and a new one finds no room.
    other = image_card(f"{UPLOADS}/2026/10/other.png")
    other = TermcardFile(other.url, "image", png("blue"), "d" * 64, other.fetch)
    with pytest.raises(OverBudget):
        read(CARD_REPLY, other, memo=memo, budget=budget)


# --- website_events reads them --------------------------------------------------------------

HOME = """<html><head><title>Quokka Society</title></head><body>
<nav><a href="/">Home</a> <a href="/our-events/">Events</a></nav>
<main><h1>Welcome</h1><p>We appreciate quokkas, everyone welcome.</p></main></body></html>"""

#: What the page's own text says (the bulk model's reading).
TEXT_REPLY = {
    "events": [
        {
            "title": "Quokka Quiz",
            "date": "2026-10-22",
            "start_time": "19:00",
            "when_quote": "Thursday 22 October, 7pm",
        }
    ]
}

#: The vision model's reading of each card, by the card's colour.
CARD_REPLIES: dict[str, dict[str, Any]] = {
    "blue": {  # quokka-mich-03: a poster
        "events": [
            {
                "title": "Pub Night",
                "date": "2026-10-15",
                "start_time": "19:30",
                "when_quote": "THU 15th October // 7.30PM",
                "venue": "The Eagle",
            }
        ]
    },
    "red": {  # quokka-mich-01: the overview card
        "term": "michaelmas",
        "term_year": 2026,
        "events": [
            {"title": "Pub Night", "date": "2026-10-15", "when_quote": "THU 15th October"},
            {"title": "Oktoberfest", "date": "2026-10-16", "when_quote": "FRI 16th October"},
            {"title": "Freshers' Fair", "date": "2026-10-06", "when_quote": "TUE 6th October"},
        ],
    },
    "green": {  # quokka-mich-02: the quiz the page lists too, its "7" misread
        "events": [
            {
                "title": "Quokka Quiz",
                "date": "2026-10-22",
                "start_time": "07:00",
                "when_quote": "THU 22nd OCT // 7",
            }
        ]
    },
    "yellow": {"events": []},  # the webp under "Upcoming": a photo after all
    "white": {  # the term-card PDF, with its text layer
        "term": "michaelmas",
        "term_year": 2026,
        "events": [
            {
                "title": "Burrow building",
                "term_week": 5,
                "weekday": "wednesday",
                "start_time": "14:00",
                "when_quote": "Week 5 Wednesday 2pm",
            }
        ],
    },
}
COLOURS = {
    "blue": (0, 0, 255),
    "red": (255, 0, 0),
    "green": (0, 128, 0),
    "yellow": (255, 255, 0),
    "white": (255, 255, 255),
}


class CardLLM:
    """The bulk model for page text, a vision model that tells the cards
    apart by the colour of their top-left pixel."""

    def __init__(self) -> None:
        self.calls: list[str] = []

    def model_for(self, tier: str) -> str:
        return {"bulk": "bulk-model-1", "strong": "strong-model-1"}[tier]

    def complete_json(self, *, schema, messages, prompt_version, tier="bulk", temperature=0.0):
        from camsocs_pipeline.extract.llm import LLMCall

        user = messages[-1]["content"]
        if isinstance(user, str):
            reply = TEXT_REPLY
        else:
            data = base64.b64decode(user[1]["image_url"]["url"].split(",", 1)[1])
            pixel = Image.open(io.BytesIO(data)).convert("RGB").getpixel((0, 0))
            colour = min(
                COLOURS,
                key=lambda c: sum((a - b) ** 2 for a, b in zip(COLOURS[c], pixel, strict=True)),
            )
            self.calls.append(colour)
            reply = CARD_REPLIES[colour]
        return LLMCall(
            schema.model_validate(reply),
            self.model_for(tier),
            prompt_version,
            False,
            json.dumps(reply),
        )


def serve(net: respx.MockRouter, page: str = PAGE) -> dict[str, respx.Route]:
    net.get(f"{SITE}/robots.txt").respond(200, text="User-agent: *\nAllow: /\n")
    net.get(f"{SITE}/").respond(200, text=HOME, headers={"content-type": "text/html"})
    text = page.replace(
        "<h1>Participate and engage</h1>",
        "<h1>Participate and engage</h1><p>Quokka Quiz: Thursday 22 October, 7pm.</p>",
    )
    net.get(f"{SITE}/our-events").respond(200, text=text, headers={"content-type": "text/html"})
    files = {
        f"{UPLOADS}/2026/10/quokka-mich-03.png": png("blue"),
        f"{UPLOADS}/2026/10/quokka-mich-01.png": png("red"),
        f"{UPLOADS}/2026/10/quokka-mich-02.png": png("green"),
        f"{UPLOADS}/2026/09/b4b7fcbd0237.webp": png("yellow", fmt="WEBP"),
        f"{SITE}/files/Quokka-Michaelmas-2026-termcard.pdf": make_pdf(
            ["Quokka Society - Michaelmas 2026", "Week 5 Wednesday 2pm: Burrow building"]
        ),
    }
    routes = {url: net.get(url).respond(200, content=body) for url, body in files.items()}
    routes["old"] = net.get(url__regex=r".*(Lent%202026|Lent 2026|2025/10).*")
    return routes


def test_a_site_whose_programme_is_only_images_gets_its_events(
    tmp_path: Path, net: respx.MockRouter
) -> None:
    routes = serve(net, PAGE.replace("<head>", '<head><meta name="robots" content="noimageai">'))
    llm = CardLLM()
    with client(tmp_path) as polite:
        result = website.read_site(
            polite, QUOKKAS, llm=llm, memo=None, calendar=TermCalendar.default(), now=NOW
        )
    by_title = {values(e)["title"]: e for e in result.events}
    assert sorted(by_title) == ["Burrow building", "Oktoberfest", "Pub Night", "Quokka Quiz"]
    # The quiz is the page's own (text) reading at 19:00; the card's copy,
    # its "7" read as 07:00, is dropped.
    quiz = by_title["Quokka Quiz"]
    assert quiz.event_source == "website" and values(quiz)["startsAt"] == ms(2026, 10, 22, 19)
    # The poster's timed reading wins over the overview card's all-day one.
    pub = by_title["Pub Night"]
    assert pub.event_source == "termcard"
    assert pub.source_url == f"{UPLOADS}/2026/10/quokka-mich-03.png"
    # Swept by the page that shows the card (review 2026-10-10).
    assert pub.listing_url == f"{SITE}/our-events"
    assert values(pub)["startsAt"] == ms(2026, 10, 15, 19, 30)
    assert values(by_title["Oktoberfest"])["allDay"] is True
    # The PDF's week row in the term its card names, its quote on the text layer.
    burrow = fields(by_title["Burrow building"])
    assert burrow["startsAt"].value == ms(2026, 11, 11, 14, 0)
    assert burrow["startsAt"].quote_check == "exact"
    assert result.cards == 5
    assert sorted(llm.calls) == ["blue", "green", "red", "white", "yellow"]
    assert result.tally.dropped == {
        "an old card or poster": 2,
        "past": 1,
        "one event on several cards": 1,
        "already listed on the page": 1,
    }
    # Old cards are never fetched.
    assert routes["old"].call_count == 0
    # The page says noimageai: its cards reached the model only through the
    # D3 override, and their events say so.
    assert AI_OVERRIDE_NOTE in (pub.fetch.access_note or "")


def test_the_runs_budget_stops_reading_cards(tmp_path: Path, net: respx.MockRouter) -> None:
    serve(net)
    with client(tmp_path) as polite:
        result = website.read_site(
            polite,
            QUOKKAS,
            llm=CardLLM(),
            memo=None,
            calendar=TermCalendar.default(),
            now=NOW,
            budget=CallBudget(2),
        )
    assert result.cards == 2
    assert result.tally.dropped["over the run's budget of card readings"] == 1


def test_a_page_about_an_earlier_season_shows_no_cards_to_read(
    tmp_path: Path, net: respx.MockRouter
) -> None:
    undated = f"{SITE}/media/b4b7fcbd0237.webp"
    old = (
        PAGE.replace("MICHAELMAS TERM 2026 EVENTS", "MICHAELMAS TERM 2024 EVENTS")
        .replace("<h1>Participate and engage</h1>", "<h1>Our 2023/2024 season</h1>")
        .replace("/wp-content/uploads/2026/09/b4b7fcbd0237.webp", "/media/b4b7fcbd0237.webp")
    )
    serve(net, old)
    photo = net.get(undated).respond(200, content=png("yellow", fmt="WEBP"))
    llm = CardLLM()
    with client(tmp_path) as polite:
        result = website.read_site(
            polite, QUOKKAS, llm=llm, memo=None, calendar=TermCalendar.default(), now=NOW
        )
    # Only the files whose own name or upload path says this year are read.
    assert sorted(llm.calls) == ["blue", "green", "red", "white"]
    assert photo.call_count == 0
    assert result.tally.dropped["an old card or poster"] == 3


# --- review 2026-10-10: slides labelled "MT - 2", termcard pages, one evening twice --------


def test_a_slide_labelled_with_a_term_and_its_number_is_a_card() -> None:
    html = """<html><head><title>Termcard — Quokka Society</title></head><body><main>
    <img src="https://cdn.example/logo.png" alt="Cambridge University Quokka Society">
    <img src="https://cdn.example/Michaelmas+-+1.PNG" alt="Michaelmas - 1.PNG">
    <img src="https://cdn.example/MT+-+2.PNG" alt="MT - 2.PNG">
    <img src="https://cdn.example/1791303914638-KC64.png" alt="">
    <img src="https://cdn.example/DSC02797.jpg" alt="">
    </main></body></html>"""
    found = [item.url for item in card_images(html, "https://quokka.example/termcard-1")]
    assert "https://cdn.example/MT+-+2.PNG" in found
    # On a term card page an unlabelled image is a slide; its logo and a
    # camera's photo are not.
    assert "https://cdn.example/1791303914638-KC64.png" in found
    assert not any("logo" in url or "DSC" in url for url in found)
    # The same unlabelled image on another page is no card.
    elsewhere = card_images(html.replace("Termcard", "Gallery"), "https://quokka.example/gallery")
    assert "https://cdn.example/1791303914638-KC64.png" not in [item.url for item in elsewhere]


def test_a_poster_and_the_term_card_naming_one_evening_differently_are_one_reading() -> None:
    from camsocs_pipeline.events.common import EventDraft, build_event_observation
    from camsocs_pipeline.models.observation import IdentityHints, OrganiserObs

    organiser = OrganiserObs(identity=IdentityHints(name="Quokka Society", known_key=KEY))

    def reading(title: str, *, timed: bool, description: str | None, url: str) -> EventObservation:
        start = (
            datetime(2026, 10, 14, 20, 15, tzinfo=LONDON)
            if timed
            else datetime(2026, 10, 14, tzinfo=LONDON)
        )
        draft = EventDraft(
            event_source="termcard",
            external_id=f"{KEY}:2026-10-14:{title.lower().replace(' ', '-')}",
            title=title,
            starts_at=start,
            all_day=not timed,
            description=description,
            organisers=[organiser],
        )
        return build_event_observation(
            draft, source_type="termcard", source_url=url, retrieved_at=NOW, evidence="primary"
        )

    row = reading(
        "Cinema QuokSoc",
        timed=False,
        description="The Last One for the Road",
        url=f"{UPLOADS}/c.png",
    )
    poster = reading(
        "THE LAST ONE FOR THE ROAD", timed=True, description=None, url=f"{UPLOADS}/p.png"
    )
    other = reading("Pub Quiz", timed=False, description=None, url=f"{UPLOADS}/c.png")
    tally = Tally()
    kept = website.unseen_card_events([row, poster, other], [], tally)
    assert [website._title(r) for r in kept] == ["THE LAST ONE FOR THE ROAD", "Pub Quiz"]


def test_a_cards_events_are_swept_by_the_page_that_shows_it() -> None:
    """Review 2026-10-10: each card file was a listing of its own, so the
    events of a card a page stopped showing were never withdrawn. The
    identity claims now come from the page."""
    from camsocs_pipeline.claims import claims_for_event
    from camsocs_pipeline.events.common import EventDraft, build_event_observation

    draft = EventDraft(
        event_source="termcard",
        external_id=f"{KEY}:2026-11-25:opening-reception",
        title="Opening Reception",
        starts_at=datetime(2026, 11, 25, tzinfo=LONDON),
        all_day=True,
    )
    card = f"{UPLOADS}/2026/10/card.png"
    record = build_event_observation(
        draft, source_type="termcard", source_url=card, retrieved_at=NOW, evidence="primary"
    ).model_copy(update={"listing_url": f"{SITE}/our-events/"})
    by_field = {claim.field: claim for claim in claims_for_event(record)}
    assert by_field["externalId"].source_url == f"{SITE}/our-events/"
    assert by_field["source"].source_url == f"{SITE}/our-events/"
    # Every other claim keeps the card as its source; the event's page is the card.
    assert by_field["title"].source_url == card and by_field["sourceUrl"].value == card
