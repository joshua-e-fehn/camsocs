"""Key minting must match webapp/lib/keys.ts byte for byte: both suites assert
webapp/lib/keys.fixtures.json."""

from __future__ import annotations

import json

import pytest

from camsocs_pipeline import keys
from camsocs_pipeline.config import REPO_ROOT

FIXTURES = json.loads(
    (REPO_ROOT / "webapp" / "lib" / "keys.fixtures.json").read_text(encoding="utf-8")
)


def test_hashes() -> None:
    for case in FIXTURES["hashes"]:
        assert keys.sha1_hex(case["input"]) == case["sha1"]
        assert keys.sha256_hex(case["input"]) == case["sha256"]


@pytest.mark.parametrize("case", FIXTURES["slugify"], ids=lambda case: case["input"][:30])
def test_slugify_matches_typescript(case: dict) -> None:
    assert keys.slugify(case["input"]) == case["slug"]


@pytest.mark.parametrize("text", FIXTURES["slugifyErrors"])
def test_slugify_refuses_names_with_nothing_ascii(text: str) -> None:
    with pytest.raises(ValueError):
        keys.slugify(text)


def test_key_minting_matches_typescript() -> None:
    for case in FIXTURES["orgKey"]:
        assert keys.org_key(case["name"]) == case["key"]
    for case in FIXTURES["venueKey"]:
        assert keys.venue_key(case["name"]) == case["key"]
    for case in FIXTURES["teamKey"]:
        assert keys.team_key(case["orgKey"], case["name"]) == case["key"]
    for case in FIXTURES["sessionKey"]:
        minted = keys.session_key(
            case["orgKey"], case["title"], case.get("dayOfWeek"), case.get("startTime")
        )
        assert minted == case["key"]
    for case in FIXTURES["eventKey"]:
        assert keys.event_key(case["source"], case["externalId"]) == case["key"]
    for case in FIXTURES["relationshipKey"]:
        assert keys.relationship_key(case["fromKey"], case["type"], case["toKey"]) == case["key"]
    for case in FIXTURES["sourceKey"]:
        assert keys.source_key(case["url"]) == case["key"]
    for case in FIXTURES["personKey"]:
        assert keys.person_key(case["orgKey"], case["name"]) == case["key"]


def test_canonical_json_matches_typescript() -> None:
    for case in FIXTURES["canonicalJson"]:
        assert keys.canonical_json(case["value"]) == case["json"]
    # JavaScript has one number type: an integral float prints as an int.
    assert keys.canonical_json({"b": 1.0, "a": 1.5}) == '{"a":1.5,"b":1}'


def test_claim_fingerprints_match_the_server() -> None:
    for case in FIXTURES["claimFingerprint"]:
        given = case["input"]
        fingerprint = keys.claim_fingerprint(
            entity_type=given["entityType"],
            entity_key=given["entityKey"],
            field=given["field"],
            value=given.get("value"),
            status=given["status"],
            missing_reason=given.get("missingReason"),
            source_url=given["sourceUrl"],
            content_sha256=given.get("contentSha256"),
            method=given["method"],
        )
        assert fingerprint == case["fingerprint"]


def test_org_slug_round_trip() -> None:
    assert keys.org_slug_from_key(keys.org_key("CU German Society")) == "cu-german-society"
    with pytest.raises(ValueError):
        keys.org_slug_from_key("evt-1")
