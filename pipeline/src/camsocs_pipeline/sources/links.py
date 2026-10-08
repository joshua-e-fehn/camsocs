"""What a published link or address *is*: the shared, offline rules harvesters
use to turn hrefs and email addresses into socials, websites, chat channels,
mailing lists and email kinds.

Nothing here fetches anything. A link is classified by its shape alone, which
is also why Instagram, Facebook and LinkedIn links are safe to handle here:
they are stored, never visited (source-research "Global rules").

- `absolute_url` is the one way an href becomes a URL we may store: http(s)
  only, a dotted host, no user-info (``http://name@host`` is a mistyped email
  address, not a link).
- `social_link` / `chat_platform` / `mailing_list_link` recognise the
  platforms in `models.vocab` (SOCIAL_PLATFORMS, CHAT_PLATFORMS,
  MAILING_LIST_PLATFORMS). A chat link is reported as a platform only: invite
  URLs are never stored.
- `classify_email` mirrors `classifyEmail` in webapp/convex/lib/derived.ts
  (the server derives `emailType` with it); both are asserted against
  webapp/lib/email-types.fixtures.json. Harvesters use it to keep personal
  CRSid addresses out of every claim.
"""

from __future__ import annotations

import re
from typing import Literal
from urllib.parse import parse_qs, unquote, urljoin, urlsplit, urlunsplit

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
    """The URL's host, lowercased, without ``www.``."""
    host = (urlsplit(url).hostname or "").lower()
    return host.removeprefix("www.")


def _host_is(host: str, *domains: str) -> bool:
    return any(host == domain or host.endswith("." + domain) for domain in domains)


def _path_segments(url: str) -> list[str]:
    return [unquote(segment) for segment in urlsplit(url).path.split("/") if segment]


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

_INSTAGRAM_HANDLE = re.compile(r"^[A-Za-z0-9._]{1,30}$")
_X_HANDLE = re.compile(r"^[A-Za-z0-9_]{1,15}$")
_LINKTREE_HANDLE = re.compile(r"^[A-Za-z0-9._-]{1,60}$")
#: First path segments that are Instagram / X pages, not accounts.
_INSTAGRAM_RESERVED = frozenset(
    {"p", "reel", "reels", "explore", "stories", "tv", "accounts", "direct", "about", "legal"}
)
#: First path segments of Facebook pages that are not a page or group address.
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
        "events",
        "watch",
        "photo.php",
        "permalink.php",
        "story.php",
        "search",
        "hashtag",
    }
)
_X_RESERVED = frozenset(
    {"i", "intent", "share", "home", "search", "hashtag", "explore", "settings"}
)


def instagram_handle(url: str) -> str | None:
    """The account an Instagram profile URL names, or None for a post, a reel
    or anything that is not a profile."""
    if not _host_is(host_of(url), "instagram.com", "instagr.am"):
        return None
    segments = _path_segments(url)
    if not segments or segments[0].lower() in _INSTAGRAM_RESERVED:
        return None
    handle = segments[0].lstrip("@")
    return handle if _INSTAGRAM_HANDLE.match(handle) else None


