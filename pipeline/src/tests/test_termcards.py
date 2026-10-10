"""Termcards (source-research §21): polite fetching (file, linking page,
robots-blocked), term inference, vision extraction checked against the PDF's
text layer, de-duplication and the stage — offline (respx, fake LLM)."""

from __future__ import annotations

import json
from datetime import UTC, datetime

import httpx
import pytest

import camsocs_pipeline.pipeline.load as load
from camsocs_pipeline.claims import parser_field
from camsocs_pipeline.extract.cards import card_events
from camsocs_pipeline.extract.llm import NoLLMHost
from camsocs_pipeline.extract.when import TermCalendar
from camsocs_pipeline.models.observation import EventObservation, IdentityHints, OrganiserObs
from camsocs_pipeline.pipeline.sync import run_sync
from camsocs_pipeline.sources.base import PoliteClient
from camsocs_pipeline.sources.termcards import Skipped, TermcardFile, fetch_termcard, term_hint
from camsocs_pipeline.staging.store import StagingStore
from tests.fakes import (
    ORRERY_KEY,
    TERMCARD_LINES,
    TERMCARD_REPLY,
    FakeLLM,
    known_orgs_records,
    make_pdf,
)

SITE = "https://happy-otter-123.convex.site"
CARD_PAGE = "https://orrery.example.org/termcard"
PDF = make_pdf(TERMCARD_LINES)


def _ms(*parts: int) -> int:
    return int(datetime(*parts, tzinfo=UTC).timestamp() * 1000)


PLANETARIUM = _ms(2026, 10, 21, 18, 0)  # Wed of Week 2, 19:00 BST
ORRERY_BUILDING = _ms(2026, 11, 6, 20, 0)  # Fri of Week 5, 20:00 GMT


@pytest.fixture(autouse=True)
def _no_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(load.time, "sleep", lambda _seconds: None)


def client(tmp_path) -> PoliteClient:
    return PoliteClient(
        user_agent="camsocs-test/0.1",
        cache_dir=tmp_path / "cache",
        min_interval=0,
        sleep=lambda _s: None,
    )


def test_term_hint_reads_names_and_codes() -> None:
    assert term_hint("https://x.org/CUHCS-Michaelmas-Term-Card/") == ("michaelmas", None)
    assert term_hint("termcard-lent-2027.pdf") == ("lent", 2027)
    assert term_hint("/files/MT26_termcard.pdf") == ("michaelmas", 2026)
    assert term_hint("https://x.org/programme.pdf") == (None, None)


def test_a_direct_pdf_is_fetched(tmp_path, net) -> None:
    net.get("https://orrery.example.org/robots.txt").mock(return_value=httpx.Response(404))
    net.get(CARD_PAGE).mock(
        return_value=httpx.Response(200, content=PDF, headers={"content-type": "application/pdf"})
    )
    with client(tmp_path) as polite:
        fetched = fetch_termcard(polite, CARD_PAGE)
    assert isinstance(fetched, TermcardFile) and fetched.kind == "pdf"


def test_a_page_is_followed_to_its_termcard_file(tmp_path, net) -> None:
    net.get("https://orrery.example.org/robots.txt").mock(return_value=httpx.Response(404))
    page = (
        '<html><body><a href="/about.pdf">About us</a>'
        '<a href="/files/MT26-termcard.pdf">Our termcard</a></body></html>'
    )
    net.get(CARD_PAGE).mock(
        return_value=httpx.Response(200, text=page, headers={"content-type": "text/html"})
    )
    net.get("https://orrery.example.org/files/MT26-termcard.pdf").mock(
        return_value=httpx.Response(200, content=PDF)
    )
    with client(tmp_path) as polite:
        fetched = fetch_termcard(polite, CARD_PAGE)
    assert isinstance(fetched, TermcardFile)
    assert fetched.url == "https://orrery.example.org/files/MT26-termcard.pdf"


