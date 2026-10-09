"""The `inbox` stage (source-research §16) on synthetic list mail: sender
identification, extraction, term-week dates, visibility, attachments,
outcomes, and the post-then-mark order — offline (fake LLM, respx Convex)."""

from __future__ import annotations

import base64
import io
import json
from datetime import UTC, datetime

import httpx
import openai
import pytest
import respx
from PIL import Image

import camsocs_pipeline.pipeline.load as load
from camsocs_pipeline.extract.dedupe import EventIndex
from camsocs_pipeline.extract.when import TermCalendar
from camsocs_pipeline.known_orgs import KnownOrgs
from camsocs_pipeline.models.observation import EventObservation
from camsocs_pipeline.models.wire import InboundAttachment, PendingMail
from camsocs_pipeline.pipeline.load import ConvexLoader
from camsocs_pipeline.pipeline.state import load_state
from camsocs_pipeline.pipeline.sync import run_sync
from camsocs_pipeline.sources.inbox import (
    forwarded_headers,
    identify_sender,
    is_list_mail,
    list_name_of,
    parse_sender,
)
from camsocs_pipeline.stages import inbox
from camsocs_pipeline.staging.store import StagingStore
from tests.fakes import (
    EXPECTED_WEEKLY_STARTS,
    FORWARDED,
    FORWARDED_REPLY,
    NOT_LIST,
    QUOKKA_KEY,
    WEEKLY,
    WEEKLY_REPLY,
    WELCOME,
    FakeLLM,
    invalid_reply,
    known_orgs_records,
)

SITE = "https://happy-otter-123.convex.site"


@pytest.fixture(autouse=True)
def _no_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(load.time, "sleep", lambda _seconds: None)


def replies(text: str, _tier: str):
    if "Marsupials" in text:
        return WEEKLY_REPLY
    if "Orrery" in text:
        return FORWARDED_REPLY
    if "Welcome to list" in text:
        return {"events": []}
    if "BROKEN" in text:
        return invalid_reply()
    if "OFFLINE" in text:
        return openai.APIConnectionError(request=httpx.Request("POST", "http://llm.test"))
    raise AssertionError(f"unexpected LLM request: {text[:80]}")


def tools(llm: FakeLLM | None = None, loader=None, index: EventIndex | None = None):
    return inbox.InboxTools(
        llm=llm or FakeLLM(replies),
        memo=None,
        known=KnownOrgs.from_records(known_orgs_records()),
        index=index or EventIndex(),
        calendar=TermCalendar.default(),
        loader=loader,
        now=lambda: datetime(2026, 11, 1, 12, 0, tzinfo=UTC),
    )


def titles(outcome) -> dict[str, EventObservation]:
    return {
        next(f.value for f in event.fields if f.field == "title"): event for event in outcome.events
    }


def starts(event: EventObservation) -> int:
    return next(f.value for f in event.fields if f.field == "startsAt")


# --- sender identification ---------------------------------------------------------------


def test_sender_helpers() -> None:
    assert parse_sender('"CU Orrery Club" <Soc-Orrery@lists.cam.ac.uk>').address == (
        "soc-orrery@lists.cam.ac.uk"
    )
    forwarded = forwarded_headers(FORWARDED.text)
    assert forwarded is not None and forwarded.list_name == "soc-orrery-announce"
    assert forwarded.subject == "Orrery Club: Michaelmas termcard"
    assert list_name_of(WEEKLY) == "soc-cuqas"
    assert is_list_mail(WEEKLY) and is_list_mail(FORWARDED)
    assert not is_list_mail(NOT_LIST)


def test_identify_sender_by_list_and_address_of_a_verified_sender() -> None:
    known = KnownOrgs.from_records(known_orgs_records())
    assert identify_sender(WEEKLY, known).org_key == QUOKKA_KEY
    assert identify_sender(NOT_LIST, known).org_key is None
    direct = WEEKLY.model_copy(
        update={"list_id": None, "from_": "Committee <committee@cuqas.example.org>"}
    )
    assert identify_sender(direct, known).how == "sender address"
    recorded = NOT_LIST.model_copy(update={"org_key": "org-x"})
    assert identify_sender(recorded, known).org_key == "org-x"


def test_what_a_sender_writes_never_attributes_a_mail() -> None:
    known = KnownOrgs.from_records(known_orgs_records())
    # Unverified: a forged List-Id or sender address speaks for nobody.
    forged = WEEKLY.model_copy(update={"sender_verified": False})
    assert identify_sender(forged, known).org_key is None
    assert identify_sender(forged, known).how.startswith("sender not verified")
    # A display name alone, even on a verified (webmail) sender.
    by_name = WEEKLY.model_copy(
        update={"list_id": None, "from_": '"CU Orrery Club" <someone@gmail.com>'}
    )
    assert identify_sender(by_name, known).org_key is None
    # An inline-forwarded header block is body text.
    assert identify_sender(FORWARDED, known).org_key is None