def social_link(url: str) -> dict[str, str] | None:
    """A `socials` item (``{platform, url, handle?}``) for a social-platform
    URL, or None when the URL is not one (a post, a share link, a bare host).
    The URL is kept as published, less its query and fragment (share and
    tracking parameters), except where the query is the address
    (``facebook.com/profile.php?id=…``, WeChat articles)."""
    host = host_of(url)
    segments = _path_segments(url)
    first = segments[0] if segments else ""
    clean = _without_query(url)

    if _host_is(host, "instagram.com", "instagr.am"):
        handle = instagram_handle(url)
        if handle is None:
            return None
        return {"platform": "instagram", "url": clean, "handle": handle}
    if _host_is(host, "facebook.com", "fb.com", "fb.me"):
        if not segments or first.lower() in _FACEBOOK_RESERVED:
            return None
        if first.lower() == "profile.php":
            profile_id = parse_qs(urlsplit(url).query).get("id")
            if not profile_id:
                return None
            clean = f"{clean}?id={profile_id[0]}"
        platform = "facebook_group" if first.lower() == "groups" else "facebook_page"
        return {"platform": platform, "url": clean}
    if _host_is(host, "twitter.com", "x.com"):
        handle = first.lstrip("@")
        if not handle or handle.lower() in _X_RESERVED or not _X_HANDLE.match(handle):
            return None
        return {"platform": "x", "url": clean, "handle": handle}
    if _host_is(host, "linkedin.com"):
        if not segments:
            return None
        return {"platform": "linkedin", "url": clean}
    if _host_is(host, "tiktok.com"):
        if not first.startswith("@") or len(first) < 2:
            return None
        return {"platform": "tiktok", "url": clean, "handle": first[1:]}
    if _host_is(host, "youtube.com"):
        # Channels only (`/@name`, `/c/…`, `/channel/…`, `/user/…`), not single videos.
        if first.startswith("@") and len(first) > 1:
            return {"platform": "youtube", "url": clean, "handle": first[1:]}
        if first in ("c", "channel", "user") and len(segments) > 1:
            return {"platform": "youtube", "url": clean}
        return None
    if host in ("linktr.ee", "linktree.com"):
        if not first or not _LINKTREE_HANDLE.match(first):
            return None
        return {"platform": "linktree", "url": clean, "handle": first}
    if _host_is(host, "threads.net", "threads.com"):
        if not first.startswith("@") or len(first) < 2:
            return None
        return {"platform": "threads", "url": clean, "handle": first[1:]}
    if host == "bsky.app":
        if first != "profile" or len(segments) < 2:
            return None
        return {"platform": "bluesky", "url": clean, "handle": segments[1]}
    if _host_is(host, "weixin.qq.com"):
        return {"platform": "wechat", "url": url}
    return None


#: Hosts whose links are socials (or nothing) — never a society's website.
_SOCIAL_HOSTS = (
    "instagram.com",
    "instagr.am",
    "facebook.com",
    "fb.com",
    "fb.me",
    "twitter.com",
    "x.com",
    "linkedin.com",
    "tiktok.com",
    "youtube.com",
    "linktr.ee",
    "linktree.com",
    "threads.net",
    "threads.com",
    "bsky.app",
    "weixin.qq.com",
)


def is_social_host(url: str) -> bool:
    """Whether `url` is on a social platform, even when it names no account
    (`social_link` then returns None): such a link is never a website."""
    return _host_is(host_of(url), *_SOCIAL_HOSTS)


def _without_query(url: str) -> str:
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


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


# --- emails -------------------------------------------------------------------------------------

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

#: A Cambridge CRSid: 2–5 letters then digits (e.g. ``jf123``).
_CRSID_LOCAL = re.compile(r"^[a-z]{2,5}[0-9]{1,5}$")

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


def is_email(value: str) -> bool:
    """Plausible syntax only — never a reason to guess an address."""
    return bool(_EMAIL.match(value)) and len(value) <= 254


def email_domain(email: str) -> str:
    return email.strip().lower().rpartition("@")[2]


def classify_email(email: str) -> EmailType:
    """What kind of address `email` is — `classifyEmail` in
    webapp/convex/lib/derived.ts, rule for rule."""
    address = email.strip().lower()
    at = address.rfind("@")
    local = address[:at]
    domain = address[at + 1 :]
    if is_crsid_address(local, domain):
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


#: A CRSid-shaped address anywhere in free text (for withholding it).
_ADDRESS_IN_TEXT = re.compile(
    r"(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?![A-Za-z0-9-])"
)
WITHHELD = "[personal email withheld]"


def withhold_personal_emails(text: str) -> str:
    """`text` with every personal CRSid address replaced by a marker. Free text
    (descriptions) is public; a CRSid names a person and never is. Uses
    `classify_email`, so it hides exactly what the server would."""
    return _ADDRESS_IN_TEXT.sub(
        lambda match: (
            WITHHELD
            if classify_email(match.group(0).rstrip(".")) == "personal_crsid"
            else match.group(0)
        ),
        text,
    )


def withhold_private(text: str) -> str:
    """Free text made safe to publish: personal CRSid addresses and chat invite
    links withheld (`withhold_personal_emails`, `withhold_chat_invites`)."""
    return withhold_chat_invites(withhold_personal_emails(text))


__all__ = [
    "INVITE_WITHHELD",
    "WITHHELD",
    "ChatPlatform",
    "EmailType",
    "SocialPlatform",
    "absolute_url",
    "chat_platform",
    "classify_email",
    "email_domain",
    "host_of",
    "instagram_handle",
    "is_email",
    "is_social_host",
    "mailing_list_link",
    "social_link",
    "unwrap_redirect",
    "withhold_chat_invites",
    "withhold_personal_emails",
    "withhold_private",
]
