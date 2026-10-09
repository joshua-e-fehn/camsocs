"""Which organisation is this? — the one lookup every stage after `resolve`
uses (events, inbox, Instagram, termcards, classification).

The resolver (`resolver.py`) decides identities and keys; later stages only
need to *find* a known organisation from what a source says about it — an
event's organiser, a mail's sender, a sign-off's society name. `OrgLookup`
answers that from two things, never minting a key:

- the **crosswalk** (`crosswalk.Crosswalk`): the local cache
  ``var/state/crosswalk.json`` merged with Convex's ``POST
  /api/pipeline/crosswalk`` (every organisation row with its source
  identifiers), so a fresh machine finds the keys the server already holds;
- the **keyed observations in staging** (the latest file of every
  directory: the resolver's ``_resolved``, enrichment, classification),
  which add what only staging knows this run: published addresses, Sympa
  lists, feeds, termcards, venues.

`reference_key(hints)` is the one identity lookup, deterministic and only
when the answer is unique — a wrong organisation is worse than none:

1. a key the hints already carry;
2. a strong identifier the source states: Camdram id or slug, SU id or slug,
   the CUCBC club, a talks.cam list, the Instagram handle, the website domain
   — first in staging, then in the crosswalk (explicit ids, Instagram,
   website);
3. a college boat club by its college;
4. the name: an exact slug of the name or an alias; the name without the
   usual "Cambridge University" / "Society" wrapping (`name_keys`); then the
   crosswalk's name signature (`names.py`), among compatible organisations
   (level, type family, college — `identity.conflict`).

The other lookups (`by_list`, `by_address`, `by_domain`, `by_name`) serve
the inbox (source-research §16); `feeds`, `owner_of_talks_list` and
`resolve_venue` the events stages; `instagram_targets` and `termcards` the
Instagram and termcard stages. Nothing here leaves the pipeline: personal
addresses are only compared.
"""

from __future__ import annotations

import logging
import re
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

import httpx

from camsocs_pipeline.keys import slugify
from camsocs_pipeline.models.observation import IdentityHints, Observation
from camsocs_pipeline.pipeline.load import ConvexError
from camsocs_pipeline.resolve.colleges import BY_ID as COLLEGES_BY_ID
from camsocs_pipeline.resolve.crosswalk import Crosswalk, crosswalk_path
from camsocs_pipeline.resolve.identity import identity_of
from camsocs_pipeline.sources.links import instagram_handle
from camsocs_pipeline.staging.store import StagingStore

if TYPE_CHECKING:
    from camsocs_pipeline.pipeline.context import StageContext

logger = logging.getLogger(__name__)

#: Domains shared by many senders and sites, which identify no single organisation.
SHARED_DOMAINS = frozenset(
    {
        "gmail.com",
        "googlemail.com",
        "outlook.com",
        "hotmail.com",
        "hotmail.co.uk",
        "live.com",
        "live.co.uk",
        "yahoo.com",
        "yahoo.co.uk",
        "icloud.com",
        "me.com",
        "protonmail.com",
        "proton.me",
        "cantab.net",
        "cambridgesu.co.uk",
        "srcf.net",
        "soc.srcf.net",
        "users.srcf.net",
        "linktr.ee",
        "instagram.com",
        "facebook.com",
        "google.com",
        "sites.google.com",
        "wixsite.com",
        "wordpress.com",
        "squarespace.com",
        "eventbrite.co.uk",
        "fixr.co",
        "list-manage.com",
        "mailchimp.com",
    }
)

SYMPA_HOST = "lists.cam.ac.uk"
_SYMPA_PATH = re.compile(r"^/sympa/(?:info|subscribe|review|arc)/([a-z0-9][a-z0-9._-]*)", re.I)

#: Words stripped from the front / back of a name to form a looser match key.
_NAME_PREFIXES = ("university-of-cambridge-", "cambridge-university-", "cambridge-", "cu-")
_NAME_SUFFIXES = ("-society", "-soc", "-club")

#: `orgInternal` list fields (snake_case, as in `models.wire.OrgInternalPatch`)
#: that name a feed, and the `FeedRef.kind` each becomes.
FEED_FIELDS = {
    "talks_list_ids": "talks",
    "ics_urls": "ics",
    "luma_calendar_ids": "luma",
    "google_calendar_ids": "google",
}


# --- normalising what is matched -------------------------------------------------------


