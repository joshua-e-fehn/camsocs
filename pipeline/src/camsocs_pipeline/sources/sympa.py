"""Public society mailing lists on lists.cam.ac.uk (source-research §20).

University society lists are named ``soc-<society>[-<group>]`` (UIS help,
https://help.uis.cam.ac.uk/node/1449). The public list search,
``https://lists.cam.ac.uk/sympa/search_list/soc-``, returns every visible list
whose name contains ``soc-`` (1,077 on 2026-10-07) with its description, in
one server-rendered page. robots.txt on lists.cam.ac.uk answered 404 (no
rules) that day.

What we take, and what we never touch:

- **Names and descriptions only**, from the result items: the list name is
  the last path segment of the ``/sympa/info/<list>`` link and the
  description is the item's text. Only names starting with ``soc-`` are kept
  (the search also matches e.g. ``caius-engsoc-…``).
- **Never the address.** The page writes each list's address with a
  ``document.write`` script — an obfuscated email, which we do not decode.
  We never need it: subscribing is a command to ``sympa@lists.cam.ac.uk``
  with the list *name* (`subscribe_instruction`).
- **Never the info pages.** ``/sympa/info/<list>`` names the owners and
  moderators: personal data we have no use for. They are not fetched.

Lists outlive their societies (`soc-ciccu-events2017`), so a list proves
nothing about activity; the worklist only uses it as a way to sign up.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import timedelta

from selectolax.lexbor import LexborHTMLParser

from camsocs_pipeline.sources.base import PoliteClient

SEARCH_URL = "https://lists.cam.ac.uk/sympa/search_list/soc-"
COMMAND_ADDRESS = "sympa@lists.cam.ac.uk"
#: The search page changes slowly; one fetch a day at most.
FRESH_FOR = timedelta(days=1)

_NAME = re.compile(r"^soc-[a-z0-9][a-z0-9._-]*$")
#: Lists for a committee or a cohort, not for the public announcements.
_NOT_PUBLIC = re.compile(
    r"(?:^|-)(committee|comm|exec|execs|officers?|admin|owners?|test|internal|staff|council|"
    r"alumni|fellows|treasurer|president|secretary)(?:-|$)|(?:19|20)\d\d"
)
#: Group suffixes for announcement-style lists, best first.
_PREFERRED = (
    "",
    "announce",
    "announcements",
    "news",
    "events",
    "interested",
    "info",
    "general",
    "list",
    "members",
    "member",
)


class SympaUnavailable(RuntimeError):
    """The public search page could not be read this run."""


@dataclass(frozen=True)
class SympaList:
    name: str
    description: str

    @property
    def society(self) -> str:
        """The society component: ``soc-cugs-news`` → ``cugs``."""
        return self.name.split("-")[1] if self.name.count("-") >= 1 else self.name

    @property
    def group(self) -> str:
        """What follows the society component (``news``), or ``""``."""
        parts = self.name.split("-")
        return "-".join(parts[2:])

    @property
    def public(self) -> bool:
        return not _NOT_PUBLIC.search(self.name)


def parse_search(html: str) -> list[SympaList]:
    """Every ``soc-`` list on a search result page (name and description)."""
    found: dict[str, SympaList] = {}
    for item in LexborHTMLParser(html).css("li.listenum"):
        link = item.css_first('a[href^="/sympa/info/"]')
        if link is None:
            continue
        name = (link.attributes.get("href") or "").rstrip("/").rsplit("/", 1)[-1].lower()
        if not _NAME.match(name):
            continue
        paragraph = item.css_first("p.listenum")
        description = " ".join(paragraph.text().split()) if paragraph is not None else ""
        found.setdefault(name, SympaList(name, description[:300]))
    return sorted(found.values(), key=lambda listed: listed.name)


def fetch_soc_lists(client: PoliteClient) -> list[SympaList]:
    result = client.fetch(SEARCH_URL, fresh_for=FRESH_FOR)
    if not result.ok:
        raise SympaUnavailable(f"{SEARCH_URL}: {result.outcome} {result.detail or ''}".strip())
    return parse_search(result.text)


def best_list(lists: list[SympaList]) -> SympaList | None:
    """The list to subscribe to among one society's lists: an announcement
    list, never a committee or cohort list."""
    candidates = [listed for listed in lists if listed.public]
    if not candidates:
        return None

    def rank(listed: SympaList) -> tuple[int, str]:
        group = listed.group
        return (_PREFERRED.index(group) if group in _PREFERRED else len(_PREFERRED), listed.name)

    return min(candidates, key=rank)


def subscribe_instruction(list_name: str) -> str:
    """How to join a Sympa list by email (UIS help, node 1444): the command
    goes in the subject or the first line; most lists ask the owners to
    approve."""
    return f"send 'subscribe {list_name}' to {COMMAND_ADDRESS}"


__all__ = [
    "COMMAND_ADDRESS",
    "SEARCH_URL",
    "SympaList",
    "SympaUnavailable",
    "best_list",
    "fetch_soc_lists",
    "parse_search",
    "subscribe_instruction",
]
