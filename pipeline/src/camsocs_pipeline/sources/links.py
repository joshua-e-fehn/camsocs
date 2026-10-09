"""What a published link or address *is* — the one module every harvester and
the website enrichment use to turn hrefs and email addresses into socials,
websites, chat channels, mailing lists, contact addresses and email kinds.

Nothing here fetches anything. A link is classified by its shape alone, which
is also why Instagram, Facebook and LinkedIn links are safe to handle here:
they are stored, never visited (source-research "Global rules").

**URLs.** `absolute_url` is the one way an href becomes a URL we may store:
http(s) only, a dotted host, no user-info (``http://name@host`` is a mistyped
email address, not a link). `with_scheme` / `clean_url` normalise a printed
link ("instagram.com/x" in a PDF) without guessing anything.

**Socials** (`social_link`, the one social-link classifier): a URL becomes a
`SOCIAL_PLATFORMS` item ``{platform, url, handle?}`` only when it names an
account — not a post, a share button, a platform page or a person's LinkedIn
(``/in/…`` is never stored). The URL is kept as published, less its query and
fragment (share and tracking parameters), except where the query is the
address (``facebook.com/profile.php?id=…``, WeChat articles).
`social_key` compares two items however they were written.

**Chat and mailing lists**: a chat link is reported as a platform only (invite
URLs are never stored, not even inside free text: `withhold_chat_invites`);
`mailing_list_link` recognises a published sign-up link.

**Emails.** One CRSid rule (`CRSID_PATTERN`, `is_crsid_address`): a
CRSid-shaped local part on cam.ac.uk or a subdomain (not lists.cam.ac.uk), or
on SRCF (``srcf.net``, ``srcf.ucam.org``) and the alumni forwarding services
(``cantab.ac.uk``, ``cantab.net``), which issue addresses by CRSid.

- `email_type` mirrors `classifyEmail` in webapp/convex/lib/derived.ts (the
  server derives `emailType` with it); both are asserted against
  webapp/lib/email-types.fixtures.json.
- `classify_email` is the one reading of an address published on a page:
  ``role`` (→ ``roleEmails``, with a `ROLES` value; ``other`` for a post we
  have no role for), ``general`` (→ ``email``: ``info@``, an address carrying
  the organisation's name, a society mailbox at the SU / SRCF / lists), or
  never stored: ``personal`` (a CRSid) and ``unknown`` (``sam@…``,
  ``jane.smith@…``, another domain's ``info@``) — AGENTS.md "personal CRSids
  and named people never appear in public fields".
- **Obfuscated addresses are never decoded** (Cloudflare email protection,
  ``name[at]domain``): `has_obfuscated_emails` only reports that a page hides
  them, so the caller can record ``missing`` / ``access_restricted``.
- `withhold_personal_emails` / `withhold_private` make free text safe to
  publish with the same rules the server applies.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal
from urllib.parse import parse_qs, parse_qsl, unquote, urlencode, urljoin, urlsplit, urlunsplit

from camsocs_pipeline.keys import slugify

# --- URLs -----------------------------------------------------------------------------

_HOST = re.compile(r"^[a-z0-9-]+(\.[a-z0-9-]+)+$")
#: A scheme-less href that is clearly a web address ("www.x.org", "x.co.uk/y").
_BARE_WEB = re.compile(r"^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(/|$)", re.IGNORECASE)


def absolute_url(href: str | None, base: str | None = None) -> str | None:
    """`href` as an absolute http(s) URL we may store, or None.

    Protocol-relative (``//instagram.com/x``) and scheme-less web addresses
    (``www.soc.org``) become ``https``; relative paths resolve against
    `base`. Anything else (``mailto:``, ``javascript:``, a host without a dot,
    user-info) is not a link we keep.
    """
    if href is None:
        return None
    text = href.strip().replace(" ", "%20")
    if not text or text.startswith("#"):
        return None
    if text.startswith("//"):
        text = "https:" + text
    elif not re.match(r"^[a-z][a-z0-9+.-]*:", text, re.IGNORECASE):
        if _BARE_WEB.match(text):
            text = "https://" + text
        elif base is not None:
            text = urljoin(base, text)
        else:
            return None
    try:
        parts = urlsplit(text)
    except ValueError:
        return None
    if parts.scheme.lower() not in ("http", "https"):
        return None
    if "@" in parts.netloc or not _HOST.match((parts.hostname or "").lower()):
        return None
    if len(text) > 2048:
        return None
    return text


def with_scheme(url: str) -> str:
    """A printed link ("cuafc.org/join", "//x.org") as an ``https`` URL; a
    URL that has a scheme is returned trimmed."""
    url = url.strip().rstrip(".,;")
    if not re.match(r"^https?://", url, re.IGNORECASE):
        url = "https://" + url.lstrip("/")
    return url


_TRACKING = re.compile(r"^(utm_|fbclid$|igshid$|igsh$|hl$|ref$|ref_src$|si$|mibextid$)")


def clean_url(url: str) -> str:
    """http(s) URL with tracking parameters and the fragment removed; scheme
    and host lower-cased, the path as published."""
    parts = urlsplit(with_scheme(url))
    query = urlencode([(k, v) for k, v in parse_qsl(parts.query) if not _TRACKING.match(k)])
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path, query, ""))


def unwrap_redirect(href: str) -> str:
    """The target of a click-tracking wrapper the author pasted by accident
    (Outlook SafeLinks, Google's ``/url?q=``); any other href unchanged. The
    target is in the wrapper's own query string — nothing is fetched."""
    try:
        parts = urlsplit(href.strip())
    except ValueError:
        return href
    host = (parts.hostname or "").lower()
    query = parse_qs(parts.query)
    if host.endswith("safelinks.protection.outlook.com") and query.get("url"):
        return query["url"][0]
    if host in ("www.google.com", "google.com") and parts.path == "/url" and query.get("q"):
        return query["q"][0]
    return href


def host_of(url: str) -> str:
    """The URL's host, lowercased, without ``www.``; a printed link without a
    scheme ("cuafc.org/join") is read as https."""
    text = url.strip()
    if "://" not in text:
        text = "https://" + text.lstrip("/")
    try:
        host = (urlsplit(text).hostname or "").lower()
    except ValueError:
        return ""
    return host.removeprefix("www.")


def _host_is(host: str, *domains: str) -> bool:
    return any(host == domain or host.endswith("." + domain) for domain in domains)


def _path_segments(url: str) -> list[str]:
    return [unquote(segment) for segment in urlsplit(url).path.split("/") if segment]


_BARE_URL = re.compile(
    r"(?<![\w@/.-])((?:https?://)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:/[^\s,;()<>\"']*)?)",
    re.IGNORECASE,
)


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


# --- socials ----------------------------------------------------------------------------

SocialPlatform = Literal[
    "instagram",
    "facebook_page",
    "facebook_group",
    "x",
    "linkedin",
    "tiktok",
    "youtube",
    "linktree",
    "website_blog",
    "wechat",
    "threads",
    "bluesky",
]

#: Hosts whose links are socials (or nothing) — never a society's website —
#: and the platform family each belongs to.
_SOCIAL_HOSTS: tuple[tuple[str, str], ...] = (
    ("instagram.com", "instagram"),
    ("instagr.am", "instagram"),
    ("facebook.com", "facebook"),
    ("fb.com", "facebook"),
    ("fb.me", "facebook"),
    ("twitter.com", "x"),
    ("x.com", "x"),
    ("linkedin.com", "linkedin"),
    ("tiktok.com", "tiktok"),
    ("youtube.com", "youtube"),
    ("youtu.be", "youtube"),
    ("linktr.ee", "linktree"),
    ("linktree.com", "linktree"),
    ("threads.net", "threads"),
    ("threads.com", "threads"),
    ("bsky.app", "bluesky"),
    ("weixin.qq.com", "wechat"),
)

_INSTAGRAM_HANDLE = re.compile(r"^[A-Za-z0-9._]{1,30}$")
_X_HANDLE = re.compile(r"^[A-Za-z0-9_]{1,15}$")
_LINKTREE_HANDLE = re.compile(r"^[A-Za-z0-9._-]{1,60}$")
#: First path segments that are Instagram pages, not accounts.
_INSTAGRAM_RESERVED = frozenset(
    {
        "p",
        "reel",
        "reels",
        "explore",
        "stories",
        "tv",
        "accounts",
        "direct",
        "about",
        "legal",
        "share",
        "developer",
    }
)
#: First path segments of Facebook pages that are not a page or group address
#: (share buttons, posts, events, photos, people).
_FACEBOOK_RESERVED = frozenset(
    {
        "group.php",
        "home.php",
        "login",
        "login.php",
        "sharer",
        "sharer.php",
        "share",
        "share.php",
        "dialog",
        "plugins",
        "events",
        "watch",
        "photo.php",
        "photos",
        "permalink.php",
        "story.php",
        "search",
        "hashtag",
    }
)
_X_RESERVED = frozenset(
    {"i", "intent", "share", "home", "search", "hashtag", "explore", "settings", "login"}
)
#: Words that make a Facebook ``/people/`` page an organisation's.
_ORGANISATION_WORDS = (
    r"(society|soc|club|cambridge|university|association|union|team|group|network|college)"
)
#: LinkedIn pages of an organisation; ``/in/<person>`` is a person, never stored.
_LINKEDIN_ORGANISATIONS = frozenset({"company", "school", "showcase", "groups"})


def _social_host(url: str) -> str:
    """The host for platform detection: no ``www.`` / ``m.`` / ``web.`` /
    ``mobile.`` prefix (``m.facebook.com`` is Facebook)."""
    host = host_of(url)
    for prefix in ("m.", "web.", "mobile."):
        host = host.removeprefix(prefix)
    return host


def _platform_family(url: str) -> str | None:
    host = _social_host(url)
    return next((family for domain, family in _SOCIAL_HOSTS if _host_is(host, domain)), None)


def is_social_host(url: str) -> bool:
    """Whether `url` is on a social platform, even when it names no account
    (`social_link` then returns None): such a link is never a website."""
    return _platform_family(url) is not None


def _without_query(url: str) -> str:
    parts = urlsplit(url)
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path, "", ""))