def test_robots_blocked_files_and_missing_cards_are_skipped(tmp_path, net) -> None:
    # The SU's case: the file lives under a disallowed /asset/ path.
    net.get("https://su.example.org/robots.txt").mock(
        return_value=httpx.Response(200, text="User-agent: *\nDisallow: /asset/\n")
    )
    page = '<a href="/asset/Organisation/1/termcard.pdf">Term card</a>'
    net.get("https://su.example.org/resources/1/termcard/").mock(
        return_value=httpx.Response(200, text=page, headers={"content-type": "text/html"})
    )
    asset = net.get("https://su.example.org/asset/Organisation/1/termcard.pdf")
    net.get("https://orrery.example.org/robots.txt").mock(return_value=httpx.Response(404))
    net.get("https://orrery.example.org/gone.pdf").mock(return_value=httpx.Response(404))
    with client(tmp_path) as polite:
        blocked = fetch_termcard(polite, "https://su.example.org/resources/1/termcard/")
        missing = fetch_termcard(polite, "https://orrery.example.org/gone.pdf")
    assert isinstance(blocked, Skipped) and "without a readable" in blocked.reason
    assert asset.call_count == 0
    assert isinstance(missing, Skipped) and missing.reason.startswith("not_found")


def test_su_termcards_behind_the_login_are_restricted_and_assets_overridden(tmp_path, net) -> None:
    # D3: SU-hosted cards are fetched with the society purpose. A /file/ link
    # redirects to the SU login, which is never followed (access_restricted);
    # an /asset/ file is read although robots.txt disallows /asset/.
    su = "https://www.cambridgesu.co.uk"
    net.get(f"{su}/robots.txt").mock(
        return_value=httpx.Response(
            200, text="User-agent: *\nDisallow: /asset/\nDisallow: /login/\n"
        )
    )
    net.get(f"{su}/file/7501/Termcard/").mock(
        return_value=httpx.Response(
            302, headers={"location": "/login/?redirect=%2ffile%2f7501%2fTermcard%2f"}
        )
    )
    login = net.get(url__startswith=f"{su}/login/")
    net.get(f"{su}/asset/Organisation/7501/termcard.pdf").mock(
        return_value=httpx.Response(200, content=PDF, headers={"content-type": "application/pdf"})
    )
    with client(tmp_path) as polite:
        walled = fetch_termcard(polite, f"{su}/file/7501/Termcard/")
        asset = fetch_termcard(polite, f"{su}/asset/Organisation/7501/termcard.pdf")
    assert isinstance(walled, Skipped) and walled.reason.startswith("access_restricted")
    assert login.call_count == 0
    assert isinstance(asset, TermcardFile)
    assert asset.fetch.override == "robots_override:society"
    # A general fetch of the same asset is still refused, even from the cache.
    with client(tmp_path) as polite:
        general = polite.fetch(f"{su}/asset/Organisation/7501/termcard.pdf")
    assert general.outcome == "disallowed_by_robots"


@pytest.mark.parametrize(
    ("url", "reason"),
    [
        ("https://talks.cam.ac.uk/show/index/201664", "keeps AI out"),
        ("https://www.instagram.com/p/abc123/", "social network"),
        ("https://www.facebook.com/cuorrery/photos/1", "social network"),
        ("https://www.linkedin.com/company/orrery/", "social network"),
    ],
)
def test_never_fetched_hosts_are_skipped_without_a_request(
    tmp_path, net, url: str, reason: str
) -> None:
    with client(tmp_path) as polite:
        skipped = fetch_termcard(polite, url)
    assert isinstance(skipped, Skipped) and reason in skipped.reason
    assert not net.calls


def test_a_card_from_a_host_that_keeps_ai_out_never_reaches_the_model(tmp_path, net) -> None:
    # Fetching is allowed for our crawler; GPTBot is disallowed by name.
    net.get("https://orrery.example.org/robots.txt").mock(
        return_value=httpx.Response(200, text="User-agent: GPTBot\nDisallow: /\n")
    )
    net.get(CARD_PAGE).mock(
        return_value=httpx.Response(200, content=PDF, headers={"content-type": "application/pdf"})
    )
    with client(tmp_path) as polite:
        skipped = fetch_termcard(polite, CARD_PAGE)
    assert isinstance(skipped, Skipped) and skipped.reason == "host keeps AI out"