def domain_of(value: str) -> str | None:
    """The host of a URL or the domain of an address, lower-cased, no `www.`."""
    text = value.strip().lower()
    if "@" in text and "://" not in text:
        host = text.rsplit("@", 1)[1]
    else:
        try:
            host = urlsplit(text if "://" in text else f"https://{text}").hostname or ""
        except ValueError:
            return None
    host = host.removeprefix("www.").strip(".")
    return host or None


def is_shared_domain(domain: str) -> bool:
    """Webmail, the University (cam.ac.uk and every subdomain: colleges and
    departments host many clubs), the SU, SRCF and generic site builders."""
    return (
        domain in SHARED_DOMAINS
        or domain == "cam.ac.uk"
        or domain.endswith(".cam.ac.uk")
        or any(domain.endswith(f".{shared}") for shared in SHARED_DOMAINS)
    )


def sympa_list_name(value: str) -> str | None:
    """The Sympa list name in a list address, sign-up URL or List-Id:
    `soc-x@lists.cam.ac.uk`, `https://lists.cam.ac.uk/sympa/info/soc-x`,
    `soc-x.lists.cam.ac.uk` → `soc-x`."""
    text = value.strip().lower()
    if text.endswith(f"@{SYMPA_HOST}"):
        return text[: -len(SYMPA_HOST) - 1] or None
    if text.endswith(f".{SYMPA_HOST}") and "/" not in text and "@" not in text:
        return text[: -len(SYMPA_HOST) - 1] or None
    if "://" in text:
        parts = urlsplit(text)
        if (parts.hostname or "") == SYMPA_HOST:
            match = _SYMPA_PATH.match(parts.path)
            if match:
                return match.group(1).lower()
    return None


def _slug(text: str | None) -> str | None:
    if not text or not text.strip():
        return None
    try:
        return slugify(text)
    except ValueError:
        return None


def name_keys(name: str) -> set[str]:
    """Normalised forms of a name: its slug; the slug without the usual
    "Cambridge University" / "CU" prefix ("CU German Society" and "Cambridge
    University German Society" share `german-society`); and that without a
    trailing "Society" / "Club", kept only when it is several words or a long
    word, so a bare "German" or "Chess" never matches."""
    slug = _slug(name)
    if slug is None:
        return set()
    keys = {slug}
    stripped = slug
    for prefix in _NAME_PREFIXES:
        if stripped.startswith(prefix):
            stripped = stripped[len(prefix) :]
            break
    if stripped:
        keys.add(stripped)
    for suffix in _NAME_SUFFIXES:
        if stripped.endswith(suffix):
            core = stripped[: -len(suffix)]
            if "-" in core or len(core) >= 8:
                keys.add(core)
            break
    return keys


def instagram_key(value: Any) -> str | None:
    """An Instagram handle (URL or ``@handle``), lower-cased."""
    if not isinstance(value, str):
        return None
    handle = instagram_handle(value)
    return handle.lower() if handle else None


# --- the index ------------------------------------------------------------------------------


@dataclass(frozen=True)
class FeedRef:
    """One feed an organisation publishes: ``kind`` is talks / ics / luma /
    google / playwaze_community / playwaze_league; ``value`` the id or URL."""

    org_key: str
    kind: str
    value: str


@dataclass
class KnownOrg:
    """What the lookup knows about one organisation."""

    key: str
    names: list[str] = field(default_factory=list)
    short_names: set[str] = field(default_factory=set)
    sympa_lists: set[str] = field(default_factory=set)
    addresses: set[str] = field(default_factory=set)
    domains: set[str] = field(default_factory=set)
    instagram_handles: set[str] = field(default_factory=set)
    termcard_urls: set[str] = field(default_factory=set)
    org_type: str | None = None

    @property
    def display_name(self) -> str:
        return self.names[0] if self.names else self.key.removeprefix("org-")


def _strings(observation: Observation, *names: str) -> list[str]:
    """String values of the observation's own field claims (`name`, `aliases`)."""
    values: list[str] = []
    for obs in observation.fields:
        if obs.field not in names or obs.value is None:
            continue
        if isinstance(obs.value, str):
            values.append(obs.value)
        elif isinstance(obs.value, list):
            values.extend(item for item in obs.value if isinstance(item, str))
    return values