def instagram_handle(value: str | None) -> str | None:
    """The account an Instagram profile URL (or a printed ``@handle``) names,
    as written; None for a post, a reel, another site or anything that is not
    an account."""
    if not value or not value.strip():
        return None
    text = value.strip()
    if "instagram.com" in text.lower() or "instagr.am" in text.lower() or "://" in text:
        url = with_scheme(text)
        if not _host_is(_social_host(url), "instagram.com", "instagr.am"):
            return None
        segments = _path_segments(url)
        if not segments or segments[0].lower() in _INSTAGRAM_RESERVED:
            return None
        text = segments[0]
    handle = text.lstrip("@").strip()
    return handle if _INSTAGRAM_HANDLE.match(handle) else None


def social_link(url: str) -> dict[str, str] | None:
    """A `socials` item (``{platform, url, handle?}``) for a social-platform
    URL, or None when the URL names no account (a post, a share link, a
    person's LinkedIn, a bare host). A printed link without a scheme
    ("instagram.com/cuafc") gains ``https://``. See the module docstring."""
    try:
        absolute = with_scheme(url)
        family = _platform_family(absolute)
        if family is None:
            return None
        segments = _path_segments(absolute)
        clean = _without_query(absolute)
    except ValueError:
        return None
    first = segments[0] if segments else ""
    lowered = first.lower()

    if family == "instagram":
        handle = instagram_handle(absolute)
        return {"platform": "instagram", "url": clean, "handle": handle} if handle else None
    if family == "facebook":
        if not segments or lowered in _FACEBOOK_RESERVED:
            return None
        if lowered == "groups":
            return {"platform": "facebook_group", "url": clean} if len(segments) > 1 else None
        if lowered == "people":
            # facebook.com/people/<Name>/<id>/ is a person's profile or a newer
            # Page: kept only when the name reads as an organisation's.
            name = segments[1].lower() if len(segments) > 1 else ""
            if not re.search(_ORGANISATION_WORDS, name):
                return None
            return {"platform": "facebook_page", "url": clean}
        if lowered == "profile.php":
            profile_id = parse_qs(urlsplit(absolute).query).get("id")
            if not profile_id:
                return None
            clean = f"{clean}?id={profile_id[0]}"
        return {"platform": "facebook_page", "url": clean}
    if family == "x":
        handle = first.lstrip("@")
        if (
            not handle
            or handle.lower() in _X_RESERVED
            or not _X_HANDLE.match(handle)
            or any(segment.lower() in ("status", "statuses") for segment in segments[1:])
        ):
            return None
        return {"platform": "x", "url": clean, "handle": handle}
    if family == "linkedin":
        if lowered not in _LINKEDIN_ORGANISATIONS or len(segments) < 2:
            return None
        return {"platform": "linkedin", "url": clean}
    if family == "tiktok":
        if not first.startswith("@") or len(first) < 2:
            return None
        return {"platform": "tiktok", "url": clean, "handle": first[1:]}
    if family == "youtube":
        # Channels only (`/@name`, `/c/…`, `/channel/…`, `/user/…`); youtu.be is a video.
        if _host_is(_social_host(absolute), "youtu.be"):
            return None
        if first.startswith("@") and len(first) > 1:
            return {"platform": "youtube", "url": clean, "handle": first[1:]}
        if lowered in ("c", "channel", "user") and len(segments) > 1:
            return {"platform": "youtube", "url": clean}
        return None
    if family == "linktree":
        if not first or not _LINKTREE_HANDLE.match(first):
            return None
        return {"platform": "linktree", "url": clean, "handle": first}
    if family == "threads":
        if not first.startswith("@") or len(first) < 2:
            return None
        return {"platform": "threads", "url": clean, "handle": first[1:]}
    if family == "bluesky":
        if lowered != "profile" or len(segments) < 2:
            return None
        return {"platform": "bluesky", "url": clean, "handle": segments[1]}
    if family == "wechat":
        return {"platform": "wechat", "url": absolute}
    return None