# --- one mail at a time ----------------------------------------------------------------------


def test_a_mail_dated_in_the_future_is_clamped_to_now() -> None:
    fast_clock = tools()
    fast_clock.now = lambda: datetime(2026, 10, 19, 6, 0, tzinfo=UTC)  # before the Date header
    outcome = inbox.process_mail(WEEKLY, fast_clock)
    (activity,) = outcome.extra
    assert activity.fields[0].value == int(
        datetime(2026, 10, 19, 6, 0, tzinfo=UTC).timestamp() * 1000
    )
    assert all(e.retrieved_at <= datetime(2026, 10, 19, 6, 0, tzinfo=UTC) for e in outcome.events)


def test_a_weekly_newsletter_becomes_dated_cam_only_events() -> None:
    llm = FakeLLM(replies)
    outcome = inbox.process_mail(WEEKLY, tools(llm))
    assert outcome.extraction == "done" and outcome.org_key == QUOKKA_KEY
    found = titles(outcome)
    assert {title: starts(event) for title, event in found.items()} == EXPECTED_WEEKLY_STARTS
    assert found["Pub Quiz"].visibility == "cam_only"
    assert found["Punting social"].visibility == "members_only"
    assert all(e.source_url == f"inbound:{WEEKLY.message_id}" for e in outcome.events)
    # The organisation's own list is primary evidence.
    assert {f.evidence for e in outcome.events for f in e.fields} == {"primary"}
    # Contact details never reach the model; the calendar facts do.
    sent = llm.calls[0]["text"]
    assert "@" not in sent and "07700" not in sent
    assert "Week 1 starts Thursday 8 October 2026" in sent
    assert llm.calls[0]["tier"] == "bulk" and llm.calls[0]["version"] == "email_events_v1"
    # The mail is dated activity of the society.
    (activity,) = outcome.extra
    assert activity.entity_key == QUOKKA_KEY
    assert activity.fields[0].field == "lastActiveAt"
    assert activity.fields[0].value == WEEKLY.received_at


def test_an_inline_forward_is_read_but_not_attributed() -> None:
    outcome = inbox.process_mail(FORWARDED, tools())
    # Its header block is a list signal, never an attribution: the events are
    # read, unattributed, and claim no organisation's activity.
    assert outcome.extraction == "done" and outcome.org_key is None
    assert outcome.extra == []
    assert all(event.organisers == [] for event in outcome.events)
    found = titles(outcome)
    # Week 1 Thursday 8pm BST = 19:00 UTC; Week 4 Tuesday 7pm GMT.
    assert starts(found["Freshers' Stargazing"]) == int(
        datetime(2026, 10, 8, 19, 0, tzinfo=UTC).timestamp() * 1000
    )
    assert starts(found["Building a Tellurion workshop"]) == int(
        datetime(2026, 11, 3, 19, 0, tzinfo=UTC).timestamp() * 1000
    )


def test_non_list_mail_is_skipped_before_any_llm_call() -> None:
    llm = FakeLLM(replies)
    outcome = inbox.process_mail(NOT_LIST, tools(llm))
    assert outcome.extraction == "skipped" and outcome.notes == ["not list mail"]
    assert llm.calls == []


def test_a_mail_without_events_is_skipped_but_still_counts_as_activity() -> None:
    outcome = inbox.process_mail(WELCOME, tools())
    assert outcome.extraction == "skipped" and "no events" in outcome.notes
    assert outcome.org_key == QUOKKA_KEY and len(outcome.extra) == 1


def test_an_unverified_mail_claims_no_activity() -> None:
    forged = WEEKLY.model_copy(update={"sender_verified": False})
    outcome = inbox.process_mail(forged, tools())
    assert outcome.org_key is None and outcome.extra == []
    assert all(event.organisers == [] for event in outcome.events)
    assert {f.evidence for e in outcome.events for f in e.fields} == {"secondary"}


def test_an_invalid_reply_fails_and_a_transport_error_leaves_it_pending() -> None:
    broken = WEEKLY.model_copy(
        update={"message_id": "<b@x>", "subject": "News", "text": "BROKEN reply please"}
    )
    assert inbox.process_mail(broken, tools()).extraction == "failed"
    offline = WEEKLY.model_copy(
        update={"message_id": "<o@x>", "subject": "News", "text": "OFFLINE now"}
    )
    assert inbox.process_mail(offline, tools()).extraction is None


