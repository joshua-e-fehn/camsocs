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
    assert known.text == "Pay a member of the committee at the first session."


# --- the redactor ------------------------------------------------------------------------------


def test_the_model_pass_is_cached_by_the_input(tmp_path: Path) -> None:
    llm = FakeLLM(
        lambda _text, _tier: reply(SU_REDACTED, ("Anna Smith", ""), ("Ben", "the committee"))
    )
    memo = LLMMemo(tmp_path / "llm")
    first = Redactor(llm, memo).redact(request(SU_DESCRIPTION))  # type: ignore[arg-type]
    assert first.method == "llm" and first.text == SU_REDACTED
    assert llm.calls[0]["version"] == "redact_names_v1"
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
    assert result.text == "Socials are run by a member of the committee every Friday."
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
    assert PROMPT_PATH.name == "redact_names_v1.md"
    for rule in ("Keep these names", "Committee members", '"redactions"', "public figures"):
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
