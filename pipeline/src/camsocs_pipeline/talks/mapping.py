"""Which department a talks.cam series belongs to — deterministic code only
(docs/talks-redesign-spec.md §3).

In order, the first rule that finds something decides:

1. the series id is one of a department's ``talksCamListIds`` (verified on the
   department's own site; ids are unique across the registry);
2. a department's ``name``, ``shortName`` or one of its ``aliases`` occurs in
   the series name as whole words, case-insensitively;
3. one of its ``venueHints`` occurs in the venue name the same way (a hint
   names a building one department has to itself; shared buildings — concert
   halls, institutes, conference venues — are not hints).

Within rules 2 and 3 a longer match beats a shorter one, and a match inside
a longer match's span does not count ("History" inside "History of Science"),
so a sub-phrase never maps a talk to a second department. The departments
left are ordered by match length, then registry order, so the primary
(first) department is the same every run. Nothing found: no department — the
talk shows under "Other series".

**Short names that are words.** A one-word term is matched two ways:

- an **acronym** (a capital or digit after its first character: "CST",
  "ARC", "4C", "HoG", "Energy@Cambridge") only with its own capitals: "Arc
  Welding" is not ARC;
- a **plain word** ("History", "Physics", "Law", "Medicine") only where it
  names the series' subject: at its start, or after a punctuation mark or a
  lead ("The", "Joint", "Cambridge"), or after "and" that follows another
  department's term; and followed by its end, a punctuation mark, a series
  word ("Seminar", "Colloquium", "Talks", …) or "Department" / "Faculty",
  possibly through "and <Word>". So "Physics Colloquium", "History and
  Chemistry Seminar" and "Zoology Department Seminar" map, while "Theoretical
  Physics Colloquium", "History of Medicine Seminars", "Chemical Engineering
  Seminar" and student series ("CU History Society", "Women in Engineering
  Society talk") do not.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass

from camsocs_pipeline.talks.registry import Department

#: Words before a plain-word term that still leave it the subject.
_LEADS = frozenset({"the", "joint", "cambridge", "annual", "weekly", "monthly", "departmental"})
#: Words after it that make the name a series of that subject.
_SERIES_WORDS = frozenset(
    {
        "seminar",
        "seminars",
        "colloquium",
        "colloquia",
        "lecture",
        "lectures",
        "talk",
        "talks",
        "series",
        "forum",
        "workshop",
        "workshops",
        "symposium",
        "club",
        "lunch",
        "lunches",
        "lunchtime",
        "group",
        "discussion",
        "discussions",
        "meeting",
        "meetings",
        "conference",
        "day",
        "research",
        "department",
        "dept",
        "faculty",
        "grand",  # Grand Round(s)
    }
)
_AND = frozenset({"and", "&"})
_WORD = re.compile(r"&|[\w'’@]+")


@dataclass(frozen=True)
class _Phrase:
    pattern: re.Pattern[str]
    length: int
    order: int
    key: str
    #: A plain one-word term ("History"): it must name the subject.
    plain: bool


def _is_acronym(word: str) -> bool:
    return any(c.isupper() or c.isdigit() for c in word[1:]) or not word[:1].isupper()


def _phrase(text: str, order: int, key: str) -> _Phrase | None:
    words = text.split()
    if not words:
        return None
    body = r"\s+".join(re.escape(word) for word in words)
    acronym = len(words) == 1 and _is_acronym(words[0])
    flags = 0 if acronym else re.IGNORECASE
    plain = len(words) == 1 and not acronym
    return _Phrase(re.compile(rf"(?<!\w){body}(?!\w)", flags), len(text), order, key, plain)


#: Marks around a plain-word term that end a phrase: "Physics: …", "(Law)".
_MARKS = frozenset(":;-–—()[],/|.!?")


def _lead_ok(text: str, start: int, ends: set[int]) -> bool:
    """Nothing, a mark or a lead before the match, or "and" after another
    department's term ("History and Chemistry")."""
    before = text[:start].rstrip()
    if not before:
        return True
    word = before.split()[-1]
    if word.lower() in _AND:
        return len(before[: len(before) - len(word)].rstrip()) in ends
    if before[-1] in _MARKS:
        return True
    return word.lower() in _LEADS


def _tail_ok(text: str, end: int) -> bool:
    """Nothing, a mark or a series word after the match, possibly through
    "and <Word>" ("History and Chemistry Colloquium")."""
    after = text[end:].lstrip()
    if not after or after[0] in _MARKS:
        return True
    words = [w.lower() for w in _WORD.findall(after[:120])]
    while len(words) >= 2 and words[0] in _AND:
        words = words[2:]
    return not words or words[0] in _SERIES_WORDS


def _best(phrases: Sequence[_Phrase], text: str | None) -> list[str]:
    if not text:
        return []
    raw = sorted(
        (
            (match.start(), match.end(), phrase)
            for phrase in phrases
            for match in phrase.pattern.finditer(text)
        ),
        key=lambda m: (m[0], -m[1]),
    )
    ends = {end for _start, end, phrase in raw if not phrase.plain}
    found: list[tuple[int, int, int, int, str]] = []
    for start, end, phrase in raw:
        if phrase.plain:
            if not (_lead_ok(text, start, ends) and _tail_ok(text, end)):
                continue
            ends.add(end)
        found.append((-phrase.length, phrase.order, start, end, phrase.key))
    found.sort()
    kept: list[tuple[int, int]] = []
    keys: list[str] = []
    for _length, _order, start, end, key in found:
        if any(start < k_end and k_start < end for k_start, k_end in kept):
            continue
        kept.append((start, end))
        if key not in keys:
            keys.append(key)
    return keys


class DepartmentMapper:
    """Maps a talks.cam series (id, name) and venue to department keys."""

    def __init__(self, departments: Iterable[Department]) -> None:
        self._by_list: dict[str, str] = {}
        self._names: list[_Phrase] = []
        self._venues: list[_Phrase] = []
        for order, dept in enumerate(departments):
            for list_id in dept.talks_cam_list_ids:
                self._by_list.setdefault(list_id, dept.key)
            for text in dict.fromkeys((dept.name, dept.short_name, *dept.aliases)):
                phrase = _phrase(text, order, dept.key)
                if phrase is not None:
                    self._names.append(phrase)
            for text in dict.fromkeys(dept.venue_hints):
                phrase = _phrase(text, order, dept.key)
                if phrase is not None:
                    self._venues.append(phrase)

    def departments_for(
        self, *, series_id: object = None, series_name: str | None = None, venue: str | None = None
    ) -> list[str]:
        if series_id is not None:
            listed = self._by_list.get(str(series_id))
            if listed is not None:
                return [listed]
        return _best(self._names, series_name) or _best(self._venues, venue)


__all__ = ["DepartmentMapper"]
