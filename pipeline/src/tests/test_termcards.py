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
from camsocs_pipeline.extract.when import TermCalendar
from camsocs_pipeline.models.observation import EventObservation, IdentityHints, OrganiserObs
from camsocs_pipeline.pipeline.sync import run_sync
from camsocs_pipeline.sources.base import PoliteClient
from camsocs_pipeline.sources.termcards import Skipped, TermcardFile, fetch_termcard, term_hint
from camsocs_pipeline.stages.termcards import card_events
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


def test_a_card_that_does_not_say_its_term_keeps_only_dated_events() -> None:
    reply = {**TERMCARD_REPLY, "term": None, "term_year": None}
    reply["events"] = [
        *TERMCARD_REPLY["events"],
        {"title": "Open evening", "date": "2026-10-30", "start_time": "18:00"},
    ]
    notes: list[str] = []
    events = card_events(
        card("https://orrery.example.org/programme.pdf"),
        org_key=ORRERY_KEY,
        org_name="CU Orrery Club",
        listed_url="https://orrery.example.org/programme.pdf",
        now=datetime(2026, 10, 7, 12, tzinfo=UTC),
        llm=FakeLLM(lambda _text, _tier: reply),
        memo=None,
        calendar=TermCalendar.default(),
        notes=notes,
    )
    assert [next(f.value for f in e.fields if f.field == "title") for e in events] == [
        "Open evening"
    ]
    assert any("term-less" in note for note in notes)


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

    # A second run reads the cached card and asks the model nothing new.
    assert run_sync(settings=settings, stages=["termcards"]).ok
    assert llm.call_count == 1


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
