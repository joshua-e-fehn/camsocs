"""Extracted events → EventObservations: quote checks, date resolution, link
honesty, visibility, redaction, de-duplication and the reply cache."""

from __future__ import annotations

from datetime import UTC, date, datetime

import pytest

from camsocs_pipeline.claims import claims_for_event
from camsocs_pipeline.extract.dedupe import EventIndex, similar_titles
from camsocs_pipeline.extract.events import (
    EventContext,
    LlmEvent,
    LlmEvents,
    build_event,
    build_events,
    extract_events,
    load_prompt,
    redact_contacts,
    title_slug,
    verbatim_url,
)
from camsocs_pipeline.extract.memo import LLMMemo, memo_key
from camsocs_pipeline.extract.when import TermCalendar, Unresolvable
from camsocs_pipeline.keys import event_key
from tests.fakes import (
    EXPECTED_WEEKLY_STARTS,
    QUOKKA_KEY,
    WEEKLY_REPLY,
    WEEKLY_TEXT,
    FakeLLM,
)

CAL = TermCalendar.default()


def context(**overrides) -> EventContext:
    values = {
        "source_type": "mailing_list_email",
        "event_source": "mailing_list",
        "source_url": "inbound:<weekly-2@lists.cam.ac.uk>",
        "retrieved_at": datetime(2026, 10, 19, 8, 12, tzinfo=UTC),
        "source_text": redact_contacts(WEEKLY_TEXT),
        "model": "bulk-model-1",
        "prompt_version": "email_events_v1",
        "evidence": "primary",
        "visibility": "cam_only",
        "anchor": date(2026, 10, 19),
        "calendar": CAL,
        "scope": QUOKKA_KEY,
        "organiser_key": QUOKKA_KEY,
        "organiser_name": "Cambridge University Quokka Appreciation Society",
    }
    values.update(overrides)
    return EventContext(**values)


def fields_of(observation) -> dict:
    return {f.field: f for f in observation.fields}


def test_the_weekly_mail_becomes_three_resolved_events() -> None:
    events, dropped = build_events(LlmEvents.model_validate(WEEKLY_REPLY), context())
    assert dropped == []
    by_title = {fields_of(e)["title"].value: e for e in events}
    assert set(by_title) == set(EXPECTED_WEEKLY_STARTS)
    for title, starts in EXPECTED_WEEKLY_STARTS.items():
        assert fields_of(by_title[title])["startsAt"].value == starts

    quiz = fields_of(by_title["Pub Quiz"])
    assert quiz["title"].quote_check == "exact" and quiz["title"].status is None
    assert quiz["startsAt"].quote_check == "exact"
    assert quiz["startsAt"].value_raw == "Wednesday of Week 3, 7:30pm"
    assert quiz["bookingUrl"].value == "https://cuqas.example.org/quiz"
    assert quiz["price"].value == {
        "free": False,
        "text": "£3 members / £5 non-members",
        "minPence": 300,
        "maxPence": 500,
    }
    # A classification has no quote: inferred, never found.
    assert quiz["eventType"].status == "inferred"
    assert quiz["description"].quote_check == "exact"

    talk = fields_of(by_title["Marsupials of Western Australia"])
    assert "bookingUrl" not in talk  # the model's link is not in the mail
    assert talk["endsAt"].value - talk["startsAt"].value == 90 * 60_000
    assert talk["speakers"].value == [
        {"name": "Dr Ada Example", "affiliation": "Department of Zoology"}
    ]

    assert by_title["Pub Quiz"].visibility == "cam_only"
    assert by_title["Punting social"].visibility == "members_only"
    assert all(e.organisers[0].identity.known_key == QUOKKA_KEY for e in events)


def test_no_stated_time_is_an_inferred_all_day_event_and_tbc_needs_its_own_words() -> None:
    text = "Quiz night on 28 October. Speaker: Dr Ada Example and Prof Nobody. Venue TBC."
    event = LlmEvent(
        title="Quiz night",
        title_quote="Quiz night",
        date="2026-10-28",
        when_quote="28 October",
        tbc=True,
        tbc_quote="Venue TBC",
        speakers=[{"name": "Dr Ada Example"}, {"name": "Prof Invented"}],
        speakers_quote="Speaker: Dr Ada Example",
    )
    fields = fields_of(build_event(event, context(source_text=text)))
    # The date is read; "all day at midnight" is our filing, not the text's.
    assert fields["startsAt"].status == "inferred" and fields["startsAt"].evidence_quote is None
    assert fields["startsAt"].value_raw == "28 October"
    assert fields["allDay"].value is True and fields["allDay"].status == "inferred"
    assert fields["status"].evidence_quote == "Venue TBC" and fields["status"].status is None
    # One speaker the text never names, and a quiz is no talk: the list is
    # not published, and an earlier reading of it is retracted.
    assert fields["speakers"].value is None
    assert fields["speakers"].missing_reason == "not_published"


def test_speakers_are_published_for_a_talk_whose_text_names_them() -> None:
    text = "Talk on 28 October at 19:00. Speaker: Dr Ada Example (Department of Zoology)."
    base = {
        "title": "Quokka talk",
        "date": "2026-10-28",
        "start_time": "19:00",
        "when_quote": "28 October at 19:00",
        "speakers": [{"name": "Dr Ada Example", "affiliation": "Department of Zoology"}],
        "speakers_quote": "Speaker: Dr Ada Example",
    }
    talk = fields_of(build_event(LlmEvent(**base, event_type="talk"), context(source_text=text)))
    assert talk["speakers"].value == [
        {"name": "Dr Ada Example", "affiliation": "Department of Zoology"}
    ]
    assert talk["speakers"].status is None
    # The same names on a concert are performers, not speakers (D1).
    concert = fields_of(
        build_event(LlmEvent(**base, event_type="performance"), context(source_text=text))
    )
    assert concert["speakers"].missing_reason == "not_published"
    # Read off an image (no text to check the names against): not published.
    image = fields_of(build_event(LlmEvent(**base, event_type="talk"), context(source_text="")))
    assert image["speakers"].missing_reason == "not_published"