def is_personal_profile(url: str) -> bool:
    """A link to one person's profile — a LinkedIn ``/in/`` or ``/pub/``
    page — which is never stored (source-research §14), not even inside a
    description's markdown."""
    try:
        absolute = with_scheme(url)
        if _platform_family(absolute) != "linkedin":
            return False
        segments = _path_segments(absolute)
    except ValueError:
        return False
    return bool(segments) and segments[0].lower() in ("in", "pub")


def social_key(item: dict[str, str] | str) -> str:
    """What two socials items (or URLs) are compared on: the URL lower-cased,
    without scheme, ``www.`` and trailing slash."""
    url = item if isinstance(item, str) else item["url"]
    return re.sub(r"^https?://(www\.)?", "", url.strip().lower()).rstrip("/")


def account_of(item: dict[str, str]) -> str:
    """The account a socials item points at — its handle, else the first
    path segment (a Facebook page's name) — lower-cased."""
    if item.get("handle"):
        return item["handle"].lower().lstrip("@")
    segments = _path_segments(item["url"])
    return segments[0].lower() if segments else ""


def dedupe_socials(entries: list[dict[str, str]]) -> list[dict[str, str]]:
    """`entries` without repeats (`social_key`), first one kept."""
    seen: set[str] = set()
    out: list[dict[str, str]] = []
    for entry in entries:
        key = social_key(entry)
        if key not in seen:
            seen.add(key)
            out.append(entry)
    return out


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


def instagram_handle_of(socials: list[dict[str, str]] | None) -> str | None:
    """The handle of the first Instagram item in `socials`, lower-cased."""
    for entry in socials or []:
        if entry["platform"] == "instagram" and entry.get("handle"):
            return entry["handle"].lower()
    return None


