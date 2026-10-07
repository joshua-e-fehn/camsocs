"""Field observations and claims: no nulls, honest LLM statuses, identity
claims for events, and the server's status rules mirrored."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from camsocs_pipeline import keys
from camsocs_pipeline.claims import (
    NoLLMSource,
    claims_for_event,
    claims_for_observation,
    llm_field,
    missing_field,
    parser_field,
    stored_status,
    strip_nones,
)
from camsocs_pipeline.models.observation import (
    EventObservation,
    IdentityHints,
    Observation,
    OrganiserObs,
)

AT = datetime(2026, 10, 7, 12, 0, tzinfo=UTC)
PAGE = "Contact us at hello@cugs.org. We meet on Wednesdays in the Union."


def org_observation(**overrides) -> Observation:
    values = {
        "source_type": "society_website",
        "source_key": "https://cugs.org/",
        "source_url": "https://cugs.org/",
        "retrieved_at": AT,
        "content_sha256": "ab" * 32,
        "entity_type": "organisation",
        "identity": IdentityHints(name="CU German Society"),
        "entity_key": "org-cu-german-society",
        "fields": [parser_field("email", "hello@cugs.org", extractor="mailto", evidence="primary")],
    }
    values.update(overrides)
    return Observation(**values)


def test_parser_field_turns_empty_values_into_missing() -> None:
    for empty in (None, "", "   ", [], {}):
        obs = parser_field("socials", empty, extractor="rule", evidence="primary")
        assert (obs.status, obs.missing_reason, obs.value) == ("missing", "not_found", None)


def test_nulls_never_survive_inside_values() -> None:
    assert strip_nones({"a": None, "b": [1, None, {"c": None}]}) == {"b": [1, {}]}
    obs = parser_field(
        "mailingList", {"platform": "sympa", "address": None}, extractor="r", evidence="primary"
    )
    assert obs.value == {"platform": "sympa"}


def test_llm_field_is_found_only_with_a_verbatim_quote() -> None:
    common = {
        "source_text": PAGE,
        "source_type": "society_website",
        "model": "gpt-6-luna",
        "prompt_version": "v1",
        "evidence": "primary",
    }
    quoted = llm_field("email", "hello@cugs.org", quote="hello@cugs.org", **common)
    assert (quoted.quote_check, quoted.status, stored_status(quoted)) == ("exact", None, "found")

    made_up = llm_field("email", "info@cugs.org", quote="info@cugs.org", **common)
    assert (made_up.quote_check, made_up.status, stored_status(made_up)) == (
        "absent",
        "inferred",
        "inferred",
    )

    no_quote = llm_field("timeCommitment", "Weekly", quote=None, **common)
    assert stored_status(no_quote) == "inferred"


def test_talks_cam_never_reaches_the_llm() -> None:
    with pytest.raises(NoLLMSource):
        llm_field(
            "description",
            "x",
            quote="x",
            source_text="x",
            source_type="talks_list",
            model="gpt-6-luna",
            prompt_version="v1",
            evidence="secondary",
        )


def test_stored_status_mirrors_the_server() -> None:
    assert stored_status(
        missing_field("email", "not_found", extractor="r", evidence="primary")
    ) == ("missing")
    manual = parser_field("email", "a@b.org", extractor="r", evidence="primary").model_copy(
        update={"method": "manual"}
    )
    assert stored_status(manual) == "manual"
    heuristic = parser_field("level", "college", extractor="r", evidence="primary", inferred=True)
    assert stored_status(heuristic) == "inferred"


def test_claims_for_observation_carry_provenance_and_no_confidence() -> None:
    [claim] = claims_for_observation(org_observation())
    wire = claim.to_wire()
    assert wire == {
        "entityType": "organisation",
        "entityKey": "org-cu-german-society",
        "field": "email",
        "value": "hello@cugs.org",
        "evidence": "primary",
        "method": "parser",
        "extractor": "mailto",
        "sourceKey": keys.source_key("https://cugs.org/"),
        "sourceUrl": "https://cugs.org/",
        "sourceType": "society_website",
        "retrievedAt": int(AT.timestamp() * 1000),
        "contentSha256": "ab" * 32,
    }
    # A fingerprint the pipeline computes equals the server's.
    assert keys.claim_fingerprint(
        entity_type="organisation",
        entity_key=wire["entityKey"],
        field="email",
        value=wire["value"],
        status=stored_status(org_observation().fields[0]),
        source_url=wire["sourceUrl"],
        content_sha256=wire["contentSha256"],
        method="parser",
    ) == keys.claim_fingerprint(
        entity_type="organisation",
        entity_key="org-cu-german-society",
        field="email",
        value="hello@cugs.org",
        status="found",
        source_url="https://cugs.org/",
        content_sha256="ab" * 32,
        method="parser",
    )


def test_negative_claims_omit_the_value() -> None:
    obs = org_observation(
        fields=[missing_field("email", "access_restricted", extractor="fetch", evidence="primary")]
    )
    wire = claims_for_observation(obs)[0].to_wire()
    assert "value" not in wire
    assert (wire["status"], wire["missingReason"]) == ("missing", "access_restricted")


def test_unresolved_observations_cannot_become_claims() -> None:
    with pytest.raises(ValueError, match="not resolved"):
        claims_for_observation(org_observation(entity_key=None))


def test_team_claims_get_their_parent_org_key() -> None:
    team = Observation(
        source_type="sport_club_page",
        source_key="cuafc",
        source_url="https://www.sport.cam.ac.uk/university-sports-clubs-0/cuafc",
        retrieved_at=AT,
        entity_type="team",
        identity=IdentityHints(name="Blues"),
        parent=IdentityHints(name="CUAFC", known_key="org-cuafc"),
        entity_key=keys.team_key("org-cuafc", "Blues"),
        fields=[parser_field("name", "Blues", extractor="rule", evidence="primary")],
    )
    claims = {claim.field: claim.value for claim in claims_for_observation(team)}
    assert claims == {"name": "Blues", "orgKey": "org-cuafc"}


def test_event_claims_include_identity_and_venue_text() -> None:
    event = EventObservation(
        source_type="camdram",
        source_key="hamlet",
        source_url="https://www.camdram.net/shows/hamlet",
        retrieved_at=AT,
        event_source="camdram",
        external_id="hamlet-1",
        visibility="public",
        organisers=[OrganiserObs(identity=IdentityHints(name="ADC", known_key="org-adc"))],
        venue=IdentityHints(name="ADC Theatre"),
        fields=[
            parser_field("title", "Hamlet", extractor="camdram.title", evidence="secondary"),
            parser_field(
                "startsAt", 1791489600000, extractor="camdram.start", evidence="secondary"
            ),
        ],
    )
    claims = claims_for_event(event)
    assert {c.entity_key for c in claims} == {keys.event_key("camdram", "hamlet-1")}
    values = {c.field: c.value for c in claims}
    assert values == {
        "title": "Hamlet",
        "startsAt": 1791489600000,
        "source": "camdram",
        "externalId": "hamlet-1",
        "visibility": "public",
        "sourceUrl": "https://www.camdram.net/shows/hamlet",
        "venueText": "ADC Theatre",
    }
