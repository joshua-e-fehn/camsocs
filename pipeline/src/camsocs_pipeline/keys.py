"""Key minting — the Python twin of webapp/lib/keys.ts.

Every entity is addressed by a minted string key (docs/data-model.md §0 rule
1), and the pipeline must mint exactly the keys Convex expects. Both sides
assert the same fixtures (`webapp/lib/keys.fixtures.json`, read by
`src/tests/test_keys.py` and `webapp/lib/keys.test.ts`), so a change to one
implementation without the other fails a test suite.

Shapes::

    organisation  org-<slug>                       org-cu-german-society
    venue         ven-<slug>                       ven-west-road-concert-hall
    team          team-<org slug>--<team slug>     team-cuafc--blues
    session       ses-<sha1(orgKey:titleSlug:day:start)>
    event         evt-<sha1(source:externalId)>
    relationship  rel-<sha1(fromKey:type:toKey)>
    source        src-<sha1(url)>
    person        per-<sha1(orgKey:nameSlug)>      (broker table only)

`slugify` (identical on both sides):

1. Unicode NFKD;
2. a fixed transliteration for letters NFKD leaves alone (ß→ss, æ→ae, ø→o,
   œ→oe, ł→l, đ/ð→d, þ→th, dotless i→i, and capitals);
3. drop combining marks (Unicode general category M);
4. ``&`` → `` and ``; apostrophes (ASCII, U+2019, U+02BC) are deleted ("Queens'" → "queens");
5. ASCII A–Z lowercased — only ASCII, because the two languages' full
   lower-casing differs;
6. every run outside ``[a-z0-9]`` → ``-``; leading/trailing ``-`` trimmed;
7. cut to 80 characters, trailing ``-`` trimmed again.

A name with nothing ASCII left is an error, never an empty slug.

`claim_fingerprint` mirrors the server's idempotency key for a claim, so a
stage can de-duplicate before posting; the server computes its own and never
trusts one sent to it.
"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from typing import Any

SLUG_MAX_LENGTH = 80

_TRANSLITERATION = {
    "ß": "ss",
    "æ": "ae",
    "Æ": "ae",
    "ø": "o",
    "Ø": "o",
    "œ": "oe",
    "Œ": "oe",
    "ł": "l",
    "Ł": "l",
    "đ": "d",
    "Đ": "d",
    "ð": "d",
    "Ð": "d",
    "þ": "th",
    "Þ": "th",
    chr(0x0131): "i",  # dotless i
}
#: ASCII apostrophe, right single quote, modifier-letter apostrophe.
_APOSTROPHES = re.compile("['" + chr(0x2019) + chr(0x02BC) + "]")
_NON_SLUG = re.compile(r"[^a-z0-9]+")


def sha1_hex(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8"), usedforsecurity=False).hexdigest()


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def slugify(text: str) -> str:
    out = unicodedata.normalize("NFKD", text)
    out = "".join(_TRANSLITERATION.get(char, char) for char in out)
    out = "".join(char for char in out if not unicodedata.category(char).startswith("M"))
    out = _APOSTROPHES.sub("", out.replace("&", " and "))
    out = "".join(chr(ord(char) + 32) if "A" <= char <= "Z" else char for char in out)
    out = _NON_SLUG.sub("-", out).strip("-")
    out = out[:SLUG_MAX_LENGTH].rstrip("-")
    if not out:
        raise ValueError(f"Cannot slugify {text!r}: nothing ASCII is left")
    return out


def org_key(name: str) -> str:
    return f"org-{slugify(name)}"


def org_slug_from_key(key: str) -> str:
    if not key.startswith("org-") or len(key) <= 4:
        raise ValueError(f"Not an organisation key: {key}")
    return key[4:]


def venue_key(name: str) -> str:
    return f"ven-{slugify(name)}"


def team_key(organisation_key: str, team_name: str) -> str:
    return f"team-{org_slug_from_key(organisation_key)}--{slugify(team_name)}"


def session_key(
    organisation_key: str,
    title: str,
    day_of_week: int | None = None,
    start_time: str | None = None,
) -> str:
    day = "" if day_of_week is None else str(day_of_week)
    parts = [organisation_key, slugify(title), day, start_time or ""]
    return f"ses-{sha1_hex(':'.join(parts))}"


def event_key(source: str, external_id: str) -> str:
    return f"evt-{sha1_hex(f'{source}:{external_id}')}"


def relationship_key(from_key: str, type_: str, to_key: str) -> str:
    return f"rel-{sha1_hex(f'{from_key}:{type_}:{to_key}')}"


def source_key(url: str) -> str:
    return f"src-{sha1_hex(url)}"


def person_key(organisation_key: str, name: str) -> str:
    return f"per-{sha1_hex(f'{organisation_key}:{slugify(name)}')}"


def _js_number(value: float) -> Any:
    """JS prints integral floats without a fraction (1.0 → 1)."""
    return int(value) if value.is_integer() else value


def _js_compatible(value: Any) -> Any:
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, float):
        return _js_number(value)
    if isinstance(value, dict):
        return {str(key): _js_compatible(item) for key, item in value.items() if item is not None}
    if isinstance(value, list | tuple):
        return [_js_compatible(item) for item in value]
    return value


def canonical_json(value: Any) -> str:
    """JSON with keys sorted at every level and no whitespace, printing numbers
    as JavaScript does — `canonicalJson` in lib/keys.ts. Object members whose
    value is None are skipped (the TS side skips `undefined`; JSON null inside
    a claim value is never sent)."""
    return json.dumps(
        _js_compatible(value), sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )


def claim_fingerprint(
    *,
    entity_type: str,
    entity_key: str,
    field: str,
    status: str,
    source_url: str,
    method: str,
    value: Any = None,
    has_value: bool | None = None,
    missing_reason: str | None = None,
    content_sha256: str | None = None,
) -> str:
    """sha256 over the six lines of lib/keys.ts `claimFingerprint`. `status` is
    the status the *server* stores (see `claims.stored_status`)."""
    present = value is not None if has_value is None else has_value
    value_line = canonical_json(value) if present else f"!{status}:{missing_reason or ''}"
    return sha256_hex(
        "\n".join(
            [
                f"{entity_type}:{entity_key}",
                field,
                value_line,
                source_url,
                content_sha256 or "",
                method,
            ]
        )
    )


__all__ = [
    "SLUG_MAX_LENGTH",
    "canonical_json",
    "claim_fingerprint",
    "event_key",
    "org_key",
    "org_slug_from_key",
    "person_key",
    "relationship_key",
    "session_key",
    "sha1_hex",
    "sha256_hex",
    "slugify",
    "source_key",
    "team_key",
    "venue_key",
]