def _shown_handle(entry: dict[str, str], text: str) -> str | None:
    """The account a link's visible text names (``@handle`` or a profile URL
    on the same platform), lower-cased; "" for a bare "@"; None if it names
    none."""
    shown = " ".join(text.split())
    if shown == "@":
        return ""
    at = re.fullmatch(r"@([\w.]{1,40})", shown)
    if at:
        return at.group(1).lower()
    if re.match(r"^(https?://)?(www\.)?[a-z0-9.-]+\.[a-z]{2,}/\S+$", shown, re.I):
        written = social_link(shown)
        if written is not None and written["platform"] == entry["platform"]:
            return (written.get("handle") or "").lower()
    return None


def link_text_disagrees(entry: dict[str, str], text: str) -> bool:
    """Whether a social link's visible text names a *different* account than
    its href — `<a href="instagram.com/cudct/">@c_u_f_c</a>`, or a bare "@"
    left over from pasting one. Then neither can be trusted as the page's own
    account."""
    href_handle = (entry.get("handle") or "").lower()
    shown = _shown_handle(entry, text)
    return bool(href_handle) and shown is not None and shown != href_handle


def link_text_names(entry: dict[str, str], text: str) -> bool:
    """Whether a social link's visible text names the account it links."""
    href_handle = (entry.get("handle") or "").lower()
    return bool(href_handle) and _shown_handle(entry, text) == href_handle


# --- chat channels and mailing lists --------------------------------------------------------

ChatPlatform = Literal["whatsapp", "discord", "telegram", "slack", "groupme"]


def chat_platform(url: str) -> ChatPlatform | None:
    """The chat platform an (invite) link belongs to. The link itself is never
    stored (data-model `chatChannels`): only that the channel exists."""
    host = host_of(url)
    if _host_is(host, "whatsapp.com", "wa.me"):
        return "whatsapp"
    if _host_is(host, "discord.gg", "discord.com", "discordapp.com"):
        return "discord"
    if _host_is(host, "t.me", "telegram.me"):
        return "telegram"
    if _host_is(host, "slack.com"):
        return "slack"
    if _host_is(host, "groupme.com"):
        return "groupme"
    return None


#: Chat invite links — `INVITE_LINK` in webapp/convex/lib/fields.ts, plus WhatsApp's
#: short form. Never stored, not even inside free text.
_CHAT_INVITE = re.compile(
    r"(?:https?://)?(?:www\.)?(?:chat\.whatsapp\.com|wa\.me|discord\.gg|discord(?:app)?\.com/invite"
    r"|t\.me|join\.slack\.com|groupme\.com/join)/[^\s)\]>\"']*",
    re.IGNORECASE,
)
INVITE_WITHHELD = "[chat invite link withheld]"


def withhold_chat_invites(text: str) -> str:
    """`text` with every chat invite URL replaced by a marker."""
    return _CHAT_INVITE.sub(INVITE_WITHHELD, text)


def mailing_list_link(url: str) -> dict[str, str] | None:
    """A `mailingList` value for a sign-up link: Sympa (`lists.cam.ac.uk/sympa/
    subscribe|info/<list>`), Mailchimp or Google Groups. Only a link the page
    gives is a sign-up URL; none is ever constructed."""
    host = host_of(url)
    segments = [segment.lower() for segment in _path_segments(url)]
    if host == "lists.cam.ac.uk":
        if len(segments) >= 3 and segments[0] == "sympa" and segments[1] in ("subscribe", "info"):
            return {"platform": "sympa", "signupUrl": url}
        return None
    if host == "eepurl.com" or (_host_is(host, "list-manage.com") and "subscribe" in segments):
        return {"platform": "mailchimp", "signupUrl": url}
    if host == "groups.google.com":
        return {"platform": "google_group", "signupUrl": url}
    return None


# --- email addresses: syntax, the CRSid rule and the server's kinds --------------------------

EmailType = Literal[
    "role_own_domain",
    "cambridgesu",
    "srcf",
    "lists_cam",
    "college_domain",
    "webmail",
    "personal_crsid",
    "legacy_cusu",
]

#: Same syntax check as `isEmail` in webapp/convex/lib/fields.ts.
_EMAIL = re.compile(r'^[^\s@<>()\[\]\\,;:"]+@[a-z0-9-]+(\.[a-z0-9-]+)+$', re.IGNORECASE)
#: An address in running text (same shape plus a word boundary).
EMAIL_PATTERN = re.compile(r"(?<![\w.+-])[\w.+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+", re.IGNORECASE)

#: Mirrors WEBMAIL_DOMAINS in webapp/convex/lib/derived.ts.
WEBMAIL_DOMAINS = frozenset(
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
        "qq.com",
        "163.com",
        "aol.com",
    }
)

#: A Cambridge CRSid: 2–5 letters then digits (e.g. ``jf123``). The one
#: pattern; `is_crsid_address` and free-text checks (Camdram descriptions) use it.
CRSID_PATTERN = r"[a-z]{2,5}[0-9]{1,5}"
_CRSID_LOCAL = re.compile(rf"^{CRSID_PATTERN}$")

#: Domains outside cam.ac.uk that give every member an address at their
#: CRSid: SRCF user mail (``<crsid>@srcf.net``) and the alumni forwarding
#: services. A CRSid there names a person just as on cam.ac.uk.
_CRSID_MAIL_DOMAINS = frozenset({"srcf.net", "srcf.ucam.org", "cantab.ac.uk", "cantab.net"})


