"""Reading contact details and social links off a page — deterministic, shared
by every seed harvester.

What a harvester may take from a page (AGENTS.md "Data honesty", source-research
global rules) is decided here once:

- **Personal CRSids never leave this module as a value.** `is_personal_crsid`
  mirrors the server's rule (`classifyEmail` in convex/lib/derived.ts): a
  CRSid-shaped local part on cam.ac.uk or any subdomain names a person.
- **Role addresses** (``president@…``, ``mcr.welfare@…``) become ``roleEmails``
  with a `ROLES` value; ``other`` for an officer post we do not have a role for.
- **A general address** (``info@``, ``enquiries@``, or one carrying the
  organisation's own name, ``cuadc@…``) becomes ``email``. Anything else —
  ``sam@…``, ``j.smith@gmail.com`` — may be a person's own address and is
  skipped unless the page *labels* it as the organisation's contact
  (`classify_email(..., labelled=True)`).
- **Obfuscated addresses are never decoded** (Cloudflare email protection,
  ``name[at]domain``): `has_obfuscated_emails` only reports that the page hides
  them, so the caller can record ``missing`` / ``access_restricted``.
- **Social links are stored, never fetched** (Instagram, Facebook, LinkedIn):
  `social_link` classifies a URL into a `SOCIAL_PLATFORMS` entry and drops
  tracking parameters. A bare ``instagram.com/x`` (as printed in a PDF) gains
  ``https://``; a printed ``@handle`` becomes its profile URL — a normalisation
  of what was published, never a guess.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from camsocs_pipeline.keys import slugify

# --- emails ------------------------------------------------------------------------------

#: Same shape as the server's check (lib/fields.ts `isEmail`), plus a word boundary.
EMAIL_PATTERN = re.compile(r"(?<![\w.+-])[\w.+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+", re.IGNORECASE)
_CRSID_LOCAL = re.compile(r"^[a-z]{2,5}[0-9]{1,5}$")
#: TLD typos seen in published contacts (source-research §4: one ``gmail.comm``).
_BAD_TLDS = frozenset({"comm", "con", "cmo", "ocm", "coom", "uk1"})

_ROLE_WORDS: dict[str, str] = {
    "president": "president",
    "presidents": "president",
    "copresident": "president",
    "chair": "president",
    "secretary": "secretary",
    "sec": "secretary",
    "treasurer": "treasurer",
    "juniortreasurer": "treasurer",
    "sponsorship": "sponsorship",
    "sponsor": "sponsorship",
    "sponsors": "sponsorship",
    "events": "events",
    "event": "events",
    "ents": "events",
    "social": "events",
    "socials": "events",
    "publicity": "publicity",
    "publicist": "publicity",
    "marketing": "publicity",
    "comms": "publicity",
    "communications": "publicity",
    "media": "publicity",
    "welfare": "welfare",
    "captain": "captain",
    "captains": "captain",
    "cudtcaptains": "captain",
}
#: Officer posts with no `ROLES` value of their own: ``other``.
_OTHER_ROLE_WORDS = frozenset(
    {
        "technician",
        "technicians",
        "technical",
        "tech",
        "td",
        "sm",
        "webmaster",
        "web",
        "computerofficer",
        "access",
        "accessibility",
        "international",
        "green",
        "greenofficer",
        "environment",
        "ethical",
        "bame",
        "bme",
        "disabilities",
        "disability",
        "lgbt",
        "lgbtq",
        "lgbtplus",
        "external",
        "academic",
        "education",
        "careers",
        "family",
        "families",
        "allotment",
        "artsandmusic",
        "arts",
        "music",
        "edi",
        "officer",
        "rep",
        "sports",
        "sport",
        "bar",
        "formals",
        "freshers",
        "housing",
        "accommodation",
        "charity",
        "rag",
        "membership",
        "outreach",
        "alumni",
        "steward",
        "fellow",
        "studentinteraction",
        "musicians",
        "nights",
        "producer",
        "director",
    }
)
_GENERIC_LOCALS = frozenset(
    {
        "info",
        "information",
        "enquiries",
        "enquiry",
        "inquiries",
        "contact",
        "hello",
        "hi",
        "admin",
        "office",
        "mail",
        "team",
        "general",
        "committee",
        "support",
        "exec",
        "board",
    }
)
#: Words too common to show an address belongs to *this* organisation.
_STOP_TOKENS = frozenset(
    {
        "the",
        "and",
        "club",
        "clubs",
        "society",
        "soc",
        "university",
        "cambridge",
        "college",
        "team",
        "group",
        "association",
        "union",
        "students",
        "student",
    }
)


def find_emails(text: str) -> list[str]:
    """Every email address in `text`, in order, de-duplicated (case-insensitively)."""
    seen: set[str] = set()
    out: list[str] = []
    for match in EMAIL_PATTERN.finditer(text):
        address = match.group(0).strip(".").rstrip(".")
        key = address.lower()
        if key not in seen:
            seen.add(key)
            out.append(address)
    return out


def normalise_email(address: str) -> str:
    """Trimmed, mailto-free, domain lowercased (local parts are kept as published)."""
    address = address.strip().removeprefix("mailto:").split("?", 1)[0].strip()
    local, _, domain = address.rpartition("@")
    return f"{local}@{domain.lower()}" if local else address


def _split(address: str) -> tuple[str, str]:
    local, _, domain = address.strip().lower().rpartition("@")
    return local, domain


def is_personal_crsid(address: str) -> bool:
    """A CRSid-shaped address on cam.ac.uk or a subdomain (not lists.cam.ac.uk)."""
    local, domain = _split(address)
    cam = domain == "cam.ac.uk" or domain.endswith(".cam.ac.uk")
    return cam and domain != "lists.cam.ac.uk" and bool(_CRSID_LOCAL.match(local))


def has_bad_tld(address: str) -> bool:
    """A published typo (``gmail.comm``): kept out rather than corrected."""
    _local, domain = _split(address)
    return domain.rsplit(".", 1)[-1] in _BAD_TLDS


def _local_tokens(local: str) -> list[str]:
    return [token for token in re.split(r"[._+\-]+", local) if token]


def _role_of_words(words: list[str]) -> str | None:
    """The role a run of words names: a deputy is ``other``; a named role
    wins over a qualifier ("womens president"); an unnamed post is ``other``."""
    if any(word.startswith("vice") or word in ("vp", "deputy") for word in words):
        return "other"
    for word in words:
        if word in _ROLE_WORDS:
            return _ROLE_WORDS[word]
    if any(word in _OTHER_ROLE_WORDS or word.rstrip("s") in _OTHER_ROLE_WORDS for word in words):
        return "other"
    return None


def role_of(address: str) -> str | None:
    """The `ROLES` value an address's local part names, or None.

    A deputy (``vicepresident@``) or a post we have no role for
    (``td@``, ``mcr.access@``) is ``other`` — still a role address; a qualifier
    does not change the role (``womens.president@`` is ``president``)."""
    local, _domain = _split(address)
    tokens = _local_tokens(local)
    role = _role_of_words(tokens)
    if role is not None:
        return role
    # Joined words: "cuhwcpresident", "mcrpresident", "secretarycugs".
    for token in tokens:
        for word, joined_role in _ROLE_WORDS.items():
            if len(word) >= 6 and (token.endswith(word) or token.startswith(word)):
                return joined_role
    return None


def name_tokens(*names: str | None) -> set[str]:
    """Distinctive lower-case tokens (≥ 4 characters) of an organisation's names
    and acronyms, for recognising its own addresses (``cuadc@…``)."""
    tokens: set[str] = set()
    for name in names:
        if not name:
            continue
        try:
            slug = slugify(name)
        except ValueError:
            continue
        for token in slug.split("-"):
            if len(token) >= 4 and token not in _STOP_TOKENS:
                tokens.add(token)
        compact = slug.replace("-", "")
        if 3 <= len(compact) <= 8:
            tokens.add(compact)  # acronyms: "cuadc", "jcsu"
    return tokens


#: Mail hosts anyone can use: an address there belongs to whoever publishes it.
_SHARED_MAIL_HOSTS = (
    "gmail.com",
    "googlemail.com",
    "outlook.com",
    "hotmail.com",
    "hotmail.co.uk",
    "yahoo.com",
    "yahoo.co.uk",
    "icloud.com",
    "lists.cam.ac.uk",
    "srcf.net",
    "srcf.ucam.org",
    "cambridgesu.co.uk",
)


def registrable(host: str) -> str:
    """The part of a host an organisation registers: ``jesus.cam.ac.uk`` for
    ``mcr.jesus.cam.ac.uk``, ``cuadc.org`` for ``www.cuadc.org``."""
    labels = host.lower().removeprefix("www.").split(".")
    if host.endswith(".cam.ac.uk"):
        return ".".join(labels[-4:])
    if len(labels) >= 3 and labels[-2] in ("ac", "co", "org", "gov", "net") and labels[-1] == "uk":
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


def _owns_domain(domain: str, site_host: str | None) -> bool:
    if site_host is None:
        return True
    if any(domain == shared or domain.endswith("." + shared) for shared in _SHARED_MAIL_HOSTS):
        return True
    return registrable(domain) == registrable(site_host)


def is_generic(
    address: str,
    own_tokens: set[str] | frozenset[str] = frozenset(),
    site_host: str | None = None,
) -> bool:
    """A general address of the organisation: ``info@`` on its own (or a
    shared) mail domain, or one whose local part carries its name (``cuadc@``,
    ``drydensoc@gmail.com``). Being on the organisation's domain is not
    enough (``sam@society.org`` is Sam's), and an ``info@`` of another domain
    on its page (the college's IT desk) is not the organisation's."""
    local, domain = _split(address)
    compact = local.replace(".", "").replace("-", "").replace("_", "")
    if any(token in compact for token in own_tokens if len(token) >= 3):
        return True
    generic = local in _GENERIC_LOCALS or any(t in _GENERIC_LOCALS for t in _local_tokens(local))
    return generic and _owns_domain(domain, site_host)


@dataclass(frozen=True)
class EmailReading:
    """What one address on a page is. ``kind``: ``role`` (→ roleEmails),
    ``general`` (→ email), ``personal`` (never stored) or ``unknown`` (skipped)."""

    address: str
    kind: str
    role: str | None = None


def label_role(label: str) -> str | None:
    """The role a link's text names ("Club Publicist", "Actors' Rep")."""
    return _role_of_words(re.findall(r"[a-z]+", label.lower()))


def classify_email(
    address: str,
    own_tokens: set[str] | frozenset[str] = frozenset(),
    *,
    labelled: bool = False,
    label: str | None = None,
    site_host: str | None = None,
) -> EmailReading:
    """Sorts one address. ``labelled``: the page presents it as the
    organisation's contact ("contact: …"), so a webmail address that carries
    no name is still the organisation's. ``label``: the text of the link the
    address sits in, which may name the post. ``site_host``: the host of the
    page it was read on (an ``info@`` of another domain is not the page's).

    An address made of the organisation's short name and a word
    (``gsb.punt@``, ``wcsa-women@``) is an officer's post: ``other``."""
    address = normalise_email(address)
    if is_personal_crsid(address) or has_bad_tld(address):
        return EmailReading(address, "personal" if is_personal_crsid(address) else "unknown")
    role = role_of(address) or (label_role(label) if label else None)
    if role is not None:
        return EmailReading(address, "role", role)
    local, _domain = _split(address)
    tokens = _local_tokens(local)
    if (
        len(tokens) > 1
        and tokens[0] in own_tokens
        and not any(t in _GENERIC_LOCALS for t in tokens[1:])
    ):
        return EmailReading(address, "role", "other")
    if is_generic(address, own_tokens, site_host) or labelled:
        return EmailReading(address, "general")
    return EmailReading(address, "unknown")


@dataclass
class Contacts:
    """The contact fields one page yields, ready for `claims.parser_field`."""

    email: str | None = None
    role_emails: list[dict[str, str]] | None = None
    skipped: int = 0

    def add(self, reading: EmailReading) -> None:
        if reading.kind == "general" and self.email is None:
            self.email = reading.address
        elif reading.kind == "role":
            entries = self.role_emails if self.role_emails is not None else []
            key = (reading.role, reading.address.lower())
            if all((e["role"], e["email"].lower()) != key for e in entries):
                entries.append({"role": reading.role or "other", "email": reading.address})
            self.role_emails = entries
        elif reading.kind != "general":
            self.skipped += 1


def read_contacts(
    addresses: list[str], own_tokens: set[str] | frozenset[str] = frozenset(), *, labelled=False
) -> Contacts:
    contacts = Contacts()
    for address in addresses:
        contacts.add(classify_email(address, own_tokens, labelled=labelled))
    return contacts


_CLOUDFLARE = re.compile(r"/cdn-cgi/l/email-protection|__cf_email__|data-cfemail", re.IGNORECASE)
_AT_OBFUSCATION = re.compile(r"[\w.+-]+\s*[\[\(\{]\s*at\s*[\]\)\}]\s*[\w-]+(?:\.[\w-]+)+", re.I)


def has_obfuscated_emails(html: str) -> bool:
    """The page hides addresses from automated readers (Cloudflare email
    protection, ``name[at]domain``). Reported, never decoded."""
    return bool(_CLOUDFLARE.search(html) or _AT_OBFUSCATION.search(html))


# --- social links ------------------------------------------------------------------------

_TRACKING = re.compile(r"^(utm_|fbclid$|igshid$|igsh$|hl$|ref$|ref_src$|si$|mibextid$)")
_HOST_PLATFORMS: tuple[tuple[str, str], ...] = (
    ("instagram.com", "instagram"),
    ("facebook.com", "facebook_page"),
    ("fb.com", "facebook_page"),
    ("twitter.com", "x"),
    ("x.com", "x"),
    ("tiktok.com", "tiktok"),
    ("youtube.com", "youtube"),
    ("youtu.be", "youtube"),
    ("linkedin.com", "linkedin"),
    ("linktr.ee", "linktree"),
    ("threads.net", "threads"),
    ("threads.com", "threads"),
    ("bsky.app", "bluesky"),
)
#: First path segments that are not an account.
_NOT_ACCOUNTS = frozenset(
    {"p", "reel", "reels", "explore", "stories", "share", "sharer", "sharer.php", "intent", "tv"}
)
_BARE_URL = re.compile(
    r"(?<![\w@/.-])((?:https?://)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:/[^\s,;()<>\"']*)?)",
    re.IGNORECASE,
)


def with_scheme(url: str) -> str:
    url = url.strip().rstrip(".,;")
    if not re.match(r"^https?://", url, re.IGNORECASE):
        url = "https://" + url.lstrip("/")
    return url


def clean_url(url: str) -> str:
    """http(s) URL with tracking parameters and fragments removed."""
    parts = urlsplit(with_scheme(url))
    query = urlencode([(k, v) for k, v in parse_qsl(parts.query) if not _TRACKING.match(k)])
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path, query, ""))


