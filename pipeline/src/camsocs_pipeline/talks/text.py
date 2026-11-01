"""Deterministic readings of a talk listing's free text, shared by every talk
source (talks.cam and the department sites; docs/talks-redesign-spec.md §3).

Rules only — nothing here calls a model, and nothing here may (D7: every talk
source is parser-only). Each rule is conservative: when a text is ambiguous it
keeps the source's words rather than guess.

- `plain_text` / `one_line`: HTML to plain text, paragraph breaks kept.
- `parse_speakers`: ``"Name (Affiliation)"``, several separated by ``;`` or
  by `` and `` (only between two full names, never inside brackets or after
  a comma), and ``"Name, University of X"`` when the part after the comma names
  an institution. Placeholders (TBC, TBA, various) are no speaker.
- `is_cancelled`: "cancelled" / "canceled" / "postponed" as a word in the title
  or the special message — never "cancellation" ("noise cancellation").
- `is_online`: an online or hybrid marker in the venue or the special message
  (Zoom, Teams, online, virtual, webinar, live stream, hybrid), a bracketed
  "(online)" in the title, or a meeting link anywhere (abstract included).
  "Register online" / "slides available online" in the special message is
  not a marker, and neither is a plain video link.
- `guess_kind`: keywords in the title, then in the series name.
- `normalise_title`: the comparison form cross-source dedupe uses.
"""

from __future__ import annotations

import re

from camsocs_pipeline.events.common import clean_text
from camsocs_pipeline.talks.model import MAX_SPEAKERS, Speaker


def plain_text(text: str | None) -> str | None:
    """HTML (if any) to plain text: entities decoded, spaces collapsed,
    paragraph breaks kept. None when nothing is left."""
    return clean_text(text)


def one_line(text: str | None) -> str | None:
    value = clean_text(text)
    if value is None:
        return None
    return " ".join(value.split()) or None


# --- speakers -----------------------------------------------------------------------------

_PLACEHOLDER = re.compile(
    r"^(?:tb[acd]|t\.b\.[acd]\.?|n/?a|none|various|various speakers|several speakers|"
    r"speakers?\s+tb[acd]|speakers?\s+to\s+be\s+(?:confirmed|announced)|to\s+be\s+"
    r"(?:confirmed|announced|decided)|see\s+(?:below|abstract)|\?+|-+)$",
    re.IGNORECASE,
)
_AFFILIATED = re.compile(r"^(?P<name>.+?)\s*\((?P<affiliation>[^()]+)\)$")
_INSTITUTION = re.compile(
    r"\b(?:universit(?:y|ies|ät|é)|college|institute|institution|department|dept\.?|school|"
    r"faculty|centre|center|laborator(?:y|ies)|lab|hospital|trust|council|museum|"
    r"foundation|company|ltd|inc|plc|llc|gmbh|research|cambridge|oxford|london|eth|mit|"
    r"caltech|cnrs|inria|max planck)\b",
    re.IGNORECASE,
)
_TITLES = re.compile(r"^(?:dr|prof|professor|mr|mrs|ms|mx|miss|sir|dame|lord|lady|rev)\b\.?", re.I)


def _depth_zero_split(text: str, separator: re.Pattern[str]) -> list[str]:
    """`text` split on `separator`, but never inside round or square brackets."""
    parts: list[str] = []
    depth = 0
    start = 0
    position = 0
    while position < len(text):
        char = text[position]
        if char in "([":
            depth += 1
        elif char in ")]":
            depth = max(0, depth - 1)
        elif depth == 0:
            match = separator.match(text, position)
            if match:
                parts.append(text[start:position])
                start = position = match.end()
                continue
        position += 1
    parts.append(text[start:])
    return parts


_SEMICOLON = re.compile(r"\s*;\s*")
_AND = re.compile(r"\s+(?:and|&)\s+", re.IGNORECASE)
_COMMA = re.compile(r"\s*,\s*")


def _looks_like_a_name(text: str) -> bool:
    """A person's name as a speaker field writes one: a title, or at least two
    words starting with a capital, optionally with a bracketed affiliation."""
    bare = _AFFILIATED.sub(r"\g<name>", text).strip()
    if _TITLES.match(bare):
        return True
    words = bare.split()
    return len(words) >= 2 and all(word[:1].isupper() or word[:1] in "'’-" for word in words[:2])


def _split_and(part: str) -> list[str]:
    """``"A and B"`` → two speakers only when both sides look like names and
    the part has no comma outside brackets (``"X, Dept of Earth and Planetary
    Sciences"`` stays one)."""
    if len(_depth_zero_split(part, _COMMA)) > 1:
        return [part]
    pieces = _depth_zero_split(part, _AND)
    if len(pieces) > 1 and all(_looks_like_a_name(piece.strip()) for piece in pieces):
        return [piece.strip() for piece in pieces]
    return [part]