def is_crsid_address(local: str, domain: str) -> bool:
    """`classifyEmail`'s ``personal_crsid`` rule (webapp/convex/lib/derived.ts):
    a CRSid-shaped local part on cam.ac.uk or a subdomain (not
    lists.cam.ac.uk), or on a domain that issues addresses by CRSid."""
    local = local.strip().lower()
    domain = domain.strip().lower().rstrip(".")
    on_cam = (domain == "cam.ac.uk" or domain.endswith(".cam.ac.uk")) and (
        domain != "lists.cam.ac.uk"
    )
    return (on_cam or domain in _CRSID_MAIL_DOMAINS) and bool(_CRSID_LOCAL.match(local))


def _split(address: str) -> tuple[str, str]:
    local, _, domain = address.strip().lower().rpartition("@")
    return local, domain


def is_personal_crsid(address: str) -> bool:
    """`is_crsid_address` for a whole address."""
    local, domain = _split(address)
    return is_crsid_address(local, domain)


def is_email(value: str) -> bool:
    """Plausible syntax only — never a reason to guess an address."""
    return bool(_EMAIL.match(value)) and len(value) <= 254


def email_domain(email: str) -> str:
    return email.strip().lower().rpartition("@")[2]


#: The alumni forwarding services also give name-shaped addresses
#: (``jane.smith@cantab.net``): such an address names its person.
_CANTAB_DOMAINS = frozenset({"cantab.ac.uk", "cantab.net"})
_NAME_SHAPED = re.compile(r"^[a-z]+[._-][a-z]+(?:[._-][a-z]+)?$")


def email_type(email: str) -> EmailType:
    """What kind of address `email` is — `classifyEmail` in
    webapp/convex/lib/derived.ts, rule for rule."""
    address = email.strip().lower()
    at = address.rfind("@")
    local = address[:at]
    domain = address[at + 1 :]
    if is_crsid_address(local, domain):
        return "personal_crsid"
    if domain in _CANTAB_DOMAINS and _NAME_SHAPED.match(local):
        return "personal_crsid"
    if re.search(r"(^|\.)cusu\.", domain) or domain == "cusu.org":
        return "legacy_cusu"
    if domain == "cambridgesu.co.uk" or domain.endswith(".cambridgesu.co.uk"):
        return "cambridgesu"
    if domain == "lists.cam.ac.uk":
        return "lists_cam"
    if re.search(r"(^|\.)srcf\.(net|ucam\.org)$", domain):
        return "srcf"
    if domain.endswith(".cam.ac.uk"):
        return "college_domain"
    if domain in WEBMAIL_DOMAINS:
        return "webmail"
    return "role_own_domain"


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


#: TLD typos seen in published contacts (source-research §4: one ``gmail.comm``).
_BAD_TLDS = frozenset({"comm", "con", "cmo", "ocm", "coom", "uk1"})


def has_bad_tld(address: str) -> bool:
    """A published typo (``gmail.comm``): kept out rather than corrected."""
    _local, domain = _split(address)
    return domain.rsplit(".", 1)[-1] in _BAD_TLDS


#: A CRSid-shaped address anywhere in free text (for withholding it).
_ADDRESS_IN_TEXT = re.compile(
    r"(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?![A-Za-z0-9-])"
)
WITHHELD = "[personal email withheld]"


def withhold_personal_emails(text: str) -> str:
    """`text` with every personal CRSid address replaced by a marker. Free text
    (descriptions) is public; a CRSid names a person and never is. Uses
    `email_type`, so it hides exactly what the server would."""
    return _ADDRESS_IN_TEXT.sub(
        lambda match: (
            WITHHELD
            if email_type(match.group(0).rstrip(".")) == "personal_crsid"
            else match.group(0)
        ),
        text,
    )


def withhold_private(text: str) -> str:
    """Free text made safe to publish: personal CRSid addresses and chat invite
    links withheld (`withhold_personal_emails`, `withhold_chat_invites`)."""
    return withhold_chat_invites(withhold_personal_emails(text))


# --- reading an address published on a page ------------------------------------------------