def host_of(url: str) -> str:
    host = urlsplit(with_scheme(url)).netloc.lower().split(":")[0]
    return host.removeprefix("www.").removeprefix("m.").removeprefix("web.")


def is_social_host(url: str) -> bool:
    """A link to a social platform (with or without an account in it)."""
    host = host_of(url)
    return any(host == domain or host.endswith("." + domain) for domain, _ in _HOST_PLATFORMS)


def social_link(url: str) -> dict[str, str] | None:
    """`{platform, url, handle?}` for a social profile URL, else None."""
    try:
        cleaned = clean_url(url)
    except ValueError:
        return None
    host = host_of(cleaned)
    platform = next(
        (name for domain, name in _HOST_PLATFORMS if host == domain or host.endswith("." + domain)),
        None,
    )
    if platform is None:
        return None
    segments = [segment for segment in urlsplit(cleaned).path.split("/") if segment]
    if platform == "facebook_page" and segments[:1] == ["groups"]:
        platform = "facebook_group"
        segments = segments[1:]
    if not segments or segments[0].lower() in _NOT_ACCOUNTS:
        return None
    entry = {"platform": platform, "url": cleaned}
    handle = segments[0].lstrip("@")
    if platform in ("instagram", "x", "tiktok", "linktree", "threads") and re.fullmatch(
        r"[\w.]{1,40}", handle
    ):
        entry["handle"] = handle
    return entry


