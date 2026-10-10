"""Decision D1: personal names in public free text become roles before
publishing (`extract/redact.py`). Offline: the model is `FakeLLM`. Every
society and person here is fictional; texts are shaped like the SU, Camdram,
talks.cam and list-mail texts seen in the 2026-10-08 harvest."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import respx

from camsocs_pipeline.claims import build_claim, llm_field, parser_field
from camsocs_pipeline.extract.memo import LLMMemo
from camsocs_pipeline.extract.redact import (
    PROMPT_PATH,
    RULE_TAG,
    TAG,
    WITHHELD_TAG,
    Redactor,
    RedactReply,
    RedactRequest,
    accept_reply,
    candidate_names,
    private_names,
    redact_claims,
    rule_redact,
)
from camsocs_pipeline.models.observation import IdentityHints, Observation
from camsocs_pipeline.models.wire import ClaimInput
from camsocs_pipeline.pipeline.load import ConvexLoader
from tests.fakes import FakeLLM

AT = datetime(2026, 10, 8, 12, 0, tzinfo=UTC)
SITE = "https://happy-otter-123.convex.site"
ORG = "org-cambridge-university-quokka-society"

#: An SU profile's long description, as societies write them.
SU_DESCRIPTION = (
    "Welcome to the Cambridge University Quokka Society! We meet every Tuesday in "
    "Michaelmas for talks and socials.\n\n"
    "For any questions, contact our President, Anna Smith, or message Ben on Instagram."
)
SU_REDACTED = (
    "Welcome to the Cambridge University Quokka Society! We meet every Tuesday in "
    "Michaelmas for talks and socials.\n\n"
    "For any questions, contact our President or message the committee on Instagram."
)
#: A Camdram show description: crew are private, the playwright is not.
SHOW = (
    "Directed by Clara Bloggs and produced by Dev Patel-Ng, this new staging of "
    "Shakespeare's Twelfth Night opens at the ADC Theatre."
)
SHOW_REDACTED = (
    "Directed by the director and produced by the producer, this new staging of "
    "Shakespeare's Twelfth Night opens at the ADC Theatre."
)
#: A talks.cam abstract: the speaker is public, the chair is a student.
TALK = (
    "Professor Jane Doe (Department of Zoology) explains how quokkas survive on Rottnest. "
    "Chaired by Tom Brown, our President."
)


def reply(text: str, *pairs: tuple[str, str]) -> dict[str, Any]:
    return {"text": text, "redactions": [{"original": o, "replacement": r} for o, r in pairs]}


def request(text: str, **kwargs: Any) -> RedactRequest:
    return RedactRequest(text=text, safe=("quokka",), **kwargs)


# --- what may be a name ----------------------------------------------------------------------


def test_a_text_without_candidate_names_needs_no_model() -> None:
    assert candidate_names("Cambridge University Chess Club meets every Tuesday in Lent.") == {
        "Chess"
    }
    assert candidate_names("Cambridge University Chess Club meets in Lent.", ("chess",)) == set()
    assert candidate_names("Join us at Freshers' Fair in Michaelmas!") == set()
    assert candidate_names(SU_DESCRIPTION, ("quokka",)) == {"Anna", "Smith", "Ben"}
    # First names that are also words stay candidates: May, Will, Clare.
    assert candidate_names("Email Will or Clare in May.") == {"Will", "Clare", "May"}
    llm = FakeLLM(lambda _text, _tier: reply("unused"))
    redactor = Redactor(llm)  # type: ignore[arg-type]
    plain = redactor.redact(request("We meet every Tuesday in Michaelmas."))
    assert plain.method == "none" and not plain.changed
    assert llm.calls == []


# --- the model's answer and its checks -------------------------------------------------------


def test_a_faithful_reply_is_accepted_with_the_source_formatting() -> None:
    accepted = accept_reply(
        request(SU_DESCRIPTION),
        RedactReply.model_validate(
            reply(SU_REDACTED, ("Anna Smith", ""), ("Ben", "the committee"))
        ),
    )
    assert accepted is not None and accepted.method == "llm"
    assert accepted.text == SU_REDACTED
    assert "\n\n" in accepted.text  # the paragraph break survives


def test_replies_that_deviate_are_rejected() -> None:
    base = request("Contact our President, Anna Smith, for details.")
    rejected = [
        # A new word the text never had.
        reply("Contact our wonderful President for details.", ("Anna Smith", "")),
        # A replacement that is not a role or a neutral phrase.
        reply("Contact Dr Who for details.", ("Anna Smith", "Dr Who")),
        # Rewritten without saying what was replaced.
        reply("Contact the President for details."),
        # Something that is not a name (lower-case, a phrase).
        reply("Contact our President.", ("for details", "")),
        # The name is still there.
        reply("Contact our President, Anna Smith, for details.", ("Anna Smith", "")),
        # Half the text gone.
        reply("Contact.", ("Anna Smith", "")),
    ]
    for answer in rejected:
        assert accept_reply(base, RedactReply.model_validate(answer)) is None, answer
    # A kept speaker may never be redacted.
    talk = RedactRequest(text=TALK, keep=("Professor Jane Doe",), llm=True)
    assert (
        accept_reply(
            talk,
            RedactReply.model_validate(
                reply(
                    TALK.replace("Professor Jane Doe", "the speaker"), ("Jane Doe", "the speaker")
                )
            ),
        )
        is None
    )
    # A known committee member left in the text fails the check.
    private = request("Ask Anna about trials.", private=("Anna",))
    assert (
        accept_reply(private, RedactReply.model_validate(reply("Ask Anna about trials."))) is None
    )


# --- the deterministic fallback ----------------------------------------------------------------


def test_the_rule_removes_names_next_to_roles_and_contact_verbs() -> None:
    cases = {
        "For any questions, contact our President, Anna Smith, for details.": (
            "For any questions, contact our President for details."
        ),
        "Email Ben to join the mailing list.": "Email the committee to join the mailing list.",
        "Kit is ordered through Priya Shah (Treasurer) each term.": (
            "Kit is ordered through the Treasurer each term."
        ),
        "Join Max, our Social Secretary, at the pub.": "Join our Social Secretary, at the pub.",
        "Our committee:\nPresident: Anna Smith\nTreasurer: Ben Jones\n\nEveryone is welcome.": (
            "Our committee:\n\nEveryone is welcome."
        ),
    }
    for text, expected in cases.items():
        result = rule_redact(request(text))
        assert result.method == "rule", text
        assert result.text == expected, text


def test_the_rule_withholds_what_it_cannot_make_safe() -> None:
    # A name near a role word the patterns do not cover: not published.
    result = rule_redact(request("Our President this year is Anna, who loves quokkas."))
    assert result.method == "withheld" and result.text is None
    # A text that was only a committee line leaves nothing to publish.
    assert rule_redact(request("President: Anna Smith")).text is None


def test_the_rule_keeps_speakers_and_removes_known_committee_members() -> None:
    talk = rule_redact(RedactRequest(text=TALK, keep=("Professor Jane Doe",), llm=False))
    assert talk.text == (
        "Professor Jane Doe (Department of Zoology) explains how quokkas survive on Rottnest. "
        "Chaired by our President."
    )
    known = rule_redact(request("Pay Jane at the first session.", private=("Jane",)))
    # The neutral phrase claims nothing about the person (not "a member of
    # the committee"), and a sentence's first word is not part of the name.
    assert known.text == "Pay someone at the first session."


# --- the redactor ------------------------------------------------------------------------------


def test_the_model_pass_is_cached_by_the_input(tmp_path: Path) -> None:
    llm = FakeLLM(
        lambda _text, _tier: reply(SU_REDACTED, ("Anna Smith", ""), ("Ben", "the committee"))
    )
    memo = LLMMemo(tmp_path / "llm")
    first = Redactor(llm, memo).redact(request(SU_DESCRIPTION))  # type: ignore[arg-type]
    assert first.method == "llm" and first.text == SU_REDACTED
    assert llm.calls[0]["version"] == "redact_names_v2"
    assert SU_DESCRIPTION in llm.calls[0]["text"]
    # Another run: the reply comes from the cache, even without a model.
    again = Redactor(None, memo)
    assert again.redact(request(SU_DESCRIPTION)).text == SU_REDACTED
    assert again.stats.llm_cached == 1 and len(llm.calls) == 1


def test_a_deviating_reply_falls_back_to_the_rule_with_its_verified_names() -> None:
    llm = FakeLLM(lambda _text, _tier: reply("A lovely society run by lovely people.", ("Ben", "")))
    redactor = Redactor(llm)  # type: ignore[arg-type]
    result = redactor.redact(request("Socials are run by Ben every Friday."))
    assert result.method == "rule"
    assert result.text == "Socials are run by someone every Friday."
    assert redactor.stats.rejected_replies == 1


def test_a_failed_model_call_falls_back_to_the_rule() -> None:
    llm = FakeLLM(lambda _text, _tier: RuntimeError("cliproxy is down"))
    redactor = Redactor(llm)  # type: ignore[arg-type]
    result = redactor.redact(request("Contact our Captain, Sam Lee, about trials."))
    assert result.method == "rule"
    assert result.text == "Contact our Captain about trials."
    assert redactor.stats.llm_failed == 1


def test_talks_cam_text_never_reaches_the_model() -> None:
    llm = FakeLLM(lambda _text, _tier: reply("unused"))
    redactor = Redactor(llm)  # type: ignore[arg-type]
    result = redactor.redact(RedactRequest(text=TALK, keep=("Professor Jane Doe",), llm=False))
    assert result.method == "rule" and llm.calls == []


def test_the_prompt_is_versioned_and_states_the_rules() -> None:
    prompt = PROMPT_PATH.read_text(encoding="utf-8")
    assert PROMPT_PATH.name == "redact_names_v2.md"
    for rule in (
        "Keep these names",
        "Committee members",
        '"redactions"',
        "public figures",
        "namesake",
        "never leave a gap",
        "Never call someone a committee member",
    ):
        assert rule.lower() in prompt.lower()


# --- claims ------------------------------------------------------------------------------------


def claim(obs, *, entity_type: str = "organisation", key: str = ORG, **kw: Any) -> ClaimInput:
    return build_claim(
        obs,
        entity_type=entity_type,
        entity_key=key,
        source_url=kw.get("url", "https://www.cambridgesu.co.uk/organisation/1/"),
        source_type=kw.get("source_type", "su_profile"),
        retrieved_at=AT,
    )


def test_claims_carry_the_redacted_text_and_keep_the_original_internal() -> None:
    def respond(text: str, _tier: str) -> dict[str, Any]:
        if "Clara Bloggs" in text:
            return reply(
                SHOW_REDACTED, ("Clara Bloggs", "the director"), ("Dev Patel-Ng", "the producer")
            )
        return reply(SU_REDACTED, ("Anna Smith", ""), ("Ben", "the committee"))

    llm = FakeLLM(respond)
    description = claim(
        parser_field(
            "description", SU_DESCRIPTION, extractor="su_profile.description", evidence="primary"
        )
    )
    show = claim(
        parser_field("description", SHOW, extractor="camdram.description", evidence="primary"),
        entity_type="event",
        key="evt-1234",
        url="https://www.camdram.net/shows/2026-twelfth-night",
        source_type="camdram",
    )
    talk_description = claim(
        parser_field("description", TALK, extractor="talks_cam.description", evidence="primary"),
        entity_type="event",
        key="evt-5678",
        url="https://talks.cam.ac.uk/talk/index/1",
        source_type="talks_list",
    )
    talk_speakers = claim(
        parser_field(
            "speakers",
            [{"name": "Professor Jane Doe", "affiliation": "Department of Zoology"}],
            extractor="talks_cam.speakers",
            evidence="primary",
        ),
        entity_type="event",
        key="evt-5678",
        url="https://talks.cam.ac.uk/talk/index/1",
        source_type="talks_list",
    )
    email = claim(parser_field("email", "quokka@example.org", extractor="su", evidence="primary"))
    redactor = Redactor(llm)  # type: ignore[arg-type]

    posted, stats = redact_claims(
        [description, show, talk_description, talk_speakers, email], redactor
    )
    by_text = {c.entity_key + c.field: c for c in posted}

    su = by_text[ORG + "description"]
    assert su.value == SU_REDACTED
    assert su.value_raw == SU_DESCRIPTION
    assert su.extractor == "su_profile.description+" + TAG
    assert su.status is None  # found, as before
    camdram = by_text["evt-1234description"]
    assert camdram.value == SHOW_REDACTED and "Shakespeare" in camdram.value
    talk = by_text["evt-5678description"]
    assert talk.value.startswith("Professor Jane Doe") and "Tom Brown" not in talk.value
    assert talk.extractor.endswith(RULE_TAG)
    # Speakers are public: their field and other claims pass through untouched.
    assert by_text["evt-5678speakers"] == talk_speakers
    assert by_text[ORG + "email"] == email
    # talks.cam never went to the model; the SU and Camdram texts did, once each.
    assert len(llm.calls) == 2 and all("Rottnest" not in c["text"] for c in llm.calls)
    assert stats.changed == 3 and stats.texts == 3
    assert "null" not in json.dumps([c.to_wire() for c in posted])


def test_an_llm_claim_keeps_its_status_and_a_withheld_text_is_not_published() -> None:
    inferred = llm_field(
        "howToJoin",
        "Our President this year is Anna, so speak to her.",
        quote=None,
        source_text="",
        source_type="society_website",
        model="bulk-model-1",
        prompt_version="org_v1",
        evidence="primary",
    )
    posted, stats = redact_claims([claim(inferred)], Redactor())
    (withheld,) = posted
    assert withheld.value is None
    assert withheld.status == "missing" and withheld.missing_reason == "not_published"
    assert withheld.value_raw == "Our President this year is Anna, so speak to her."
    assert withheld.extractor == "bulk-model-1+" + WITHHELD_TAG
    assert "value" not in withheld.to_wire()
    assert stats.withheld == 1

    kept = llm_field(
        "howToJoin",
        "Message Ben on Instagram to join.",
        quote=None,
        source_text="",
        source_type="society_website",
        model="bulk-model-1",
        prompt_version="org_v1",
        evidence="primary",
    )
    (redacted,) = redact_claims([claim(kept)], Redactor())[0]
    assert redacted.value == "Message the committee on Instagram to join."
    assert redacted.status == "inferred"  # unchanged by the redaction


def test_a_longer_role_never_breaks_the_short_description_limit() -> None:
    text = "Quokka fans unite! " * 9 + "Ask Bo."
    assert len(text) <= 200
    llm = FakeLLM(
        lambda _t, _tier: reply(text.replace("Bo.", "the committee."), ("Bo", "the committee"))
    )
    obs = parser_field("shortDescription", text, extractor="su_profile.short", evidence="primary")
    (posted,) = redact_claims([claim(obs)], Redactor(llm))[0]  # type: ignore[arg-type]
    assert len(posted.value) <= 200 and "Bo" not in posted.value


def test_private_names_come_from_the_broker_people_of_the_entity() -> None:
    record = Observation(
        source_type="society_website",
        source_key="https://quokka.example.org/committee",
        source_url="https://quokka.example.org/committee",
        retrieved_at=AT,
        entity_type="organisation",
        identity=IdentityHints(name="Quokka Society"),
        entity_key=ORG,
        broker={
            "people": [{"name": "Anna Smith", "role": "President", "method": "llm"}],
            "private_names": ["Ben Jones"],
        },
    )
    assert private_names([record]) == {ORG: ("Anna Smith", "Ben Jones")}


def test_post_observations_never_posts_a_name_it_knows(net: respx.MockRouter) -> None:
    # End to end through the loader: the committee member's name is in the
    # private people row (D2) and only in the claim's internal valueRaw.
    bodies: dict[str, list[Any]] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path.removeprefix("/api/pipeline/")
        bodies.setdefault(path, []).append(json.loads(request.content))
        body: dict[str, Any] = {"inserted": 1, "updated": 0, "unchanged": 0}
        if path == "claims":
            body |= {"entities": {"created": 1}, "rejected": []}
        return httpx.Response(200, json=body)

    net.post(url__startswith=f"{SITE}/api/pipeline/").mock(side_effect=handler)
    record = Observation(
        source_type="society_website",
        source_key="https://quokka.example.org/",
        source_url="https://quokka.example.org/",
        retrieved_at=AT,
        entity_type="organisation",
        identity=IdentityHints(name="Quokka Society"),
        entity_key=ORG,
        fields=[
            parser_field("name", "Quokka Society", extractor="t", evidence="primary"),
            parser_field(
                "howToJoin",
                "Turn up on Tuesday and say hello to Priya at the door.",
                extractor="website.how_to_join",
                evidence="primary",
            ),
        ],
        broker={"people": [{"name": "Priya", "role": "Secretary", "method": "llm"}]},
    )
    llm = FakeLLM(
        lambda _t, _tier: reply(
            "Turn up on Tuesday and say hello to the Secretary at the door.",
            ("Priya", "the Secretary"),
        )
    )
    ConvexLoader(SITE, "k", max_retries=0).post_observations(
        [record],
        run_key="r1",
        redactor=Redactor(llm),  # type: ignore[arg-type]
    )
    claims = bodies["claims"][0]["claims"]
    how = next(c for c in claims if c["field"] == "howToJoin")
    assert how["value"] == "Turn up on Tuesday and say hello to the Secretary at the door."
    assert "Priya" in how["valueRaw"]
    assert all("Priya" not in json.dumps(c.get("value")) for c in claims)
    people = [p for body in bodies["brokerInferences"] for p in body.get("people", [])]
    assert [p["name"] for p in people] == ["Priya"]


# --- review findings 2026-10-10 (D1 scope, the fallback, links, speakers) -------------------------

#: The shape of an SU description seen on 2026-10-08 (names made up): the
#: president's full name and a member's, each linked to a LinkedIn profile.
LINKED = (
    "**Some committee positions are open.****For details, please contact our president "
    "[Sebastiano Quokka Marinos](https://www.linkedin.com/in/sebastiano-quokka-marinos/) "
    "(Robinson College) or [Jan-Pieter Wombat](https://www.linkedin.com/in/jpwombat/) "
    "(Darwin College).**"
)


def test_a_title_followed_by_a_surname_is_risky() -> None:
    from camsocs_pipeline.extract.redact import _risky

    assert _risky("contact our President Habersack Martos today", set(), ())
    # A title or a team after "the" / "our" stays fine.
    assert not _risky("Contact the Lower Boats Captains today.", set(), ())


def test_profile_links_never_survive_and_partial_names_take_the_whole_name() -> None:
    from camsocs_pipeline.extract.redact import strip_profile_links

    stripped = strip_profile_links(LINKED)
    assert "linkedin" not in stripped and "Sebastiano Quokka Marinos (Robinson College)" in stripped
    # The model's reply failed its checks (it deleted the links); the rule
    # applies its verified names longest first, so the first name alone
    # cannot leave the surname behind.
    llm = FakeLLM(
        lambda _t, _tier: reply(
            "For details, contact our president.",
            ("Sebastiano", "our President"),
            ("Sebastiano Quokka Marinos", "our president"),
            ("Jan-Pieter Wombat", "the committee"),
        )
    )
    result = Redactor(llm).redact(RedactRequest(text=LINKED))  # type: ignore[arg-type]
    assert result.method == "rule"
    assert result.text == (
        "**Some committee positions are open.****For details, please contact our president "
        "(Robinson College) or the committee (Darwin College).**"
    )
    for part in ("Quokka", "Marinos", "Wombat", "linkedin", "jpwombat"):
        assert part not in (result.text or "")


def test_a_link_that_spells_a_redacted_name_keeps_only_its_label() -> None:
    text = "The logo was made for us by [Ana Example](https://www.anaexample.com/) last year."
    llm = FakeLLM(
        lambda _t, _tier: reply(
            "The logo was made for us by [someone](https://www.anaexample.com/) last year.",
            ("Ana Example", "someone"),
        )
    )
    result = Redactor(llm).redact(RedactRequest(text=text))  # type: ignore[arg-type]
    assert result.text == "The logo was made for us by someone last year."
    # A booking link that spells a first name: the link goes, the text stays.
    booking = "Book a chat with [Jian](https://cal.com/jian-example) about joining."
    llm = FakeLLM(
        lambda _t, _tier: reply(
            "Book a chat with [our President](https://cal.com/jian-example) about joining.",
            ("Jian", "our President"),
        )
    )
    done = Redactor(llm).redact(RedactRequest(text=booking))  # type: ignore[arg-type]
    assert done.text == "Book a chat with our President about joining."


def test_the_gate_reads_capitals_lower_case_and_other_scripts() -> None:
    from camsocs_pipeline.extract.redact import needs_model

    texts = [
        "PRESIDENT: ANNA SMITH\nTREASURER: JOHN DOE",
        "president - anna smith",
        "ANNA SMITH (President) and JOHN DOE (Treasurer) welcome you",
        "会长：王小明，欢迎联系！",  # noqa: RUF001 (a Chinese society's own punctuation)
    ]
    for text in texts:
        assert needs_model(text), text
        # The model failed: never published as it stands.
        assert rule_redact(RedactRequest(text=text), strict=True).text is None, text
    # A college word is safe in its college's name only.
    assert candidate_names("We meet at Robinson College and Jesus College.") == set()
    assert candidate_names("Talks by Robinson and Hall.") == {"Robinson", "Hall"}


def test_credits_make_a_name_risky_for_the_rule() -> None:
    result = rule_redact(request("Directed by Lucy Hall, produced by Sidney Grace."))
    assert result.method == "withheld" and result.text is None


def test_a_reply_that_leaves_an_empty_slot_is_rejected() -> None:
    text = "Our coach in Michaelmas, Sam Example, is an excellent physio."
    assert (
        accept_reply(
            request(text),
            RedactReply.model_validate(
                reply("Our coach in Michaelmas, , is an excellent physio.", ("Sam Example", ""))
            ),
        )
        is None
    )


def event_claim(field: str, value: Any, *, key: str = "evt-1", **kw: Any) -> ClaimInput:
    method = kw.pop("method", "parser")
    if method == "llm":
        obs = llm_field(
            field,
            value,
            quote=kw.pop("quote", None),
            source_text=kw.pop("source_text", ""),
            source_type="society_website",
            model="bulk-model-1",
            prompt_version="website_events_v1",
            evidence="primary",
        )
    else:
        obs = parser_field(field, value, extractor=f"ics.{field}", evidence="primary")
    return claim(
        obs,
        entity_type="event",
        key=key,
        url=kw.get("url", "https://calendar.google.com/calendar/ical/x/public/basic.ics"),
        source_type=kw.get("source_type", "ics_feed"),
    )


def test_an_event_title_is_redacted_and_an_unsafe_one_drops_the_event() -> None:
    def respond(text: str, _tier: str) -> dict[str, Any]:
        if "Ann Example" in text:
            return reply("Room booking (someone)", ("Ann Example", "someone"))
        return reply("Something else entirely")  # fails its checks

    llm = FakeLLM(respond)
    claims = [
        event_claim("title", "Room booking (Ann Example)", key="evt-a"),
        event_claim("startsAt", 1_791_000_000_000, key="evt-a"),
        event_claim("title", "Supper with Bo Quokkason", key="evt-b"),
        event_claim("startsAt", 1_791_000_000_000, key="evt-b"),
    ]
    posted, stats = redact_claims(claims, Redactor(llm))  # type: ignore[arg-type]
    titles = {c.entity_key: c.value for c in posted if c.field == "title"}
    assert titles == {"evt-a": "Room booking (someone)"}
    # The unsafe title takes all of its event's claims with it.
    assert {c.entity_key for c in posted} == {"evt-a"}
    assert stats.dropped == ["evt-b"]


def test_venues_prices_and_chat_notes_are_redacted_too() -> None:
    from camsocs_pipeline.extract.redact import PUBLIC_TEXT_FIELDS

    for target in [
        ("event", "title"),
        ("event", "venueText"),
        ("event", "price"),
        ("session", "title"),
        ("session", "venueText"),
        ("organisation", "sport.kitCostNote"),
        ("organisation", "chatChannels"),
    ]:
        assert target in PUBLIC_TEXT_FIELDS
    price = event_claim(
        "price", {"free": False, "text": "£5, organised by Bo Quokkason"}, key="evt-p"
    )
    (posted,), _ = redact_claims([price], Redactor())
    # No model: the rule withholds the note, the rest of the price stays.
    assert posted.value == {"free": False}


def test_speakers_only_for_talks_and_never_a_known_committee_member() -> None:
    source = "MagSoc: an evening concert under the baton of Fred Example and Sam Example."
    performance = [
        event_claim("eventType", "performance", key="evt-m", method="llm"),
        event_claim(
            "speakers",
            [{"name": "Fred Example"}, {"name": "Sam Example"}],
            key="evt-m",
            method="llm",
            quote="Fred Example and Sam Example",
            source_text=source,
        ),
        event_claim("description", source, key="evt-m", method="llm", quote=source),
    ]
    talk_text = "A talk by Professor Jane Doe, hosted by Fred Example."
    talk = [
        event_claim("eventType", "talk", key="evt-t", method="llm"),
        event_claim(
            "speakers",
            [{"name": "Professor Jane Doe"}, {"name": "Fred Example"}],
            key="evt-t",
            method="llm",
            quote="Professor Jane Doe, hosted by Fred Example",
            source_text=talk_text,
        ),
    ]
    posted, stats = redact_claims(
        [*performance, *talk], Redactor(), private={"org-jazz": ("Fred Example",)}
    )
    by = {(c.entity_key, c.field): c for c in posted}
    # A concert's conductors are not speakers: the list is retracted …
    retracted = by[("evt-m", "speakers")]
    assert retracted.value is None and retracted.missing_reason == "not_published"
    # … and a talk's list loses the known committee member (of any society).
    assert by[("evt-t", "speakers")].value == [{"name": "Professor Jane Doe"}]
    assert stats.speakers_withheld == 1
    # A first name alone on some committee (D2) does not unname a speaker.
    from camsocs_pipeline.extract.redact import _known

    assert not _known("Professor Jane Doe", ["Jane"])
    assert _known("Jane", ["Jane"]) and _known("Prof Jane Doe", ["Jane Doe"])


def test_an_organisations_committee_is_applied_to_its_events() -> None:
    from camsocs_pipeline.models.observation import EventObservation, OrganiserObs

    org = Observation(
        source_type="society_website",
        source_key="https://quokka.example.org/committee",
        source_url="https://quokka.example.org/committee",
        retrieved_at=AT,
        entity_type="organisation",
        identity=IdentityHints(name="Quokka Society"),
        entity_key=ORG,
        broker={"people": [{"name": "Anna Smith", "role": "President", "method": "llm"}]},
    )
    event = EventObservation(
        source_type="ics_feed",
        source_key="uid-1",
        source_url="https://calendar.google.com/calendar/ical/q/public/basic.ics",
        retrieved_at=AT,
        event_source="google_calendar",
        external_id="uid-1",
        visibility="public",
        organisers=[OrganiserObs(identity=IdentityHints(name="Quokka Society", known_key=ORG))],
    )
    from camsocs_pipeline.keys import event_key

    names = private_names([org, event])
    assert names[event_key("google_calendar", "uid-1")] == ("Anna Smith",)