def test_external_ids_are_scoped_and_stable() -> None:
    events, _ = build_events(LlmEvents.model_validate(WEEKLY_REPLY), context())
    quiz = next(e for e in events if fields_of(e)["title"].value == "Pub Quiz")
    assert quiz.external_id == f"{QUOKKA_KEY}:2026-10-28:pub-quiz"
    # A later weekly mail repeating the quiz maps to the same event.
    again, _ = build_events(
        LlmEvents.model_validate(WEEKLY_REPLY),
        context(source_url="inbound:<weekly-3@lists.cam.ac.uk>", anchor=date(2026, 10, 26)),
    )
    assert quiz.external_id in {e.external_id for e in again}


def test_claims_carry_the_identity_fields_and_internal_source() -> None:
    events, _ = build_events(LlmEvents.model_validate(WEEKLY_REPLY), context())
    claims = claims_for_event(events[0])
    by_field = {c.field: c for c in claims}
    assert by_field["source"].value == "mailing_list"
    assert by_field["visibility"].value == "cam_only"
    assert by_field["sourceUrl"].value.startswith("inbound:")
    assert {c.entity_key for c in claims} == {event_key("mailing_list", events[0].external_id)}
    assert all(c.source_type == "mailing_list_email" for c in claims)


def test_an_unquotable_title_is_inferred_and_a_paraphrase_is_not_found() -> None:
    event = LlmEvent(title="Quiz Night Extravaganza", when_quote="sometime", date="2026-10-28")
    built = fields_of(build_event(event, context()))
    assert built["title"].status == "inferred" and built["title"].quote_check == "absent"
    assert built["startsAt"].status == "inferred"


def test_undated_events_are_dropped_with_a_reason() -> None:
    extracted = LlmEvents(events=[LlmEvent(title="Some social"), LlmEvent(title=" ")])
    events, dropped = build_events(extracted, context())
    assert events == [] and len(dropped) == 2


def test_require_term_refuses_term_weeks_without_a_term() -> None:
    event = LlmEvent(title="Pub Quiz", term_week=3, weekday="wednesday")
    with pytest.raises(Unresolvable, match="which term"):
        build_event(event, context(require_term=True))
    term = CAL.term_named("michaelmas", 2026, date(2026, 10, 1))
    assert build_event(event, context(require_term=True, term=term))


def test_verbatim_url_and_redaction() -> None:
    text = "Tickets: https://tix.example.org/a?b=1. More at https://example.org/x)"
    assert verbatim_url("https://tix.example.org/a?b=1", text) == "https://tix.example.org/a?b=1"
    assert verbatim_url("https://example.org/x", text) == "https://example.org/x"
    assert verbatim_url("https://tix.example.org/a", text) is None
    assert verbatim_url("www.example.org", text) is None
    redacted = redact_contacts("Mail jq999@cam.ac.uk or call 07700 900123 / +44 1223 760000.")
    assert "@" not in redacted and "07700" not in redacted and "1223" not in redacted
    # Times and dates survive.
    assert redact_contacts("7:30pm on 28/10/2026") == "7:30pm on 28/10/2026"


def test_title_slug_falls_back_to_a_hash_for_non_ascii_titles() -> None:
    assert title_slug("Pub Quiz!") == "pub-quiz"
    assert title_slug("中秋节晚会").startswith("h")


def test_dedupe_by_organiser_start_and_similar_title() -> None:
    assert similar_titles("Pub Quiz", "CUQAS Pub Quiz")
    assert similar_titles(
        "Marsupials of Western Australia", "Talk: Marsupials of Western Australia"
    )
    assert similar_titles("Freshers' Stargazing Night", "Freshers Stargazing")
    assert not similar_titles("Pub Quiz", "Punting social")
    events, _ = build_events(LlmEvents.model_validate(WEEKLY_REPLY), context())
    index = EventIndex()
    index.add([QUOKKA_KEY], EXPECTED_WEEKLY_STARTS["Pub Quiz"], "CUQAS Pub Quiz Night")
    duplicates = [e for e in events if index.is_duplicate_record(e)]
    assert [fields_of(e)["title"].value for e in duplicates] == ["Pub Quiz"]
    # Another organiser at the same minute is a different event.
    assert not index.is_duplicate("org-other", EXPECTED_WEEKLY_STARTS["Pub Quiz"], "Pub Quiz")


def test_extract_events_reuses_a_cached_reply(tmp_path) -> None:
    llm = FakeLLM(lambda _text, _tier: WEEKLY_REPLY)
    memo = LLMMemo(tmp_path)
    prompt, version = load_prompt("email_events_v1")
    first = extract_events(llm, memo, prompt=prompt, prompt_version=version, text="mail text")
    second = extract_events(llm, memo, prompt=prompt, prompt_version=version, text="mail text")
    assert not first.cached and second.cached
    assert second.value == first.value and second.model == "bulk-model-1"
    assert len(llm.calls) == 1
    extract_events(llm, memo, prompt=prompt, prompt_version=version, text="other text")
    assert len(llm.calls) == 2
    assert memo_key("ab", "c") != memo_key("a", "bc")


def test_every_prompt_exists_and_names_its_rules() -> None:
    for name in ("email_events_v1", "caption_events_v1", "image_events_v1"):
        text, version = load_prompt(name)
        assert version == name
        assert "term_week" in text and "quote" in text
