"""Cross-source dedupe of talk records before posting
(docs/talks-redesign-spec.md §3).

Two records are the same talk when they carry the same talks.cam talk id (a
department page often links to it), or the same normalised title
(`text.normalise_title`) and the same London start minute. "The same" is
transitive: a department record that matches one talks.cam record by id and
another by title joins all three.

A placeholder or generic title ("TBC", "Title to be confirmed", "Seminar",
"Journal club", "Group meeting") never matches by title: two departments'
"TBC" seminars, or two groups' journal clubs, at 16:00 are two talks.

The winner of a group is a talks.cam record when there is one; among several
of the same standing a listed (not cancelled) one, then the longer abstract,
then the smaller (source, external id) — the same choice every run. The
winner keeps its own fields and URL (a department copy's URL is dropped); its
``department_keys`` become the union of the group's, the winner's first.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import replace

from camsocs_pipeline.events.common import LONDON
from camsocs_pipeline.talks.model import TalkRecord
from camsocs_pipeline.talks.text import normalise_title

TALKS_CAM = "talks_cam"

_PLACEHOLDER_TITLE = re.compile(
    r"^(?:(?:title|talk|topic|speaker|details?)\s+)?"
    r"(?:tb[acd]|to be (?:confirmed|announced|decided))(?:\s+(?:title|talk|topic))?$"
    r"|^(?:seminar|talk|lecture|colloquium|workshop|untitled(?: talk)?|no title|title|tbc tbc)$"
    # A recurring slot's generic name: many groups hold one at the same hour.
    r"|^(?:(?:the|weekly|monthly|departmental|department|research|group|lab|student|"
    r"graduate|postgraduate|phd|internal)\s+)*"
    r"(?:seminars?|talks?|colloquium|journal club|reading group|group meeting|lab meeting|"
    r"meeting|work in progress|wip|discussion group|coffee|tea)$"
)
#: A title shorter than this (normalised) is too generic to match on.
MIN_TITLE_LENGTH = 6


def title_key(record: TalkRecord) -> tuple[str, str] | None:
    """(normalised title, London start minute), or None for a placeholder."""
    title = normalise_title(record.title)
    if len(title) < MIN_TITLE_LENGTH or _PLACEHOLDER_TITLE.match(title):
        return None
    return title, record.starts_at.astimezone(LONDON).strftime("%Y-%m-%dT%H:%M")


def _rank(record: TalkRecord) -> tuple[bool, bool, int, str, str]:
    return (
        record.source_type != TALKS_CAM,
        record.cancelled,
        -len(record.abstract or ""),
        record.source,
        record.external_id,
    )


class _Groups:
    """Union-find over record indexes."""

    def __init__(self, size: int) -> None:
        self._parent = list(range(size))

    def find(self, index: int) -> int:
        while self._parent[index] != index:
            self._parent[index] = self._parent[self._parent[index]]
            index = self._parent[index]
        return index

    def join(self, a: int, b: int) -> None:
        root_a, root_b = self.find(a), self.find(b)
        if root_a != root_b:
            self._parent[max(root_a, root_b)] = min(root_a, root_b)


def dedupe(records: Sequence[TalkRecord]) -> list[TalkRecord]:
    """One record per talk (module docstring), in the order each group was
    first seen. The inputs are not changed; a merged winner is a copy."""
    groups = _Groups(len(records))
    first_by_id: dict[int, int] = {}
    first_by_title: dict[tuple[str, str], int] = {}
    for index, record in enumerate(records):
        if record.talks_cam_id is not None:
            seen = first_by_id.setdefault(record.talks_cam_id, index)
            groups.join(seen, index)
        key = title_key(record)
        if key is not None:
            seen = first_by_title.setdefault(key, index)
            groups.join(seen, index)
    members: dict[int, list[TalkRecord]] = {}
    for index, record in enumerate(records):
        members.setdefault(groups.find(index), []).append(record)
    out: list[TalkRecord] = []
    for group in members.values():
        winner = min(group, key=_rank)
        keys = list(
            dict.fromkeys([*winner.department_keys, *(k for r in group for k in r.department_keys)])
        )
        if len(group) == 1 or keys == winner.department_keys:
            out.append(winner)
        else:
            out.append(replace(winner, department_keys=keys))
    return out


__all__ = ["dedupe", "title_key"]