class OrgLookup:
    """The organisations the pipeline knows; see the module docstring."""

    def __init__(self, crosswalk: Crosswalk | None = None) -> None:
        self.crosswalk = crosswalk if crosswalk is not None else Crosswalk()
        self.orgs: dict[str, KnownOrg] = {}
        #: kind → normalised value → organisation keys.
        self._by: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
        self._venues: dict[str, set[str]] = defaultdict(set)
        self._feeds: dict[tuple[str, str, str], FeedRef] = {}

    # -- building --------------------------------------------------------------------

    @classmethod
    def from_records(
        cls, records: Iterable[object], crosswalk: Crosswalk | None = None
    ) -> OrgLookup:
        lookup = cls(crosswalk)
        lookup.add_all(records)
        return lookup

    @classmethod
    def from_staging(cls, staging: StagingStore, crosswalk: Crosswalk | None = None) -> OrgLookup:
        return cls.from_records(
            (record for name in staging.directories() for record in staging.read_latest(name)),
            crosswalk,
        )

    @classmethod
    def for_stage(cls, ctx: StageContext) -> OrgLookup:
        """The lookup a stage uses: the local crosswalk, merged with Convex's
        (not in a dry run, which touches no network; a route that is not
        deployed or does not answer leaves the local copy), plus staging."""
        crosswalk = Crosswalk.load(crosswalk_path(ctx.settings.staging_dir))
        if not ctx.dry_run:
            try:
                crosswalk.merge_remote(ctx.loader.crosswalk())
            except (ConvexError, httpx.HTTPError) as error:
                ctx.report.notes.append(f"crosswalk from Convex unavailable ({error}); local only")
        return cls.from_staging(ctx.staging, crosswalk)

    def add_all(self, records: Iterable[object]) -> None:
        for record in records:
            if isinstance(record, Observation):
                self.add(record)

    def _put(self, kind: str, value: Any, key: str) -> None:
        if value is None or value == "":
            return
        self._by[kind][str(value).strip().lower()].add(key)

    def add(self, obs: Observation) -> None:
        """Index one keyed observation (organisations and venues; others are ignored)."""
        key = obs.entity_key
        if key is None:
            return
        if obs.entity_type == "venue":
            for name in [
                obs.identity.name,
                *obs.identity.aliases,
                *_strings(obs, "name", "aliases"),
            ]:
                slug = _slug(name)
                if slug:
                    self._venues[slug].add(key)
            return
        if obs.entity_type != "organisation":
            return
        org = self.orgs.setdefault(key, KnownOrg(key))
        identity, internal = obs.identity, obs.internal
        # Its identifiers and name signatures, for the crosswalk steps.
        self.crosswalk.add_resolved([obs])

        def name(value: object, *, short: bool = False) -> None:
            if not isinstance(value, str) or not value.strip():
                return
            text = value.strip()
            if text not in org.names:
                org.names.append(text)
            if short:
                org.short_names.add(text)
            self._put("name", _slug(text), key)
            for name_key in name_keys(text):
                self._put("name_key", name_key, key)

        def address(value: object) -> None:
            if not isinstance(value, str) or "@" not in value:
                return
            normalised = value.strip().lower()
            org.addresses.add(normalised)
            self._put("address", normalised, key)
            listed = sympa_list_name(normalised)
            if listed:
                self._add_list(org, listed)
            else:
                domain(normalised)

        def domain(value: object) -> None:
            if not isinstance(value, str) or not value.strip():
                return
            found = domain_of(value)
            if found and not is_shared_domain(found):
                org.domains.add(found)
                self._put("domain", found, key)

        def handle(value: object) -> None:
            found = instagram_key(value)
            if found:
                org.instagram_handles.add(found)
                self._put("instagram", found, key)

        if identity.org_type:
            org.org_type = identity.org_type
        name(identity.name)
        for alias in identity.aliases:
            name(alias)
        domain(identity.website_domain)
        domain(identity.email_domain)
        handle(identity.instagram_handle)
        for kind, value in (
            ("camdram_id", identity.camdram_id),
            ("camdram_id", internal.get("camdram_id")),
            ("camdram_slug", identity.camdram_slug),
            ("camdram_slug", internal.get("camdram_slug")),
            ("su_id", identity.su_id),
            ("su_id", internal.get("su_org_id")),
            ("su_slug", identity.su_slug),
            ("su_slug", internal.get("su_slug")),
            ("cucbc_club", _slug(identity.cucbc_club)),
            ("cucbc_club", _slug(internal.get("cucbc_club"))),
        ):
            self._put(kind, value, key)
        domain(internal.get("website_domain"))
        handle(internal.get("instagram_handle"))
        if isinstance(internal.get("sympa_list"), str):
            listed = sympa_list_name(internal["sympa_list"]) or internal["sympa_list"].lower()
            self._add_list(org, listed)
        for list_id in [*identity.talks_list_ids, *(internal.get("talks_list_ids") or [])]:
            self._put("talks_list", list_id, key)
        if identity.org_type == "college_boat_club" and identity.college_hint:
            self._put("boat_club_college", _slug(identity.college_hint), key)

        for obs_field in obs.fields:
            value = obs_field.value
            if value is None:
                continue
            match obs_field.field:
                case "name":
                    name(value)
                case "shortName":
                    name(value, short=True)
                case "aliases":
                    for alias in value if isinstance(value, list) else []:
                        name(alias)
                case "orgType":
                    if isinstance(value, str):
                        org.org_type = value
                case "email":
                    address(value)
                case "roleEmails":
                    for item in value if isinstance(value, list) else []:
                        if isinstance(item, dict):
                            address(item.get("email"))
                case "website":
                    domain(value)
                case "mailingList":
                    if isinstance(value, dict):
                        address(value.get("address"))
                        signup = value.get("signupUrl")
                        listed = sympa_list_name(signup) if isinstance(signup, str) else None
                        if listed:
                            self._add_list(org, listed)
                case "socials":
                    for item in value if isinstance(value, list) else []:
                        if isinstance(item, dict) and item.get("platform") == "instagram":
                            handle(item.get("handle") or item.get("url"))
                case "termcardUrl":
                    if isinstance(value, str) and value.startswith(("http://", "https://")):
                        org.termcard_urls.add(value)
                case _:
                    pass

        for internal_field, kind in FEED_FIELDS.items():
            for value in internal.get(internal_field) or []:
                self._add_feed(FeedRef(key, kind, str(value)))
        playwaze = internal.get("playwaze") or {}
        if playwaze.get("community_id"):
            self._add_feed(FeedRef(key, "playwaze_community", str(playwaze["community_id"])))
        for league in playwaze.get("league_ids") or []:
            self._add_feed(FeedRef(key, "playwaze_league", str(league)))

    def _add_list(self, org: KnownOrg, list_name: str) -> None:
        org.sympa_lists.add(list_name)
        self._put("list", list_name, org.key)

    def _add_feed(self, feed: FeedRef) -> None:
        self._feeds.setdefault((feed.org_key, feed.kind, feed.value), feed)

    # -- identity -----------------------------------------------------------------------

    def _unique(self, kind: str, value: Any) -> str | None:
        if value is None or value == "":
            return None
        keys = self._by.get(kind, {}).get(str(value).strip().lower())
        return next(iter(keys)) if keys and len(keys) == 1 else None

    def _known(self, key: str) -> bool:
        return key in self.orgs or key in self.crosswalk

    def reference_key(self, hints: IdentityHints) -> str | None:
        """The one known organisation `hints` describe, or None (module
        docstring). Never mints or creates one."""
        if hints.known_key:
            return hints.known_key
        handle = instagram_key(hints.instagram_handle)
        domain = domain_of(hints.website_domain) if hints.website_domain else None
        for kind, value in (
            ("camdram_id", hints.camdram_id),
            ("camdram_slug", hints.camdram_slug),
            ("su_id", hints.su_id),
            ("su_slug", hints.su_slug),
            ("cucbc_club", _slug(hints.cucbc_club)),
            ("instagram", handle),
            ("domain", domain if domain and not is_shared_domain(domain) else None),
            *(("talks_list", list_id) for list_id in hints.talks_list_ids),
        ):
            key = self._unique(kind, value)
            if key:
                return key
        identity = identity_of(hints)
        if identity.college:
            key = COLLEGES_BY_ID[identity.college].key
            return key if self._known(key) else None
        by_ids = self.crosswalk.match(identity, names=False)
        if by_ids.key is not None and self._known(by_ids.key):
            return by_ids.key
        if by_ids.candidates:
            return None
        if hints.org_type == "college_boat_club" and hints.college_hint:
            key = self._unique("boat_club_college", _slug(hints.college_hint))
            if key:
                return key
        return self._by_names([hints.name, *hints.aliases], identity_hints=hints)

    #: The events builder's name for `reference_key` (`events.common.OrganiserLookup`).
    def resolve(self, hints: IdentityHints) -> str | None:
        return self.reference_key(hints)

    def _by_names(self, names: list[str], *, identity_hints: IdentityHints) -> str | None:
        for name in names:
            key = self._unique("name", _slug(name))
            if key:
                return key
        for name in names:
            found: set[str] = set()
            for name_key in name_keys(name):
                found |= self._by.get("name_key", {}).get(name_key, set())
            if len(found) == 1:
                return next(iter(found))
            if len(found) > 1:
                return None
        by_signature = self.crosswalk.match(identity_of(identity_hints))
        if by_signature.key is not None and self._known(by_signature.key):
            return by_signature.key
        return None

    # -- the inbox's lookups ------------------------------------------------------------

    def by_list(self, list_id: str | None) -> str | None:
        """A List-Id (`soc-x.lists.cam.ac.uk`) or Sympa list name. Tries the
        list itself, then its society component (`soc-cugs-news` → `soc-cugs`),
        per the UIS naming rule `soc-<society>[-<group>]`."""
        if not list_id:
            return None
        name = sympa_list_name(list_id) or list_id.strip().lower()
        found = self._unique("list", name)
        if found:
            return found
        parts = name.split("-")
        if len(parts) > 2 and parts[0] == "soc":
            return self._unique("list", "-".join(parts[:2]))
        return None

    def by_address(self, address: str | None) -> str | None:
        """An exact published address (the society's own or role address)."""
        return self._unique("address", (address or "").strip().lower())

    def by_domain(self, address_or_url: str | None) -> str | None:
        """A sender on an organisation's own domain (never a shared one)."""
        if not address_or_url:
            return None
        domain = domain_of(address_or_url)
        if not domain or is_shared_domain(domain):
            return None
        return self._unique("domain", domain)

    def by_name(self, name: str | None) -> str | None:
        """A society name as written (a mail's sign-off, a caption)."""
        if not name or not name.strip():
            return None
        return self.reference_key(IdentityHints(name=name.strip()))

    # -- what organisations publish -------------------------------------------------------

    def get(self, key: str) -> KnownOrg | None:
        return self.orgs.get(key)

    def __len__(self) -> int:
        return len(self.orgs)

    def org_type(self, key: str) -> str | None:
        org = self.orgs.get(key)
        return org.org_type if org else None

    def name_of(self, key: str) -> str | None:
        org = self.orgs.get(key)
        return org.names[0] if org and org.names else None

    def organisations(self) -> dict[str, str]:
        """Every indexed organisation: key → name."""
        return {key: org.display_name for key, org in self.orgs.items()}

    def resolve_venue(self, name: str) -> str | None:
        slug = _slug(name)
        keys = self._venues.get(slug) if slug else None
        return next(iter(keys)) if keys and len(keys) == 1 else None

    def owner_of_talks_list(self, list_id: str) -> str | None:
        return self._unique("talks_list", list_id)

    def feeds(self, *kinds: str) -> list[FeedRef]:
        return sorted(
            (feed for feed in self._feeds.values() if not kinds or feed.kind in kinds),
            key=lambda feed: (feed.kind, feed.value, feed.org_key),
        )

    def instagram_targets(self) -> list[tuple[str, str]]:
        """`(org key, handle)` for every organisation with exactly one handle,
        a handle no other organisation also claims, sorted by handle."""
        owners: dict[str, set[str]] = defaultdict(set)
        for org in self.orgs.values():
            for handle in org.instagram_handles:
                owners[handle].add(org.key)
        targets = [
            (org.key, next(iter(org.instagram_handles)))
            for org in self.orgs.values()
            if len(org.instagram_handles) == 1
            and len(owners[next(iter(org.instagram_handles))]) == 1
        ]
        return sorted(targets, key=lambda pair: pair[1])

    def termcards(self) -> list[tuple[str, str]]:
        """`(org key, termcard URL)` pairs, sorted."""
        return sorted((org.key, url) for org in self.orgs.values() for url in org.termcard_urls)


__all__ = [
    "FEED_FIELDS",
    "SHARED_DOMAINS",
    "FeedRef",
    "KnownOrg",
    "OrgLookup",
    "domain_of",
    "instagram_key",
    "is_shared_domain",
    "name_keys",
    "sympa_list_name",
]