def test_a_linked_file_on_a_host_that_keeps_ai_out_is_skipped(tmp_path, net) -> None:
    net.get("https://orrery.example.org/robots.txt").mock(return_value=httpx.Response(404))
    page = '<a href="https://files.example.net/MT26-termcard.pdf">Our termcard</a>'
    net.get(CARD_PAGE).mock(
        return_value=httpx.Response(200, text=page, headers={"content-type": "text/html"})
    )
    net.get("https://files.example.net/robots.txt").mock(
        return_value=httpx.Response(200, text="User-agent: *\nContent-Signal: ai-input=no\n")
    )
    net.get("https://files.example.net/MT26-termcard.pdf").mock(
        return_value=httpx.Response(200, content=PDF)
    )
    with client(tmp_path) as polite:
        skipped = fetch_termcard(polite, CARD_PAGE)
    assert isinstance(skipped, Skipped) and skipped.reason == "host keeps AI out"


def test_a_noai_page_is_not_followed(tmp_path, net) -> None:
    net.get("https://orrery.example.org/robots.txt").mock(return_value=httpx.Response(404))
    page = (
        '<html><head><meta name="robots" content="noai, noimageai"></head>'
        '<body><a href="/files/MT26-termcard.pdf">Our termcard</a></body></html>'
    )
    net.get(CARD_PAGE).mock(
        return_value=httpx.Response(200, text=page, headers={"content-type": "text/html"})
    )
    linked = net.get("https://orrery.example.org/files/MT26-termcard.pdf")
    with client(tmp_path) as polite:
        skipped = fetch_termcard(polite, CARD_PAGE)
    assert isinstance(skipped, Skipped) and skipped.reason == "host keeps AI out"
    assert linked.call_count == 0


def test_card_events_refuse_a_talks_cam_card_before_the_model() -> None:
    llm = FakeLLM(lambda _text, _tier: TERMCARD_REPLY)
    with pytest.raises(NoLLMHost):
        card_events(
            card("https://talks.cam.ac.uk/talk/abc.pdf"),
            org_key=ORRERY_KEY,
            org_name="Cambridge University Orrery Club",
            listed_url="https://talks.cam.ac.uk/talk/abc.pdf",
            now=datetime(2026, 10, 7, 12, tzinfo=UTC),
            llm=llm,
            memo=None,
            calendar=TermCalendar.default(),
            notes=[],
        )
    assert llm.calls == []


def card(url: str = CARD_PAGE) -> TermcardFile:
    from camsocs_pipeline.sources.base import FetchResult

    result = FetchResult(
        url=url,
        final_url=url,
        outcome="fetched",
        status=200,
        fetched_at="2026-10-07T12:00:00+00:00",
    )
    return TermcardFile(url, "pdf", PDF, "a" * 64, result)


def test_card_events_are_checked_against_the_text_layer() -> None:
    llm = FakeLLM(lambda _text, _tier: TERMCARD_REPLY)
    notes: list[str] = []
    events = card_events(
        card(),
        org_key=ORRERY_KEY,
        org_name="Cambridge University Orrery Club",
        listed_url=CARD_PAGE,
        now=datetime(2026, 10, 7, 12, tzinfo=UTC),
        llm=llm,
        memo=None,
        calendar=TermCalendar.default(),
        notes=notes,
    )
    assert llm.calls[0]["tier"] == "strong" and llm.calls[0]["images"] == 1
    assert "Week 2 Wednesday 7pm" in llm.calls[0]["text"]  # the text layer went along
    by_title = {next(f.value for f in e.fields if f.field == "title"): e for e in events}
    starts = {
        t: next(f.value for f in e.fields if f.field == "startsAt") for t, e in by_title.items()
    }
    assert starts == {"Planetarium trip": PLANETARIUM, "Orrery building": ORRERY_BUILDING}
    trip = {f.field: f for f in by_title["Planetarium trip"].fields}
    # Quotes found in the PDF's text layer: found, not inferred.
    assert trip["startsAt"].quote_check == "exact" and trip["title"].quote_check == "exact"
    assert by_title["Planetarium trip"].visibility == "public"
    assert by_title["Orrery building"].visibility == "members_only"
    assert by_title["Planetarium trip"].event_source == "termcard"


