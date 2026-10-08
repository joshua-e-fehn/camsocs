"""The Proctors' register of University societies (source-research §2).

One static Drupal page lists every society currently registered with the
Junior Proctor: a name and at most one link per entry, no email, category or
description. Sports clubs register with the Sports Service instead (§3).

Each entry becomes one ``proctors_register`` observation:

- ``registrations.proctors`` — ``registered: true``, no year: the page lists
  societies registered *now* (its registration window runs 1 July – 31
  December), so the claim's retrieval date places it in the academic year;
- ``name`` — the register writes names in its own sorted form, "African
  Caribbean Society (CU)", "Building Bridges … Society (The)". The trailing
  qualifiers are moved to the front ("Cambridge University African Caribbean
  Society"); the name as published is the claim's ``value_raw`` and the
  identity's ``proctors_name``. Acronyms in trailing brackets ("(CU, CUAILS)")
  become identity aliases for the resolver;
- the link, classified by shape (`classify_link`): a website (own domain,
  SRCF, a cam.ac.uk page), a social (Instagram, Facebook, LinkedIn, Linktree,
  WeChat, X), or an SU profile, which is identity only (the SU harvester
  reads the profile itself). A page in another directory of organisations
  (a CUCBC club page, a Camdram society page) is that directory's entry, not
  the society's website: it claims nothing. Links are never fetched.

Evidence: the register is the official source for the registration fact
(``primary``); for a society's name and links it is a third party
(``secondary``), so the society's own SU profile outranks it. An entry with no
link says nothing about a website: the register does not claim to list one.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from typing import Literal
from urllib.parse import urlsplit

from selectolax.lexbor import LexborHTMLParser

from camsocs_pipeline.claims import parser_field
from camsocs_pipeline.keys import sha1_hex, slugify
from camsocs_pipeline.models.observation import FetchInfo, FieldObs, IdentityHints, Observation
from camsocs_pipeline.sources.base import FetchResult
from camsocs_pipeline.sources.links import (
    absolute_url,
    host_of,
    instagram_handle,
    is_social_host,
    social_link,
)
from camsocs_pipeline.sources.markdown import html_to_text

REGISTER_URL = "https://www.proctors.cam.ac.uk/clubsandsocs/registered-societies"

LinkKind = Literal["website", "srcf", "cam", "social", "su_profile", "directory"]

#: Hosts whose pages are other registers' entries for many organisations:
#: a link there is a reference to that register, never a society's website.
DIRECTORY_HOSTS = ("cucbc.org", "camdram.net")


@dataclass(frozen=True)
class RegisterEntry:
    """One society as the register lists it."""

    #: The entry's text as published (whitespace normalised).
    raw_name: str
    #: The name with its trailing qualifiers moved to the front.
    name: str
    aliases: tuple[str, ...]
    link: str | None

    @property
    def link_kind(self) -> LinkKind | None:
        return classify_link(self.link) if self.link else None


def parse_register(html: str, base_url: str = REGISTER_URL) -> list[RegisterEntry]:
    """Every entry (``li[data-list-item-id]`` inside the page's prose), in page order.

    The first anchor with text is the entry's link (§2: "at most one link"); a
    second, stray anchor — an editing slip on two entries — is ignored.
    """
    tree = LexborHTMLParser(html)
    prose = tree.css_first('[data-testid="prose"]') or tree.body
    if prose is None:
        return []
    entries: list[RegisterEntry] = []
    for item in prose.css("li[data-list-item-id]"):
        raw = html_to_text(item)
        if not raw:
            continue
        link = None
        for anchor in item.css("a[href]"):
            if html_to_text(anchor):
                link = absolute_url(anchor.attributes.get("href"), base_url)
                break
        name, aliases = register_name(raw)
        entries.append(RegisterEntry(raw_name=raw, name=name, aliases=aliases, link=link))
    return entries


_QUALIFIER = re.compile(r"\s*\(([^()]*)\)\s*$")
_ACRONYM = re.compile(r"^[A-Z][A-Z0-9&]{1,11}$")


def register_name(raw: str) -> tuple[str, tuple[str, ...]]:
    """``(display name, aliases)`` for a name in the register's sorted form.

    Trailing bracketed qualifiers are read right to left while they are ones
    the register uses: ``CU`` (Cambridge University), ``The``, or acronyms.
    Anything else in brackets ("(Addies Boat Club)") is part of the name.
    """
    base = raw.strip()
    university = article = False
    acronyms: list[str] = []
    while True:
        match = _QUALIFIER.search(base)
        if match is None:
            break
        tokens = [token.strip() for token in match.group(1).split(",") if token.strip()]
        if not tokens or not all(
            token in ("CU", "The") or _ACRONYM.match(token) for token in tokens
        ):
            break
        for token in tokens:
            if token == "CU":
                university = True
            elif token == "The":
                article = True
            else:
                acronyms.append(token)
        base = base[: match.start()].strip()
    if not base:
        return raw, ()
    name = base
    if university:
        name = f"Cambridge University {name}"
    if article:
        name = f"The {name}"
    aliases = [raw, base, *([f"CU {base}"] if university else []), *acronyms]
    unique = tuple(dict.fromkeys(alias for alias in aliases if alias != name))
    return name, unique


def classify_link(url: str) -> LinkKind:
    """What kind of link the register gives for a society (§2 counts: own site,
    Facebook, Instagram, SU page, SRCF, cam.ac.uk, Linktree)."""
    host = host_of(url)
    if host == "cambridgesu.co.uk" and urlsplit(url).path.startswith("/organisation/"):
        return "su_profile"
    if is_social_host(url):
        return "social"
    if any(host == domain or host.endswith("." + domain) for domain in DIRECTORY_HOSTS):
        return "directory"
    if host in ("srcf.net", "srcf.ucam.org") or host.endswith((".srcf.net", ".soc.ucam.org")):
        return "srcf"
    if host == "cam.ac.uk" or host.endswith(".cam.ac.uk"):
        return "cam"
    return "website"


def su_reference(url: str) -> tuple[str | None, str | None]:
    """``(su_id, su_slug)`` named by a link to an SU profile."""
    segments = [s for s in urlsplit(url).path.split("/") if s]
    if len(segments) < 2:
        return None, None
    return (segments[1], None) if segments[1].isdigit() else (None, segments[1])


def register_observation(entry: RegisterEntry, page: FetchResult) -> Observation:
    retrieved_at = datetime.fromisoformat(page.fetched_at)
    fields: list[FieldObs] = [
        parser_field(
            "registrations.proctors",
            {"registered": True, "sourceUrl": REGISTER_URL},
            extractor="proctors_register.listed",
            evidence="primary",
        ),
        parser_field(
            "name",
            entry.name,
            extractor="proctors_register.name",
            evidence="secondary",
            value_raw=entry.raw_name if entry.raw_name != entry.name else None,
        ),
    ]
    internal: dict[str, str] = {"proctors_name": entry.raw_name}
    hints: dict[str, str] = {}
    kind = entry.link_kind
    if entry.link is not None and kind in ("website", "srcf", "cam"):
        fields.append(
            parser_field(
                "website", entry.link, extractor=f"proctors_register.{kind}", evidence="secondary"
            )
        )
        internal["website_domain"] = hints["website_domain"] = host_of(entry.link)
    elif entry.link is not None and kind == "social" and (social := social_link(entry.link)):
        # Only a link that names an account; a share link or a post claims nothing.
        fields.append(
            parser_field(
                "socials", [social], extractor="proctors_register.social", evidence="secondary"
            )
        )
        handle = instagram_handle(entry.link)
        if handle:
            internal["instagram_handle"] = hints["instagram_handle"] = handle
    elif entry.link is not None and kind == "su_profile":
        su_id, su_slug = su_reference(entry.link)
        if su_id:
            hints["su_id"] = su_id
        if su_slug:
            hints["su_slug"] = su_slug

    return Observation(
        entity_type="organisation",
        source_type="proctors_register",
        source_key=_source_key(entry.raw_name),
        source_url=REGISTER_URL,
        retrieved_at=retrieved_at,
        content_sha256=page.content_sha256,
        fetch=FetchInfo(http_status=page.status, robots_verdict="allowed"),
        identity=IdentityHints(
            name=entry.name,
            aliases=list(entry.aliases),
            proctors_name=entry.raw_name,
            **hints,
        ),
        fields=fields,
        internal=internal,
    )


def _source_key(raw_name: str) -> str:
    try:
        return slugify(raw_name)
    except ValueError:
        return sha1_hex(raw_name)


__all__ = [
    "REGISTER_URL",
    "RegisterEntry",
    "classify_link",
    "parse_register",
    "register_name",
    "register_observation",
    "su_reference",
]
