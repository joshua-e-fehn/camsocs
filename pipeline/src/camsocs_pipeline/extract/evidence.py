"""Does a quoted piece of evidence actually appear in the source text?

Every LLM claim carries an `evidence_quote`. This module checks it against the
cached source text and is what keeps model output from becoming a "verified"
fact on its own say-so. Adapted from salo-ba `verification/check_emails.py`
(EXACT / SPLIT / LOCAL_ONLY / ABSENT); here the verdicts are:

- `EXACT`       the quote occurs verbatim.
- `NORMALISED`  it occurs after normalising both sides: HTML entities decoded,
                Unicode NFKC, curly quotes/dashes/non-breaking spaces folded to
                ASCII, whitespace collapsed, case folded. Page text extracted
                from HTML differs from what a model echoes in exactly these ways.
- `ABSENT`      neither — the claim has no support in this source.

A claim whose quote is `ABSENT` keeps its value but is downgraded to status
`inferred` (`supported_status`), which the UI never renders as verified.
Matching is substring-only by design: anything fuzzier would start accepting
paraphrases, which is the failure this exists to catch.
"""

from __future__ import annotations

import html
import re
import unicodedata
from enum import StrEnum

#: Quotes shorter than this (after normalising) are too unspecific to count as
#: support — "a" or "Yes" occur on almost any page.
MIN_QUOTE_CHARS = 3

#: The status an unsupported claim is downgraded to (docs/data-model.md).
INFERRED = "inferred"

# Code points rather than literal characters, so the table is readable and no
# look-alike glyph hides in the source.
_SINGLE_QUOTES = (0x2018, 0x2019, 0x201A, 0x201B, 0x2032, 0x00B4, 0x0060)
_DOUBLE_QUOTES = (0x201C, 0x201D, 0x201E, 0x201F, 0x2033, 0x00AB, 0x00BB)
_DASHES = (0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212)
_SPACES = (0x00A0, 0x2009, 0x202F)
_INVISIBLE = (0x200B, 0x00AD)  # zero-width space, soft hyphen

_TRANSLATE = str.maketrans(
    {
        **dict.fromkeys(map(chr, _SINGLE_QUOTES), "'"),
        **dict.fromkeys(map(chr, _DOUBLE_QUOTES), '"'),
        **dict.fromkeys(map(chr, _DASHES), "-"),
        **dict.fromkeys(map(chr, _SPACES), " "),
        **dict.fromkeys(map(chr, _INVISIBLE), ""),
    }
)
_WHITESPACE = re.compile(r"\s+")


class EvidenceMatch(StrEnum):
    EXACT = "exact"
    NORMALISED = "normalised"
    ABSENT = "absent"


def normalise_text(text: str) -> str:
    """Fold the differences between page text and an echoed quote that carry no meaning."""
    text = html.unescape(text)
    text = unicodedata.normalize("NFKC", text)
    text = text.translate(_TRANSLATE).replace("\u2026", "...")
    text = _WHITESPACE.sub(" ", text)
    return text.casefold().strip()


def check_quote(quote: str | None, source_text: str) -> EvidenceMatch:
    """How (if at all) `quote` occurs in `source_text`."""
    if quote is None or not quote.strip():
        return EvidenceMatch.ABSENT
    needle = normalise_text(quote)
    if len(needle) < MIN_QUOTE_CHARS:
        return EvidenceMatch.ABSENT
    if quote.strip() in source_text:
        return EvidenceMatch.EXACT
    if needle in normalise_text(source_text):
        return EvidenceMatch.NORMALISED
    return EvidenceMatch.ABSENT


def supported_status(claimed_status: str, match: EvidenceMatch) -> str:
    """The status a claim may keep: its own if the quote was found, else `inferred`."""
    return claimed_status if match is not EvidenceMatch.ABSENT else INFERRED


__all__ = [
    "INFERRED",
    "MIN_QUOTE_CHARS",
    "EvidenceMatch",
    "check_quote",
    "normalise_text",
    "supported_status",
]