#: Local-part words that name a `ROLES` post.
ROLE_WORDS: dict[str, str] = {
    "president": "president",
    "presidents": "president",
    "pres": "president",
    "copresident": "president",
    "chair": "president",
    "chairs": "president",
    "secretary": "secretary",
    "sec": "secretary",
    "treasurer": "treasurer",
    "juniortreasurer": "treasurer",
    "treas": "treasurer",
    "finance": "treasurer",
    "sponsorship": "sponsorship",
    "sponsorships": "sponsorship",
    "sponsor": "sponsorship",
    "sponsors": "sponsorship",
    "corporate": "sponsorship",
    "partnerships": "sponsorship",
    "partners": "sponsorship",
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
    "press": "publicity",
    "socialmedia": "publicity",
    "welfare": "welfare",
    "captain": "captain",
    "captains": "captain",
    "capt": "captain",
    "cudtcaptains": "captain",
}
#: Officer posts with no `ROLES` value of their own: ``other``.
OTHER_ROLE_WORDS = frozenset(
    {
        "technician",
        "technicians",
        "technical",
        "tech",
        "td",
        "sm",
        "computerofficer",
        "access",
        "accessibility",
        "international",
        "green",
        "greenofficer",
        "environment",
        "environmental",
        "ethical",
        "bame",
        "bme",
        "disabilities",
        "disability",
        "lgbt",
        "lgbtq",
        "lgbtplus",
        "external",
        "internal",
        "academic",
        "academics",
        "education",
        "careers",
        "career",
        "family",
        "families",
        "allotment",
        "artsandmusic",
        "arts",
        "music",
        "edi",
        "equality",
        "equalities",
        "diversity",
        "inclusion",
        "officer",
        "officers",
        "rep",
        "reps",
        "sports",
        "sport",
        "bar",
        "formals",
        "freshers",
        "housing",
        "accommodation",
        "charity",
        "charities",
        "fundraising",
        "rag",
        "membership",
        "outreach",
        "liaison",
        "alumni",
        "steward",
        "fellow",
        "studentinteraction",
        "musicians",
        "nights",
        "producer",
        "director",
        "coordinator",
        "manager",
        "design",
        "editor",
        "editors",
        "editorial",
        "newsletter",
        "ug",
        "pg",
    }
)
#: Long words that mark a post even inside a longer local part ("caribbeanofficer").
_OTHER_ROLE_PARTS = (
    "officer",
    "coordinator",
    "director",
    "manager",
    "outreach",
    "liaison",
    # A boat club's boatman is a post of the club (``caiusboatman@``,
    # ``lowerboatsmen@``), not its general address.
    "boatman",
    "boatmen",
    "boatsman",
    "boatsmen",
)
#: Local parts meaning "the organisation itself".
GENERIC_LOCALS = frozenset(
    {
        "info",
        "information",
        "enquiries",
        "enquiry",
        "inquiries",
        "contact",
        "contactus",
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
        "executive",
        "board",
        "members",
        "web",
        "webmaster",
        "society",
        "soc",
        "club",
        "jcr",
        "mcr",
        "cambridge",
    }
)
#: A college body's own prefix: ``jcr.bame@``, ``mcr.speaker@`` are its officers.
_BODY_PREFIXES = frozenset({"jcr", "mcr", "jcsu", "gsb"})
#: Words that say where, not which post ("ospreys.cam@").
_PLACE_WORDS = frozenset({"cam", "cambridge", "cu", "uk", "official"})
#: Words that make a named post another one: an external secretary is not the secretary.
_POST_MODIFIERS = frozenset({"external", "internal", "assistant"})
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
#: Mail hosts anyone can use: an address there belongs to whoever publishes it.
_SHARED_MAIL_HOSTS = (
    *sorted(WEBMAIL_DOMAINS),
    "lists.cam.ac.uk",
    "srcf.net",
    "srcf.ucam.org",
    "cambridgesu.co.uk",
)
#: Hosts that issue mailboxes to societies themselves (an SU society address,
#: an SRCF society alias, a Sympa list): a non-personal, non-generic address
#: there is a society's.
_SOCIETY_MAIL_DOMAINS = ("cambridgesu.co.uk", "srcf.net", "srcf.ucam.org", "lists.cam.ac.uk")
_NAME_LIKE = re.compile(r"^[a-z]+[._-][a-z]+$")


def _local_tokens(local: str) -> list[str]:
    return [token for token in re.split(r"[._+\-]+", local) if token]


def _role_of_words(words: list[str]) -> str | None:
    """The role a run of words names: a deputy, an external or an assistant
    post is ``other``; a named role wins over a qualifier ("womens
    president"); an unnamed post is ``other``."""
    if any(word.startswith("vice") or word in ("vp", "deputy") for word in words):
        return "other"
    if len(words) > 1 and any(word in _POST_MODIFIERS for word in words):
        return "other"
    for word in words:
        if word in ROLE_WORDS:
            return ROLE_WORDS[word]
    if any(word in OTHER_ROLE_WORDS or word.rstrip("s") in OTHER_ROLE_WORDS for word in words):
        return "other"
    return None


def role_of(address: str) -> str | None:
    """The `ROLES` value an address's local part names, or None.

    A deputy (``vicepresident@``) or a post we have no role for
    (``td@``, ``mcr.access@``, ``caribbeanofficer@``) is ``other`` — still a
    role address; a qualifier does not change the role
    (``womens.president@`` is ``president``)."""
    local, _domain = _split(address)
    tokens = _local_tokens(local)
    role = _role_of_words(tokens)
    if role is not None:
        return role
    # Joined words: "cuhwcpresident", "mcrpresident", "secretarycugs".
    for token in tokens:
        for word, joined_role in ROLE_WORDS.items():
            if len(word) >= 6 and (token.endswith(word) or token.startswith(word)):
                return joined_role
        if any(part in token for part in _OTHER_ROLE_PARTS):
            return "other"
    return None


#: Posts a link's text may name that are a mailbox when only the address
#: says them (``webmaster@`` is the site's general address; "Webmaster" in a
#: committee list is a post).
_LABEL_POSTS = frozenset({"webmaster", "web"})


def label_role(label: str) -> str | None:
    """The role a link's text names ("Club Publicist", "Actors' Rep", "Webmaster")."""
    words = re.findall(r"[a-z]+", label.lower())
    role = _role_of_words(words)
    if role is None and any(word in _LABEL_POSTS for word in words):
        return "other"
    return role


_UNIVERSITY_PREFIXES = (("cambridge", "university"), ("university", "of", "cambridge"), ("cu",))