def test_events_known_from_another_source_are_dropped() -> None:
    index = EventIndex()
    index.add([QUOKKA_KEY], EXPECTED_WEEKLY_STARTS["Pub Quiz"], "CUQAS Pub Quiz")
    outcome = inbox.process_mail(WEEKLY, tools(index=index))
    assert "Pub Quiz" not in titles(outcome)
    assert any("already known" in note for note in outcome.notes)


def test_an_unidentified_sender_gets_secondary_evidence_and_a_list_scope() -> None:
    stranger = WEEKLY.model_copy(
        update={
            "list_id": "soc-unknown.lists.cam.ac.uk",
            "list_name": None,
            "from_": "A Sender <someone@example.com>",
        }
    )
    llm = FakeLLM(
        lambda text, tier: {**WEEKLY_REPLY, "society_name": None, "society_name_quote": None}
    )
    outcome = inbox.process_mail(stranger, tools(llm))
    assert outcome.extraction == "done" and outcome.org_key is None
    assert all(not e.organisers for e in outcome.events)
    assert all(e.external_id.startswith("list:soc-unknown:") for e in outcome.events)
    assert {f.evidence for e in outcome.events for f in e.fields} == {"secondary"}


def test_a_society_name_in_the_sign_off_identifies_the_sender_only_if_quoted() -> None:
    stranger = WEEKLY.model_copy(
        update={
            "list_id": "soc-unknown.lists.cam.ac.uk",
            "list_name": None,
            "from_": "A Sender <someone@example.com>",
        }
    )
    outcome = inbox.process_mail(stranger, tools())
    assert outcome.org_key == QUOKKA_KEY  # quote verified in the mail
    unquoted = FakeLLM(
        lambda text, tier: {**WEEKLY_REPLY, "society_name_quote": "the Quokka people"}
    )
    assert inbox.process_mail(stranger, tools(unquoted)).org_key is None


class FileLoader:
    def __init__(self, files: dict[str, bytes]) -> None:
        self.files = files

    def inbound_file(self, message_id: str, storage_id: str) -> bytes | None:
        return self.files.get(storage_id)


def _png() -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (40, 20), "white").save(out, format="PNG")
    return out.getvalue()


def test_an_attached_termcard_is_read_with_vision() -> None:
    mail = WELCOME.model_copy(
        update={
            "message_id": "<termcard@lists.cam.ac.uk>",
            "text": "Our termcard is attached. See you there!",
            "attachments": [
                InboundAttachment(
                    storage_id="kg2storage1",
                    filename="CUQAS-termcard.png",
                    content_type="image/png",
                )
            ],
        }
    )

    def respond(text: str, tier: str):
        if tier == "bulk":
            return {"needs_image": True, "events": []}
        return {
            "term": "michaelmas",
            "term_year": 2026,
            "events": [
                {
                    "title": "Quokka Film Night",
                    "term_week": 5,
                    "weekday": "monday",
                    "start_time": "20:00",
                    "when_quote": "Wk 5 Mon 8pm",
                    "event_type": "social",
                }
            ],
        }

    llm = FakeLLM(respond)
    outcome = inbox.process_mail(mail, tools(llm, loader=FileLoader({"kg2storage1": _png()})))
    assert outcome.extraction == "done"
    (event,) = outcome.events
    assert [call["tier"] for call in llm.calls] == ["bulk", "strong"]
    assert llm.calls[1]["images"] == 1
    # Week 5 Monday of Michaelmas 2026 = Mon 9 Nov 2026, 20:00 GMT.
    assert starts(event) == int(datetime(2026, 11, 9, 20, 0, tzinfo=UTC).timestamp() * 1000)
    # Nothing on an image can be checked against text: inferred.
    title = next(f for f in event.fields if f.field == "title")
    assert title.status == "inferred"
    assert event.visibility == "cam_only"
    assert "#" in event.external_id  # scoped to the attachment


# --- the stage: post, then mark ------------------------------------------------------------------


def mock_convex(net: respx.MockRouter, pending: list[PendingMail]) -> dict[str, respx.Route]:
    def ok(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"inserted": 1, "updated": 0, "unchanged": 0})

    routes = {
        "pending": net.post(f"{SITE}/api/pipeline/inbound/pending").mock(
            return_value=httpx.Response(
                200, json=[m.model_dump(by_alias=True, exclude_none=True) for m in pending]
            )
        ),
        "mark": net.post(f"{SITE}/api/pipeline/inbound/mark").mock(side_effect=ok),
    }
    for name in ("sources", "claims", "orgInternal", "relationships", "eventOrganisers"):
        routes[name] = net.post(f"{SITE}/api/pipeline/{name}").mock(side_effect=ok)
    routes["broker"] = net.post(f"{SITE}/api/pipeline/brokerInferences").mock(side_effect=ok)
    return routes