def _speaker(part: str) -> Speaker | None:
    part = " ".join(part.split()).strip(" ,.")
    if not part or _PLACEHOLDER.match(part):
        return None
    match = _AFFILIATED.match(part)
    if match:
        name = match["name"].strip(" ,")
        affiliation: str | None = " ".join(match["affiliation"].split())
        if affiliation and _PLACEHOLDER.match(affiliation):
            affiliation = None
        if not name or _PLACEHOLDER.match(name):
            return None
        return Speaker(name=name, affiliation=affiliation)
    pieces = _depth_zero_split(part, _COMMA)
    if len(pieces) > 1 and _INSTITUTION.search(", ".join(pieces[1:])):
        name = pieces[0].strip()
        if name and not _PLACEHOLDER.match(name):
            return Speaker(name=name, affiliation=", ".join(p.strip() for p in pieces[1:]))
    return Speaker(name=part)


def parse_speakers(text: str | None) -> list[Speaker]:
    """The speakers a listing names, in its order, at most `MAX_SPEAKERS`
    (module docstring for the rules). Duplicates are dropped."""
    value = one_line(text)
    if not value:
        return []
    speakers: list[Speaker] = []
    for chunk in _depth_zero_split(value, _SEMICOLON):
        for part in _split_and(chunk.strip()):
            speaker = _speaker(part)
            if speaker is not None and speaker not in speakers:
                speakers.append(speaker)
    return speakers[:MAX_SPEAKERS]


# --- status, mode and kind -------------------------------------------------------------------

_CANCELLED = re.compile(r"\b(?:cancel+ed|postponed)\b", re.IGNORECASE)
_ONLINE_WORDS = re.compile(
    r"\b(?:zoom|(?:ms |microsoft )?teams|online|virtual(?:ly)?|webinar|livestream(?:ed)?|"
    r"live[- ]stream(?:ed)?|hybrid)\b",
    re.IGNORECASE,
)
#: "Register online", "slides available online": about the admin, not the talk.
_NOT_ONLINE = re.compile(
    r"\b(?:register(?:ed)?|registration|book(?:ing)?|sign[- ]?up|tickets?|available|"
    r"published|posted|uploaded)\s+(?:\w+\s+){0,2}?online\b",
    re.IGNORECASE,
)
_ONLINE_TITLE = re.compile(
    r"[(\[]\s*(?:online|hybrid|zoom|virtual|webinar)\b|\bwebinar\b"
    r"|\bhybrid (?:event|seminar|talk)\b",
    re.IGNORECASE,
)
_MEETING_LINK = re.compile(
    r"https?://(?:[\w-]+\.)*(?:zoom\.us|teams\.microsoft\.com|teams\.live\.com|meet\.google\.com|"
    r"webex\.com|whereby\.com|youtube\.com/live|vimeo\.com/event)\b",
    re.IGNORECASE,
)


def is_cancelled(title: str | None, special_message: str | None = None) -> bool:
    return any(_CANCELLED.search(text) for text in (title, special_message) if text)


def is_online(
    *,
    venue: str | None = None,
    special_message: str | None = None,
    title: str | None = None,
    abstract: str | None = None,
) -> bool:
    texts = (venue, _NOT_ONLINE.sub(" ", special_message) if special_message else None)
    if any(_ONLINE_WORDS.search(text) for text in texts if text):
        return True
    if title and _ONLINE_TITLE.search(title):
        return True
    return any(_MEETING_LINK.search(text) for text in (venue, special_message, abstract) if text)


#: Kind → keywords, first match wins, title before series. "Colloquium day"
#: is a conference; a plain colloquium is a seminar.
_KINDS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("lecture", re.compile(r"\blectures?\b", re.IGNORECASE)),
    ("workshop", re.compile(r"\bworkshops?\b", re.IGNORECASE)),
    (
        "conference",
        re.compile(r"\b(?:conferences?|symposi(?:um|a)|colloquium day)\b", re.IGNORECASE),
    ),
    ("seminar", re.compile(r"\b(?:seminars?|talks?|colloqui(?:um|a))\b", re.IGNORECASE)),
)


def guess_kind(title: str | None, series: str | None = None, default: str = "seminar") -> str:
    for text in (title, series):
        if not text:
            continue
        for kind, pattern in _KINDS:
            if pattern.search(text):
                return kind
    return default


# --- dedupe form ------------------------------------------------------------------------------

_NOT_ALNUM = re.compile(r"[^0-9a-z]+")
_MARKERS = re.compile(r"\b(?:cancel+ed|postponed|rescheduled)\b")


def normalise_title(text: str | None) -> str:
    """Case-folded, punctuation and spacing collapsed, cancellation markers
    dropped: two sources' spellings of one title compare equal."""
    title = _NOT_ALNUM.sub(" ", (text or "").casefold()).strip()
    return " ".join(_MARKERS.sub(" ", title).split())


__all__ = [
    "guess_kind",
    "is_cancelled",
    "is_online",
    "normalise_title",
    "one_line",
    "parse_speakers",
    "plain_text",
]
