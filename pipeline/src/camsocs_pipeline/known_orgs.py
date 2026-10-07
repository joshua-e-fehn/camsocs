"""The organisations the pipeline already knows, from keyed staged observations.

Stages that run after `resolve` (inbox, instagram, termcards) need to answer
"which organisation is this?" and "which organisations have an Instagram
handle / a termcard?" without calling Convex and without minting keys. The
answer is on disk: every keyed organisation `Observation` in the latest
staging file of each directory (the resolver's `_resolved`, and enrichment
stages' own directories). `KnownOrgs.from_staging` folds them into one index
per organisation key.

What it indexes, from identity hints, claimed field values and `internal`:

- names: `identity.name` / `aliases`, the `name`, `aliases`, `shortName` values;
- Sympa lists: `internal.sympa_list`, a `mailingList` address
  `<list>@lists.cam.ac.uk` or sign-up URL `lists.cam.ac.uk/sympa/<…>/<list>`;
- addresses: `email`, `roleEmails`, `mailingList.address` values;
- own domains: `identity.website_domain` / `email_domain`, the `website` and
  `email` values' domains — except shared domains (webmail, cam.ac.uk and its
  colleges, the SU, SRCF, lists), which identify nobody;
- Instagram handles: `identity.instagram_handle`, `internal.instagram_handle`,
  `socials` values on instagram.com;
- termcard URLs: `termcardUrl` values.

Matching is exact on normalised forms and refuses ambiguity: a list name,
address, domain or name that points at two organisations matches neither.
Nothing here leaves the pipeline; personal addresses are only compared.
"""

from __future__ import annotations

import re
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field
from urllib.parse import urlsplit

from camsocs_pipeline.keys import slugify
from camsocs_pipeline.models.observation import Observation
from camsocs_pipeline.staging.store import Record, StagingStore

#: Domains shared by many senders, which identify no single organisation.
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
_HANDLE = re.compile(r"^[a-z0-9._]{1,30}$")
_INSTAGRAM_RESERVED = frozenset({"p", "reel", "reels", "explore", "stories", "accounts", "tv"})

#: Words stripped from the front / back of a name to form a looser match key.
_NAME_PREFIXES = ("university-of-cambridge-", "cambridge-university-", "cambridge-", "cu-")
_NAME_SUFFIXES = ("-society", "-soc", "-club")


def domain_of(value: str) -> str | None:
    """The host of a URL or the domain of an address, lower-cased, no `www.`."""
    text = value.strip().lower()
    if "@" in text and "://" not in text:
        host = text.rsplit("@", 1)[1]
    else:
        host = urlsplit(text if "://" in text else f"https://{text}").hostname or ""
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


def instagram_handle(value: str) -> str | None:
    """`https://www.instagram.com/cugsoc/` or `@cugsoc` → `cugsoc`."""
    text = value.strip()
    if "://" in text or text.lower().startswith(("instagram.com", "www.instagram.com")):
        parts = urlsplit(text if "://" in text else f"https://{text}")
        if (parts.hostname or "").lower().removeprefix("www.") != "instagram.com":
            return None
        segments = [segment for segment in parts.path.split("/") if segment]
        if not segments or segments[0].lower() in _INSTAGRAM_RESERVED:
            return None
        text = segments[0]
    handle = text.lstrip("@").strip().lower()
    return handle if _HANDLE.match(handle) else None


def name_keys(name: str) -> set[str]:
    """Normalised forms of a name: its slug; the slug without the usual
    "Cambridge University" / "CU" prefix ("CU German Society" and "Cambridge
    University German Society" share `german-society`); and that without a
    trailing "Society" / "Club", kept only when it is several words or a long
    word, so a bare "German" or "Chess" never matches."""
    try:
        slug = slugify(name)
    except ValueError:
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


@dataclass
class KnownOrg:
    key: str
    names: list[str] = field(default_factory=list)
    short_names: set[str] = field(default_factory=set)
    sympa_lists: set[str] = field(default_factory=set)
    addresses: set[str] = field(default_factory=set)
    domains: set[str] = field(default_factory=set)
    instagram_handles: set[str] = field(default_factory=set)
    termcard_urls: set[str] = field(default_factory=set)

    @property
    def display_name(self) -> str:
        return self.names[0] if self.names else self.key.removeprefix("org-")


def _unique(index: dict[str, set[str]], value: str | None) -> str | None:
    if not value:
        return None
    keys = index.get(value)
    return next(iter(keys)) if keys and len(keys) == 1 else None