def llm_completion(request: httpx.Request) -> httpx.Response:
    body = json.loads(request.content)
    user = body["messages"][-1]["content"]
    reply = replies(user if isinstance(user, str) else user[0]["text"], "bulk")
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
                    "message": {"role": "assistant", "content": json.dumps(reply)},
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
    )


def test_the_stage_posts_events_then_marks_every_mail(make_settings, net) -> None:
    settings = stage_settings(make_settings)
    StagingStore(settings.staging_dir).write(
        "_resolved", "20261001T000000Z-aaaaaa", known_orgs_records()
    )
    routes = mock_convex(net, [WEEKLY, NOT_LIST, WELCOME])
    llm_route = net.post("http://llm.test/v1/chat/completions").mock(side_effect=llm_completion)
    net.get(f"{SITE}/api/pipeline/health").mock(return_value=httpx.Response(200, json={"ok": True}))
    net.post(f"{SITE}/api/pipeline/runs/start").mock(return_value=httpx.Response(200, json={}))
    net.post(f"{SITE}/api/pipeline/runs/finish").mock(return_value=httpx.Response(200, json={}))
    net.post(f"{SITE}/api/pipeline/suppressions").mock(
        return_value=httpx.Response(200, json={"organisations": [], "truncated": False})
    )

    report = run_sync(settings=settings, stages=["inbox"])
    assert report.ok, report.summary()
    # The weekly mail only: the list's welcome is all footer once cleaned
    # (nothing left to read), and the stranger is never read.
    assert llm_route.call_count == 1

    claims = json.loads(routes["claims"].calls[0].request.content)["claims"]
    assert {c["sourceUrl"] for c in claims} >= {f"inbound:{WEEKLY.message_id}"}
    assert {c["value"] for c in claims if c["field"] == "visibility"} == {
        "cam_only",
        "members_only",
    }
    # Posted before marked.
    paths = [call.request.url.path for call in net.calls]
    assert paths.index("/api/pipeline/claims") < paths.index("/api/pipeline/inbound/mark")
    marks = json.loads(routes["mark"].calls[0].request.content)["items"]
    by_id = {m["messageId"]: m for m in marks}
    assert by_id[WEEKLY.message_id]["extraction"] == "done"
    assert len(by_id[WEEKLY.message_id]["extractedEventKeys"]) == 3
    assert by_id[WEEKLY.message_id]["orgKey"] == QUOKKA_KEY
    assert by_id[NOT_LIST.message_id]["extraction"] == "skipped"
    assert by_id[WELCOME.message_id]["extraction"] == "skipped"
    # Nothing in a mark is null.
    assert all(value is not None for mark in marks for value in mark.values())

    # A record of what was posted, and what the worklist needs to know.
    staged = StagingStore(settings.staging_dir).read_latest("mailing_list_email")
    assert sum(isinstance(r, EventObservation) for r in staged) == 3
    state = load_state(settings.state_path)
    assert QUOKKA_KEY in state.stage_data["inbox"]["org_last_mail"]
    assert "soc-cuqas" in state.stage_data["inbox"]["lists_seen"]


def test_the_stage_does_nothing_without_pending_mail(make_settings, net) -> None:
    settings = stage_settings(make_settings)
    mock_convex(net, [])
    loader = ConvexLoader(SITE, "test-key", max_retries=0)
    from camsocs_pipeline.pipeline.report import RunReport, StageReport
    from camsocs_pipeline.pipeline.state import SyncState

    stage = StageReport("inbox")
    ctx = inbox.StageContext(
        settings=settings,
        report=stage,
        run=RunReport(run_key="20261007T000000Z-aaaaaa", command="sync", dry_run=False),
        loader=loader,
        state=SyncState(),
        staging=StagingStore(settings.staging_dir),
        dry_run=False,
        limit=None,
    )
    inbox.run(ctx)
    assert stage.notes == ["no pending mail"]


def test_a_dry_run_reads_no_mail(make_settings) -> None:
    report = run_sync(settings=make_settings(), stages=["inbox"], dry_run=True)
    assert report.ok
    assert report.stages[0].notes == ["no pending mail"]


def test_attachment_bytes_round_trip_through_the_loader(net) -> None:
    net.post(f"{SITE}/api/pipeline/inbound/file").mock(
        side_effect=[
            httpx.Response(
                200,
                json={
                    "data": base64.b64encode(b"%PDF-1.4").decode(),
                    "contentType": "application/pdf",
                    "filename": "termcard.pdf",
                },
            ),
            httpx.Response(404, json={"error": "File not found for this message"}),
        ]
    )
    loader = ConvexLoader(SITE, "test-key", max_retries=0)
    assert loader.inbound_file("<m@x>", "kg2abc") == b"%PDF-1.4"
    assert loader.inbound_file("<m@x>", "kg2zzz") is None