def _read(reply: dict, url: str = "https://orrery.example.org/programme.pdf") -> tuple:
    notes: list[str] = []
    events = card_events(
        card(url),
        org_key=ORRERY_KEY,
        org_name="CU Orrery Club",
        listed_url=url,
        now=datetime(2026, 10, 7, 12, tzinfo=UTC),
        llm=FakeLLM(lambda _text, _tier: reply),
        memo=None,
        calendar=TermCalendar.default(),
        notes=notes,
    )
    by_title = {next(f.value for f in e.fields if f.field == "title"): e for e in events}
    return by_title, notes


def test_a_card_that_does_not_say_its_term_keeps_only_dated_events() -> None:
    reply = {**TERMCARD_REPLY, "term": None, "term_year": None}
    by_title, notes = _read(reply)
    assert by_title == {}
    assert any("term-less" in note for note in notes)


def test_a_card_takes_its_term_from_its_own_dated_rows() -> None:
    reply = {**TERMCARD_REPLY, "term": None, "term_year": None}
    reply["events"] = [
        *TERMCARD_REPLY["events"],
        {
            "title": "Open evening",
            "date": "2026-10-30",
            "start_time": "18:00",
            "when_quote": "Fri 30 Oct, 6pm",
        },
        # A row the model dated without the card's words for it is no row.
        {"title": "Stargazing", "date": "2026-10-31", "start_time": "21:00"},
    ]
    by_title, notes = _read(reply)
    # 30 October falls in Michaelmas 2026, so its week rows are read in it —
    # as inferred dates: the card states the week, not the term.
    assert sorted(by_title) == ["Open evening", "Orrery building", "Planetarium trip"]
    assert any("1 no dated quote on the card" in note for note in notes)
    trip = {f.field: f for f in by_title["Planetarium trip"].fields}
    assert trip["startsAt"].value == PLANETARIUM
    assert trip["startsAt"].status == "inferred" and trip["startsAt"].quote_check == "absent"
    assert trip["startsAt"].value_raw == "Week 2 Wednesday 7pm"


def test_a_long_pdf_is_read_four_pages_a_call() -> None:
    from tests.fakes import make_pdf_pages

    pages = [[f"CU Orrery Club - Michaelmas 2026 page {n}"] for n in range(1, 7)]
    llm = FakeLLM(lambda _text, _tier: TERMCARD_REPLY)
    long_card = card()
    long_card = TermcardFile(long_card.url, "pdf", make_pdf_pages(pages), "b" * 64, long_card.fetch)
    card_events(
        long_card,
        org_key=ORRERY_KEY,
        org_name="CU Orrery Club",
        listed_url=CARD_PAGE,
        now=datetime(2026, 10, 7, 12, tzinfo=UTC),
        llm=llm,
        memo=None,
        calendar=TermCalendar.default(),
        notes=[],
    )
    assert [call["images"] for call in llm.calls] == [4, 2]
    assert "page 5" in llm.calls[1]["text"] and "page 5" not in llm.calls[0]["text"]


@pytest.mark.parametrize(
    ("text", "reason"),
    [
        ("https://soc.example/2024/01/21/lent-2024-term-card/", "names a past term"),
        ("Easter 2026 Termcard.pdf", "names a past term"),
        ("https://soc.example/wp-content/uploads/2021/04/termcard.png", "uploaded before"),
        ("termcard-michaelmas-2026.jpg", None),
        ("CURaC Lent 2027 Termcard.pdf", None),
        ("https://soc.example/wp-content/uploads/2026/09/termcard.png", None),
        ("https://soc.example/termcard", None),
    ],
)
def test_old_cards_are_recognised(text: str, reason: str | None) -> None:
    from datetime import date

    from camsocs_pipeline.sources.termcards import stale_reason

    found = stale_reason(text, date(2026, 10, 9))
    assert (found is None) if reason is None else (found is not None and reason in found)


