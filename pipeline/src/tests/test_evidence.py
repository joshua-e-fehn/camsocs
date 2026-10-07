"""The verbatim-evidence check that downgrades unsupported LLM claims."""

from __future__ import annotations

import pytest

from camsocs_pipeline.extract.evidence import (
    INFERRED,
    EvidenceMatch,
    check_quote,
    normalise_text,
    supported_status,
)

PAGE = (
    "<p>The Cambridge University Chess Society meets every Tuesday at 7.30pm in "
    "Queens\u2019 College.\u00a0Contact: chess&#64;example.org \u2014 all welcome!</p>"
)


def test_a_verbatim_quote_is_exact() -> None:
    assert check_quote("meets every Tuesday at 7.30pm", PAGE) is EvidenceMatch.EXACT


@pytest.mark.parametrize(
    "quote",
    [
        "Queens' College",  # straight apostrophe vs the page's curly one
        "MEETS   EVERY tuesday",  # case and whitespace
        "College. Contact",  # non-breaking space on the page
        "chess@example.org",  # HTML entity on the page
        "chess@example.org - all welcome",  # em dash folded to a hyphen
    ],
)
def test_cosmetic_differences_are_normalised(quote: str) -> None:
    assert check_quote(quote, PAGE) is EvidenceMatch.NORMALISED


@pytest.mark.parametrize(
    "quote",
    [
        "meets every Wednesday",  # a different fact
        "The chess society is friendly",  # a paraphrase is not evidence
        "",
        None,
        "  ",
        "7.",  # too short to support anything
    ],
)
def test_unsupported_quotes_are_absent(quote: str | None) -> None:
    assert check_quote(quote, PAGE) is EvidenceMatch.ABSENT


def test_unsupported_claims_are_downgraded_to_inferred() -> None:
    assert supported_status("verified_primary", EvidenceMatch.EXACT) == "verified_primary"
    assert supported_status("verified_primary", EvidenceMatch.NORMALISED) == "verified_primary"
    assert supported_status("verified_primary", EvidenceMatch.ABSENT) == INFERRED


def test_normalisation_is_idempotent() -> None:
    once = normalise_text(PAGE)
    assert normalise_text(once) == once
