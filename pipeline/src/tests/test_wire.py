"""Wire models: camelCase on the wire, never a null, unknown fields refused."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from camsocs_pipeline.models.wire import (
    ClaimInput,
    ClaimsResult,
    OrgInternalPatch,
    PendingMail,
    TermDate,
)


def test_to_wire_is_camel_case_and_drops_nones() -> None:
    patch = OrgInternalPatch(org_key="org-a", su_org_id="6789", ics_urls=["https://a.org/c.ics"])
    assert patch.to_wire() == {
        "orgKey": "org-a",
        "suOrgId": "6789",
        "icsUrls": ["https://a.org/c.ics"],
    }


def test_unknown_fields_and_bad_vocabulary_are_refused() -> None:
    with pytest.raises(ValidationError):
        OrgInternalPatch(org_key="org-a", nonsense=1)
    with pytest.raises(ValidationError):
        TermDate(
            academic_year="2026-27",
            term="summer",
            full_term_start="2026-10-06",
            full_term_end="2026-12-04",
            source_url="https://x",
        )


def test_confidence_cannot_be_sent() -> None:
    with pytest.raises(ValidationError, match="confidence"):
        ClaimInput.model_validate(
            {
                "entityType": "organisation",
                "entityKey": "org-a",
                "field": "name",
                "value": "A",
                "evidence": "primary",
                "method": "parser",
                "extractor": "r",
                "sourceKey": "src-x",
                "sourceUrl": "https://a.org",
                "sourceType": "society_website",
                "retrievedAt": 1,
                "confidence": 0.9,
            }
        )


def test_responses_parse_from_camel_case() -> None:
    result = ClaimsResult.model_validate(
        {
            "inserted": 2,
            "updated": 0,
            "unchanged": 1,
            "entities": {"created": 1, "updated": 0, "unchanged": 0},
            "rejected": [
                {
                    "index": 3,
                    "entityType": "organisation",
                    "entityKey": "org-a",
                    "field": "email",
                    "reason": "not an email address",
                }
            ],
        }
    )
    assert result.entities.created == 1
    assert result.rejected[0].entity_key == "org-a"
    mail = PendingMail.model_validate(
        {"messageId": "<a@x>", "receivedAt": 1, "from": "l@x", "subject": "s", "text": "t"}
    )
    assert mail.from_ == "l@x"