def test_a_page_with_several_cards_follows_the_newest_named_first() -> None:
    from camsocs_pipeline.sources.termcards import _file_links

    page = (
        '<a href="/files/Easter 2026 Termcard.pdf">Easter</a>'
        '<a href="/files/CURaC Lent 2026 Termcard.pdf">Lent</a>'
        '<a href="/files/Michaelmas-2026-termcard.pdf">This term</a>'
        '<img data-src="https://static.wixstatic.com/media/ab_c~mv2.png/v1/fill/w_980/a.png" '
        'alt="Our term card">'
    )
    assert _file_links(page, "https://soc.example/termcards") == [
        "https://soc.example/files/Michaelmas-2026-termcard.pdf",
        "https://soc.example/files/Easter 2026 Termcard.pdf",
        "https://soc.example/files/CURaC Lent 2026 Termcard.pdf",
        "https://static.wixstatic.com/media/ab_c~mv2.png/v1/fill/w_980/a.png",
    ]


def completion(request: httpx.Request) -> httpx.Response:
    body = json.loads(request.content)
    return httpx.Response(
        200,
        json={
            "id": "c1",
            "object": "chat.completion",
            "created": 0,
            "model": body["model"],
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {"role": "assistant", "content": json.dumps(TERMCARD_REPLY)},
                }
            ],
        },
    )


def stage_settings(make_settings):
    return make_settings(
        convex_http_url=SITE,
        pipeline_api_key="test-key",
        llm_base_url="http://llm.test/v1",
        llm_api_key="test-llm-key",
        llm_model_bulk="bulk-model-1",
        llm_model_strong="strong-model-1",
        min_host_interval=0,
    )


def mock_run_log(net) -> None:
    net.get(f"{SITE}/api/pipeline/health").mock(return_value=httpx.Response(200, json={"ok": True}))
    net.post(f"{SITE}/api/pipeline/runs/start").mock(return_value=httpx.Response(200, json={}))
    net.post(f"{SITE}/api/pipeline/runs/finish").mock(return_value=httpx.Response(200, json={}))
    # The organisation lookup reads Convex's crosswalk (resolve/lookup.py).
    net.post(f"{SITE}/api/pipeline/crosswalk").mock(
        return_value=httpx.Response(200, json={"rows": [], "isDone": True})
    )


def test_the_stage_stages_new_events_and_drops_known_ones(make_settings, net) -> None:
    settings = stage_settings(make_settings)
    store = StagingStore(settings.staging_dir)
    store.write("_resolved", "20261001T000000Z-aaaaaa", known_orgs_records())
    # The same trip, already listed by another source.
    store.write(
        "camdram",
        "20261001T000000Z-aaaaaa",
        [
            EventObservation(
                source_type="camdram",
                source_key="show-1",
                source_url="https://www.camdram.net/shows/x",
                retrieved_at=datetime(2026, 10, 1, tzinfo=UTC),
                event_source="camdram",
                external_id="show-1",
                visibility="public",
                organisers=[
                    OrganiserObs(identity=IdentityHints(name="CUOC", known_key=ORRERY_KEY))
                ],
                fields=[
                    parser_field("title", "Planetarium Trip!", extractor="t", evidence="secondary"),
                    parser_field("startsAt", PLANETARIUM, extractor="t", evidence="secondary"),
                ],
            )
        ],
    )
    mock_run_log(net)
    net.get("https://orrery.example.org/robots.txt").mock(return_value=httpx.Response(404))
    net.get(CARD_PAGE).mock(return_value=httpx.Response(200, content=PDF))
    llm = net.post("http://llm.test/v1/chat/completions").mock(side_effect=completion)

    report = run_sync(settings=settings, stages=["termcards"])
    assert report.ok, report.summary()
    staged = store.read_latest("termcard")
    titles = [next(f.value for f in e.fields if f.field == "title") for e in staged]
    assert titles == ["Orrery building"]

    # A cam_only copy from list mail never hides the public termcard event.
    store.write(
        "mailing_list_email",
        "20261002T000000Z-aaaaaa",
        [
            EventObservation(
                source_type="mailing_list_email",
                source_key="m-1",
                source_url="inbound:<m-1@x>",
                retrieved_at=datetime(2026, 10, 2, tzinfo=UTC),
                event_source="mailing_list",
                external_id="m-1",
                visibility="cam_only",
                organisers=[
                    OrganiserObs(identity=IdentityHints(name="CUOC", known_key=ORRERY_KEY))
                ],
                fields=[
                    parser_field("title", "Orrery building", extractor="t", evidence="primary"),
                    parser_field("startsAt", ORRERY_BUILDING, extractor="t", evidence="primary"),
                ],
            )
        ],
    )
    # A second run reads the cached card and asks the model nothing new.
    second = run_sync(settings=settings, stages=["termcards"])
    assert second.ok and llm.call_count == 1
    # This run itself kept the event: it was not deduplicated away.
    assert second.stages[0].notes[0] == "1 termcards known, 1 read, 1 events"