def instagram_from_handle(handle: str) -> dict[str, str] | None:
    """A printed ``@handle`` as its profile link."""
    handle = handle.strip().lstrip("@").strip("/")
    if not re.fullmatch(r"[A-Za-z0-9_.]{1,30}", handle):
        return None
    return {
        "platform": "instagram",
        "url": f"https://www.instagram.com/{handle}/",
        "handle": handle,
    }


def instagram_handle(socials: list[dict[str, str]] | None) -> str | None:
    for entry in socials or []:
        if entry["platform"] == "instagram" and entry.get("handle"):
            return entry["handle"].lower()
    return None


def bare_urls(text: str) -> list[str]:
    """URL-like tokens in plain text ("cuafc.org", "instagram.com/cuafc"),
    emails excluded, in order."""
    out: list[str] = []
    for match in _BARE_URL.finditer(text):
        token = match.group(1).rstrip(".,;:")
        if "@" in text[max(0, match.start() - 1) : match.start()]:
            continue
        out.append(token)
    return out


def dedupe_socials(entries: list[dict[str, str]]) -> list[dict[str, str]]:
    seen: set[str] = set()
    out: list[dict[str, str]] = []
    for entry in entries:
        key = re.sub(r"^https?://(www\.)?", "", entry["url"].lower()).rstrip("/")
        if key not in seen:
            seen.add(key)
            out.append(entry)
    return out


__all__ = [
    "Contacts",
    "EmailReading",
    "bare_urls",
    "classify_email",
    "clean_url",
    "dedupe_socials",
    "find_emails",
    "has_bad_tld",
    "has_obfuscated_emails",
    "host_of",
    "instagram_from_handle",
    "instagram_handle",
    "is_generic",
    "is_personal_crsid",
    "is_social_host",
    "label_role",
    "name_tokens",
    "normalise_email",
    "read_contacts",
    "registrable",
    "role_of",
    "social_link",
    "with_scheme",
]
