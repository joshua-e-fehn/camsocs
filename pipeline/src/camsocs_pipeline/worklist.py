"""The mailing-list sign-up worklist (`camsocs worklist`, PLAN.md J4).

Societies without any event feed are only reachable through their mailing
lists, and joining a list is something only Joshua can do (with his own
@cam.ac.uk address; most Sympa lists need the owners' approval). This ranks
the organisations worth joining and writes, under `var/reports/`:

- ``mailing-list-worklist.csv``: rank, organisation, key, status, how to sign
  up (a sign-up URL, or the Sympa command "send 'subscribe <list>' to
  sympa@lists.cam.ac.uk") and why it is ranked there;
- ``sympa-soc-lists.csv``: every public ``soc-`` list name and description
  from the Sympa search page, with the organisation it was matched to.

Ranking (higher first):

- only organisations that are not archived or dormant, have a way to sign up
  (`mailingList.signupUrl`, a Sympa list on record, or a public ``soc-`` list
  matched to them), and are not already sending mail to the inbox;
- +3 active (+1 status unknown); +3 no other event feed (no feed on record
  and no upcoming events from another source), -2 otherwise; +1 for a
  one-click sign-up page or a Sympa list on record; +1 University-level.

Matching a public list to an organisation is exact: the list's society
component (``soc-cugs-news`` → ``cugs``) equals the organisation's short name
or an alias with punctuation removed, or the list's description contains the
organisation's full name. Two organisations matching one list → neither.
"""

from __future__ import annotations

import csv
import re
from collections import defaultdict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path

from camsocs_pipeline.extract.evidence import normalise_text
from camsocs_pipeline.models.wire import WorklistOrg
from camsocs_pipeline.resolve.lookup import sympa_list_name
from camsocs_pipeline.sources.sympa import SympaList, best_list, subscribe_instruction

WORKLIST_FILE = "mailing-list-worklist.csv"
SYMPA_FILE = "sympa-soc-lists.csv"
#: Upcoming events from these sources do not count as "another feed".
MAIL_SOURCES = frozenset({"mailing_list"})
_COMPACT = re.compile(r"[^a-z0-9]+")


def compact(text: str) -> str:
    return _COMPACT.sub("", normalise_text(text))


@dataclass(frozen=True)
class WorklistRow:
    rank: int
    organisation: str
    org_key: str
    status: str
    sign_up: str
    why: str
    score: int


class SympaMatcher:
    """Public ``soc-`` lists by society component and description."""

    def __init__(self, lists: Iterable[SympaList]) -> None:
        self.lists = list(lists)
        self._by_society: dict[str, list[SympaList]] = defaultdict(list)
        for listed in self.lists:
            self._by_society[listed.society].append(listed)
        self.matched: dict[str, str] = {}

    def match(self, org: WorklistOrg) -> SympaList | None:
        candidates: dict[str, list[SympaList]] = {}
        for label in [org.short_name or "", *org.aliases]:
            key = compact(label)
            if 2 <= len(key) <= 12 and key in self._by_society:
                candidates[key] = self._by_society[key]
        full = normalise_text(org.name)
        if len(full) >= 10:
            for listed in self.lists:
                if full in normalise_text(listed.description):
                    candidates.setdefault(listed.society, self._by_society[listed.society])
        if len(candidates) != 1:
            return None
        chosen = best_list(next(iter(candidates.values())))
        return chosen

    def assign(self, orgs: Iterable[WorklistOrg]) -> dict[str, SympaList]:
        """Org key → its public list, refusing lists two organisations match."""
        tentative = {org.key: self.match(org) for org in orgs}
        owners: dict[str, list[str]] = defaultdict(list)
        for key, listed in tentative.items():
            if listed is not None:
                owners[listed.society].append(key)
        assigned = {
            key: listed
            for key, listed in tentative.items()
            if listed is not None and len(owners[listed.society]) == 1
        }
        self.matched = {listed.name: key for key, listed in assigned.items()}
        return assigned


def rank_organisations(
    orgs: Iterable[WorklistOrg],
    *,
    public_lists: Mapping[str, SympaList] | None = None,
    receiving_orgs: Iterable[str] = (),
    receiving_lists: Iterable[str] = (),
) -> list[WorklistRow]:
    """The ranked worklist; see the module docstring."""
    public_lists = public_lists or {}
    receiving = set(receiving_orgs)
    joined = {name.lower() for name in receiving_lists}
    scored: list[tuple[int, str, WorklistOrg, str, list[str]]] = []
    for org in orgs:
        if org.status in ("archived", "dormant") or org.key in receiving:
            continue
        why: list[str] = []
        score = 0
        mailing = org.mailing_list
        signup_url = mailing.signup_url if mailing else None
        recorded_list = org.sympa_list or (
            sympa_list_name(mailing.address) if mailing and mailing.address else None
        )
        recorded_list = recorded_list or (sympa_list_name(signup_url) if signup_url else None)
        matched = public_lists.get(org.key)
        if recorded_list:
            sign_up = subscribe_instruction(recorded_list)
            score += 1
            why.append(f"Sympa list {recorded_list} on record")
        elif signup_url:
            sign_up = signup_url
            score += 1
            why.append("sign-up page on record")
        elif matched:
            sign_up = subscribe_instruction(matched.name)
            why.append(f"public Sympa list {matched.name} matched by name (check it)")
        else:
            continue
        list_name = recorded_list or (matched.name if matched and not signup_url else None)
        if list_name and list_name.lower() in joined:
            continue

        if org.status == "active":
            score += 3
            why.insert(0, "active")
        else:
            score += 1
            why.insert(0, f"status {org.status}")
        feeds = sorted(
            set(org.feeds) | {s for s in org.upcoming_event_sources if s not in MAIL_SOURCES}
        )
        if feeds:
            score -= 2
            why.append(f"already has: {', '.join(feeds)}")
        else:
            score += 3
            why.append("no other event feed")
        if org.level == "university":
            score += 1
            why.append("University-level")
        scored.append((score, org.name.casefold(), org, sign_up, why))

    scored.sort(key=lambda item: (-item[0], item[1]))
    return [
        WorklistRow(
            rank=index,
            organisation=org.name,
            org_key=org.key,
            status=org.status,
            sign_up=sign_up,
            why="; ".join(why),
            score=score,
        )
        for index, (score, _name, org, sign_up, why) in enumerate(scored, start=1)
    ]


def write_worklist(rows: list[WorklistRow], directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / WORKLIST_FILE
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["rank", "organisation", "org_key", "status", "sign_up", "why", "score"])
        for row in rows:
            writer.writerow(
                [
                    row.rank,
                    row.organisation,
                    row.org_key,
                    row.status,
                    row.sign_up,
                    row.why,
                    row.score,
                ]
            )
    return path


def write_sympa_lists(matcher: SympaMatcher, directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / SYMPA_FILE
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["list", "description", "public", "matched_org_key"])
        for listed in matcher.lists:
            writer.writerow(
                [
                    listed.name,
                    listed.description,
                    "yes" if listed.public else "no",
                    matcher.matched.get(listed.name, ""),
                ]
            )
    return path


__all__ = [
    "SYMPA_FILE",
    "WORKLIST_FILE",
    "SympaMatcher",
    "WorklistRow",
    "compact",
    "rank_organisations",
    "write_sympa_lists",
    "write_worklist",
]