def test_no_termcards_and_dry_runs_are_quiet(make_settings) -> None:
    report = run_sync(settings=make_settings(), stages=["termcards"], dry_run=True)
    assert report.ok and report.stages[0].notes == [
        "no organisation in staging has a termcard URL yet"
    ]
    settings = make_settings()
    StagingStore(settings.staging_dir).write(
        "_resolved", "20261001T000000Z-aaaaaa", known_orgs_records()
    )
    report = run_sync(settings=settings, stages=["termcards"], dry_run=True)
    assert report.stages[0].notes == ["dry run: 1 termcards would be read"]


def test_the_registry_runs_inbox_instagram_termcards_before_load() -> None:
    from camsocs_pipeline.stages import STAGES

    names = [stage.name for stage in STAGES]
    assert names.index("inbox") < names.index("instagram") < names.index("termcards")
    assert names.index("termcards") < names.index("load")


def test_a_termcard_page_without_a_file_is_read_as_text(tmp_path, net) -> None:
    from camsocs_pipeline.sources.policy import SOCIETY_WEBSITE
    from camsocs_pipeline.sources.termcards import NO_CARD_FILE
    from camsocs_pipeline.stages.termcards import page_events

    net.get("https://orrery.example.org/robots.txt").mock(return_value=httpx.Response(404))
    html = (
        "<html><head><title>Term card</title></head><body><main>"
        "<h1>Michaelmas 2026 term card</h1>"
        "<p>Wednesday 21 October, 7pm: Planetarium trip</p>"
        "<p>Friday 6 November 2026, 8pm: Orrery building (members only)</p>"
        "</main></body></html>"
    )
    net.get(CARD_PAGE).mock(
        return_value=httpx.Response(200, text=html, headers={"content-type": "text/html"})
    )
    reply = {
        "events": [
            {
                "title": "Planetarium trip",
                "date": "2026-10-21",
                "start_time": "19:00",
                "when_quote": "Wednesday 21 October, 7pm",
            },
            {
                "title": "Orrery building",
                "date": "2026-11-06",
                "start_time": "20:00",
                "when_quote": "Friday 6 November 2026, 8pm",
                "members_only": True,
                "members_only_quote": "members only",
            },
        ]
    }
    llm = FakeLLM(lambda _text, _tier: reply)
    with client(tmp_path) as polite:
        skipped = fetch_termcard(polite, CARD_PAGE, SOCIETY_WEBSITE)
        assert isinstance(skipped, Skipped) and skipped.reason == NO_CARD_FILE
        events = page_events(
            polite,
            CARD_PAGE,
            SOCIETY_WEBSITE,
            org_key=ORRERY_KEY,
            org_name="CU Orrery Club",
            now=datetime(2026, 10, 9, 12, tzinfo=UTC),
            llm=llm,
            memo=None,
            calendar=TermCalendar.default(),
        )
    assert events is not None
    by_title = {next(f.value for f in e.fields if f.field == "title"): e for e in events}
    assert sorted(by_title) == ["Orrery building", "Planetarium trip"]
    assert {e.event_source for e in events} == {"termcard"}
    assert by_title["Orrery building"].visibility == "members_only"
    assert llm.calls[0]["tier"] == "bulk" and llm.calls[0]["version"] == "website_events_v1"


def test_a_card_last_modified_before_this_academic_year_is_old() -> None:
    from datetime import date

    from camsocs_pipeline.sources.termcards import modified_reason

    today = date(2026, 10, 10)
    assert modified_reason("Thu, 09 Jan 2025 15:20:47 GMT", today) == (
        "last modified before this academic year"
    )
    assert modified_reason("Mon, 02 Mar 2026 09:00:00 GMT", today) is None
    assert modified_reason("Tue, 15 Sep 2026 09:00:00 GMT", today) is None
    assert modified_reason(None, today) is None and modified_reason("garbage", today) is None