class KnownOrgs:
    """An index of known organisations; see the module docstring."""

    def __init__(self) -> None:
        self.orgs: dict[str, KnownOrg] = {}
        self._by_list: dict[str, set[str]] = defaultdict(set)
        self._by_address: dict[str, set[str]] = defaultdict(set)
        self._by_domain: dict[str, set[str]] = defaultdict(set)
        self._by_name: dict[str, set[str]] = defaultdict(set)

    # -- building --------------------------------------------------------------

    @classmethod
    def from_records(cls, records: Iterable[Record]) -> KnownOrgs:
        index = cls()
        for record in records:
            if (
                isinstance(record, Observation)
                and record.entity_type == "organisation"
                and record.entity_key
            ):
                index.add(record)
        return index

    @classmethod
    def from_staging(cls, store: StagingStore) -> KnownOrgs:
        return cls.from_records(
            record for name in store.directories() for record in store.read_latest(name)
        )

    def add(self, obs: Observation) -> None:
        key = obs.entity_key
        assert key is not None
        org = self.orgs.setdefault(key, KnownOrg(key))

        def name(value: object, *, short: bool = False) -> None:
            if isinstance(value, str) and value.strip():
                if value.strip() not in org.names:
                    org.names.append(value.strip())
                if short:
                    org.short_names.add(value.strip())
                for name_key in name_keys(value):
                    self._by_name[name_key].add(key)

        def address(value: object) -> None:
            if isinstance(value, str) and "@" in value:
                normalised = value.strip().lower()
                org.addresses.add(normalised)
                self._by_address[normalised].add(key)
                listed = sympa_list_name(normalised)
                if listed:
                    self._add_list(org, listed)
                else:
                    domain(normalised)

        def domain(value: object) -> None:
            if isinstance(value, str) and value.strip():
                found = domain_of(value)
                if found and not is_shared_domain(found):
                    org.domains.add(found)
                    self._by_domain[found].add(key)

        identity = obs.identity
        name(identity.name)
        for alias in identity.aliases:
            name(alias)
        domain(identity.website_domain)
        domain(identity.email_domain)
        if identity.instagram_handle:
            handle = instagram_handle(identity.instagram_handle)
            if handle:
                org.instagram_handles.add(handle)

        internal = obs.internal
        if isinstance(internal.get("sympa_list"), str):
            listed = sympa_list_name(internal["sympa_list"]) or internal["sympa_list"].lower()
            self._add_list(org, listed)
        if isinstance(internal.get("instagram_handle"), str):
            handle = instagram_handle(internal["instagram_handle"])
            if handle:
                org.instagram_handles.add(handle)

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
                            handle = instagram_handle(str(item.get("handle") or item.get("url")))
                            if handle:
                                org.instagram_handles.add(handle)
                case "termcardUrl":
                    if isinstance(value, str) and value.startswith(("http://", "https://")):
                        org.termcard_urls.add(value)
                case _:
                    pass

    def _add_list(self, org: KnownOrg, list_name: str) -> None:
        org.sympa_lists.add(list_name)
        self._by_list[list_name].add(org.key)

    # -- lookups ---------------------------------------------------------------

    def get(self, key: str) -> KnownOrg | None:
        return self.orgs.get(key)

    def __len__(self) -> int:
        return len(self.orgs)

    def by_list(self, list_id: str | None) -> str | None:
        """A List-Id (`soc-x.lists.cam.ac.uk`) or Sympa list name. Tries the
        list itself, then its society component (`soc-cugs-news` → `soc-cugs`),
        per the UIS naming rule `soc-<society>[-<group>]`."""
        if not list_id:
            return None
        name = sympa_list_name(list_id) or list_id.strip().lower()
        found = _unique(self._by_list, name)
        if found:
            return found
        parts = name.split("-")
        if len(parts) > 2 and parts[0] == "soc":
            return _unique(self._by_list, "-".join(parts[:2]))
        return None

    def by_address(self, address: str | None) -> str | None:
        """An exact published address (the society's own or role address)."""
        return _unique(self._by_address, (address or "").strip().lower())

    def by_domain(self, address_or_url: str | None) -> str | None:
        """A sender on an organisation's own domain (never a shared one)."""
        if not address_or_url:
            return None
        domain = domain_of(address_or_url)
        if not domain or is_shared_domain(domain):
            return None
        return _unique(self._by_domain, domain)

    def by_name(self, name: str | None) -> str | None:
        """A society name as written (signature, display name, caption)."""
        if not name:
            return None
        matches: set[str] = set()
        for key in name_keys(name):
            matches |= self._by_name.get(key, set())
        return next(iter(matches)) if len(matches) == 1 else None

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
    "SHARED_DOMAINS",
    "KnownOrg",
    "KnownOrgs",
    "domain_of",
    "instagram_handle",
    "is_shared_domain",
    "name_keys",
    "sympa_list_name",
]