def name_tokens(*names: str | None) -> set[str]:
    """Distinctive lower-case tokens of an organisation's names, for
    recognising its own addresses (``cuadc@…``): words of at least four
    letters, a short name as written ("jcsu"), and the initials of the name
    with and without its "Cambridge University" ("cubwts", "msc")."""
    tokens: set[str] = set()
    for name in names:
        if not name:
            continue
        try:
            slug = slugify(name)
        except ValueError:
            continue
        words = slug.split("-")
        for token in words:
            if len(token) >= 4 and token not in _STOP_TOKENS:
                tokens.add(token)
        compact = slug.replace("-", "")
        if 3 <= len(compact) <= 8:
            tokens.add(compact)  # acronyms: "cuadc", "jcsu"
        if len(words) >= 3:
            bare = list(words)
            for prefix in _UNIVERSITY_PREFIXES:
                if tuple(bare[: len(prefix)]) == prefix:
                    bare = bare[len(prefix) :]
                    break
            for run in (words, bare):
                initials = "".join(word[0] for word in run if word not in ("the", "of"))
                if 3 <= len(initials) <= 8:
                    tokens.add(initials)
    return tokens


def registrable(host: str) -> str:
    """The part of a host an organisation registers: ``jesus.cam.ac.uk`` for
    ``mcr.jesus.cam.ac.uk``, ``cuadc.org`` for ``www.cuadc.org``."""
    labels = host.lower().removeprefix("www.").split(".")
    if host.endswith(".cam.ac.uk"):
        return ".".join(labels[-4:])
    if len(labels) >= 3 and labels[-2] in ("ac", "co", "org", "gov", "net") and labels[-1] == "uk":
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


def site_label(host: str | None) -> str | None:
    """The name a site goes by: ``cucss`` for cucss.uk, ``cuhags`` for
    cuhags.soc.srcf.net; None for a college's or department's site."""
    if not host:
        return None
    host = host.lower().removeprefix("www.")
    if host.endswith((".soc.srcf.net", ".soc.ucam.org")):
        return host.split(".")[0]
    if host == "cam.ac.uk" or host.endswith(".cam.ac.uk"):
        return None
    return registrable(host).split(".")[0]


def _owns_domain(domain: str, site_host: str | None) -> bool:
    if site_host is None:
        return True
    if any(domain == shared or domain.endswith("." + shared) for shared in _SHARED_MAIL_HOSTS):
        return True
    if site_host.endswith(".cam.ac.uk"):
        # A JCR's site under its college's domain (jcr.cai.cam.ac.uk) does not
        # own the college's addresses (conference.office@cai.cam.ac.uk).
        site = site_host.removeprefix("www.")
        return domain == site or domain.endswith("." + site)
    if registrable(domain) == registrable(site_host):
        return True
    # The same name on another domain: cambridgenightline.org on the
    # cambridgenightline.org.uk site, cuhags.cam on cuhags.soc.srcf.net.
    label = site_label(site_host)
    return label is not None and len(label) >= 4 and site_label(domain) == label


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
    generic = local in GENERIC_LOCALS or any(t in GENERIC_LOCALS for t in _local_tokens(local))
    return generic and _owns_domain(domain, site_host)


#: Words a mailbox's name is made of that are no one's name.
_MAILBOX_WORDS = frozenset(
    """
    docs doc list lists owner owners logistics word words building office team news mail
    mailing booking bookings tickets ticket membership members member sec soc socs hub
    group web site page live official general enquiry enquiries query queries help desk
    """.split()  # noqa: SIM905 (a word list reads better as text)
)


def names_a_person(local: str, own_tokens: set[str] | frozenset[str] = frozenset()) -> bool:
    """A local part shaped like a person's name (``jane.smith``,
    ``jane_smith``): exactly two plain words, neither a role, a generic or
    mailbox word, a place, a "CU…" acronym or a word of the organisation's
    own name (``cambridge.lacrosse``, ``logistics.cumas`` are not)."""
    parts = _local_tokens(local.lower())
    if len(parts) != 2 or not _NAME_SHAPED.match(local.lower()):
        return False
    common = (
        GENERIC_LOCALS
        | _STOP_TOKENS
        | _PLACE_WORDS
        | OTHER_ROLE_WORDS
        | _MAILBOX_WORDS
        | set(ROLE_WORDS)
    )
    for part in parts:
        if part in common or part in own_tokens or len(part) < 2 or part.startswith("cu"):
            return False
        if any(token in part for token in own_tokens if len(token) >= 4):
            return False
    return True


@dataclass(frozen=True)
class EmailReading:
    """What one address on a page is. ``kind``: ``role`` (→ roleEmails, with
    ``role``), ``general`` (→ email), ``personal`` (a CRSid: never stored) or
    ``unknown`` (whose it is cannot be told: never stored)."""

    address: str
    kind: str
    role: str | None = None
    reason: str = ""

    @property
    def kept(self) -> bool:
        return self.kind in ("role", "general")


def classify_email(
    address: str,
    own_tokens: set[str] | frozenset[str] = frozenset(),
    *,
    labelled: bool = False,
    label: str | None = None,
    site_host: str | None = None,
) -> EmailReading:
    """Sorts one address published on a page (module docstring).

    ``own_tokens``: `name_tokens` of the organisation (an address carrying
    them is its own). ``labelled``: the page presents it as the
    organisation's contact ("contact: …"), so a webmail address that carries
    no name is still the organisation's. ``label``: the text of the link the
    address sits in, which may name the post. ``site_host``: the host of the
    page it was read on (an ``info@`` of another domain is not the page's).

    An address made of the organisation's short name and a word
    (``gsb.punt@``, ``wcsa-women@``) is an officer's post: ``other``."""
    address = normalise_email(address)
    local, domain = _split(address)
    if not local or not domain:
        return EmailReading(address, "unknown", reason="not an address")
    if is_crsid_address(local, domain):
        return EmailReading(address, "personal", reason="personal CRSid")
    if has_bad_tld(address):
        return EmailReading(address, "unknown", reason="a typo in the domain")
    if is_obfuscated_address(address):
        return EmailReading(address, "unknown", reason="obfuscated against spam, not decoded")
    role = role_of(address) or (label_role(label) if label else None)
    if role is not None:
        return EmailReading(address, "role", role)
    if email_type(address) == "personal_crsid":
        return EmailReading(address, "personal", reason="a person's alumni address")
    tokens = _local_tokens(local)
    if (
        len(tokens) > 1
        and (tokens[0] in own_tokens or tokens[0] in _BODY_PREFIXES)
        and not any(t in GENERIC_LOCALS for t in tokens[1:])
        # The name in pieces ("foundation.medtech", "ospreys.cam") is no post.
        and not all(t in own_tokens or t in _PLACE_WORDS for t in tokens[1:])
    ):
        return EmailReading(address, "role", "other")
    if is_generic(address, own_tokens, site_host):
        return EmailReading(address, "general")
    if names_a_person(local, own_tokens):
        # Even where a page presents it as the contact: "farouk.hadeed@…"
        # is a person's address, never a society's (AGENTS.md).
        return EmailReading(address, "unknown", reason="looks like a person's name")
    if labelled:
        return EmailReading(address, "general")
    # Named after the site it is published on: cucss@cucss.uk,
    # cucaadmin@gmail.com on cuca.org.uk.
    label = site_label(site_host)
    compact = re.sub(r"[._+\-]", "", local)
    if (
        label is not None
        and len(label) >= 4
        and len(compact) >= 4
        and (label in compact or compact in label)
    ):
        return EmailReading(address, "general", reason="named after its site")
    if (
        domain in _SOCIETY_MAIL_DOMAINS
        and not _NAME_LIKE.match(local)
        and not any(t in GENERIC_LOCALS for t in tokens)
    ):
        return EmailReading(address, "general", reason=f"{domain} society address")
    if _NAME_LIKE.match(local):
        return EmailReading(address, "unknown", reason="looks like a person's name")
    return EmailReading(address, "unknown", reason="cannot tell whose address it is")


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


#: Words a page puts into an address so that it does not work as written
#: ("round.xyz@…" — "remove '.xyz' to get the correct address"; "x.nospam@…").
_ANTISPAM_TOKENS = frozenset(
    {"xyz", "nospam", "no-spam", "antispam", "removethis", "remove-this", "dontspam", "spamfree"}
)


def is_obfuscated_address(address: str) -> bool:
    """An address deliberately broken against harvesters (`_ANTISPAM_TOKENS`
    in its local part or as a label of its domain): never stored, never
    repaired (AGENTS.md: obfuscated addresses are not decoded)."""
    local, _, domain = address.strip().lower().rpartition("@")
    # Not the top-level domain itself: ``society.xyz`` is a real domain.
    parts = set(re.split(r"[._+]+", local)) | set(domain.split(".")[:-1])
    if parts & _ANTISPAM_TOKENS:
        return True
    return any(token in local for token in ("nospam", "removethis", "antispam"))


def has_obfuscated_emails(html: str) -> bool:
    """The page hides addresses from automated readers (Cloudflare email
    protection, ``name[at]domain``). Reported, never decoded."""
    return bool(_CLOUDFLARE.search(html) or _AT_OBFUSCATION.search(html))


__all__ = [
    "CRSID_PATTERN",
    "EMAIL_PATTERN",
    "GENERIC_LOCALS",
    "INVITE_WITHHELD",
    "OTHER_ROLE_WORDS",
    "ROLE_WORDS",
    "WITHHELD",
    "ChatPlatform",
    "Contacts",
    "EmailReading",
    "EmailType",
    "SocialPlatform",
    "absolute_url",
    "account_of",
    "bare_urls",
    "chat_platform",
    "classify_email",
    "clean_url",
    "dedupe_socials",
    "email_domain",
    "email_type",
    "find_emails",
    "has_bad_tld",
    "has_obfuscated_emails",
    "host_of",
    "instagram_from_handle",
    "instagram_handle",
    "instagram_handle_of",
    "is_crsid_address",
    "is_email",
    "is_generic",
    "is_obfuscated_address",
    "is_personal_crsid",
    "is_personal_profile",
    "is_social_host",
    "label_role",
    "link_text_disagrees",
    "link_text_names",
    "mailing_list_link",
    "name_tokens",
    "names_a_person",
    "normalise_email",
    "read_contacts",
    "registrable",
    "role_of",
    "site_label",
    "social_key",
    "social_link",
    "unwrap_redirect",
    "with_scheme",
    "withhold_chat_invites",
    "withhold_personal_emails",
    "withhold_private",
]
