"""Deterministic reading of a society site's links and addresses (§11, §13–15).

- **Socials** (`social_of`): Instagram, Facebook page / group, X, LinkedIn
  company/school pages (never ``/in/`` — that is a person), TikTok, YouTube,
  Linktree, Threads, Bluesky, WeChat. Share buttons and the platforms' own
  pages are not socials.
- **Feeds** (`feed_of`): ICS / webcal, Google Calendar ids, Luma calendars,
  talks.cam list ids (stored as ids only: talks.cam content is never fetched
  here, §6), Camdram society slugs, ticketing organiser pages (Fixr, Ticket
  Tailor, Eventbrite, Dice, TicketSource, Youni, Skiddle — links only, §15).
- **Mailing lists** (`mailing_list_of`): Sympa (``lists.cam.ac.uk``), Mailchimp,
  Google Groups sign-up pages.
- **Join and termcard links** by what the anchor says.
- **Emails** (`classify_email`): a role address (``president@``,
  ``sponsorship@``) or the organisation's general one (``info@``, an SU or
  SRCF address, an own-domain or webmail address named after the group) —
  never a person's: a CRSid (``ab123@cam.ac.uk``), ``jane.smith@…`` or any
  other address that names someone is dropped (AGENTS.md "personal CRSids
  and named people never appear in public fields").
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import parse_qs, unquote, urlsplit

from camsocs_pipeline.resolve.names import SHARED_EMAIL_DOMAINS, tokens

# --- socials ---------------------------------------------------------------------------------

_SHARE_PATHS = re.compile(
    r"/(sharer|share|intent|dialog|plugins|login|signup|hashtag|explore|p|reel|reels|"
    r"stories|watch|embed|status|home|privacy|policies|legal|help|about|search)(/|\.php|$)",
    re.I,
)


@dataclass(frozen=True)
class Social:
    platform: str
    url: str
    handle: str | None = None

    def value(self) -> dict[str, str]:
        out = {"platform": self.platform, "url": self.url}
        if self.handle:
            out["handle"] = self.handle
        return out


def _host(url: str) -> str:
    host = urlsplit(url).netloc.lower().split(":")[0]
    return host[4:] if host.startswith("www.") else host


def _segments(url: str) -> list[str]:
    return [unquote(part) for part in urlsplit(url).path.split("/") if part]


def _clean(url: str) -> str:
    """Scheme + host + path, without query or fragment or trailing slash."""
    parts = urlsplit(url)
    path = parts.path.rstrip("/")
    return f"https://{parts.netloc.lower()}{path}"


def social_of(url: str) -> Social | None:
    """The social profile a link points to, or None."""
    host = _host(url)
    segments = _segments(url)
    if not segments or _SHARE_PATHS.search(urlsplit(url).path):
        return None
    first = segments[0]
    if host in ("instagram.com", "instagr.am"):
        handle = first.lstrip("@").lower()
        if re.fullmatch(r"[a-z0-9._]{1,30}", handle):
            return Social("instagram", f"https://www.instagram.com/{handle}/", handle)
        return None
    if host in ("facebook.com", "m.facebook.com", "fb.com", "fb.me"):
        if first == "groups" and len(segments) > 1:
            return Social("facebook_group", _clean(url))
        if first in ("events", "photo.php", "photos", "watch", "profile.php", "people"):
            return None
        return Social("facebook_page", _clean(url), first)
    if host in ("x.com", "twitter.com"):
        handle = first.lstrip("@")
        if re.fullmatch(r"[A-Za-z0-9_]{1,15}", handle):
            return Social("x", f"https://x.com/{handle}", handle)
        return None
    if host.endswith("linkedin.com"):
        if first in ("company", "school", "showcase", "groups") and len(segments) > 1:
            return Social("linkedin", _clean(url), segments[1])
        return None  # /in/<person> is a person, never stored
    if host == "tiktok.com" and first.startswith("@"):
        return Social("tiktok", _clean(url), first[1:])
    if host in ("youtube.com", "m.youtube.com"):
        if first.startswith("@"):
            return Social("youtube", _clean(url), first[1:])
        if first in ("c", "channel", "user") and len(segments) > 1:
            return Social("youtube", _clean(url), segments[1])
        return None
    if host == "linktr.ee":
        return Social("linktree", f"https://linktr.ee/{first}", first)
    if host == "threads.net" and first.startswith("@"):
        return Social("threads", _clean(url), first[1:])
    if host == "bsky.app" and first == "profile" and len(segments) > 1:
        return Social("bluesky", _clean(url), segments[1])
    return None


#: Handles that belong to the University, the SU or a platform, not a society.
NOT_SOCIETY_HANDLES = frozenset(
    {
        "cambridgesu",
        "cambridge_su",
        "cambridgeuniversity",
        "cambridge_uni",
        "cambridgeuni",
        "uniofcam",
        "universityofcambridge",
        "university-of-cambridge",
        "camunivsport",
        "sportcambridge",
        "cambridgesport",
        "wix",
        "squarespace",
        "wordpress",
        "wordpressdotcom",
        "linktree",
        "linktree_",
    }
)


# --- feeds and ticketing ---------------------------------------------------------------------

TICKETING_HOSTS = (
    "fixr.co",
    "tickettailor.com",
    "buytickets.at",
    "eventbrite.co.uk",
    "eventbrite.com",
    "dice.fm",
    "link.dice.fm",
    "ticketsource.co.uk",
    "youni.co.uk",
    "skiddle.com",
    "ents24.com",
)


@dataclass(frozen=True)
class Feed:
    """An orgInternal identifier: ``kind`` is the `OrgInternalPatch` field."""

    kind: str
    value: str


def feed_of(url: str) -> Feed | None:
    parts = urlsplit(url)
    host = _host(url)
    path = parts.path
    lowered = url.lower()
    if lowered.startswith("webcal://") or path.lower().endswith(".ics"):
        return Feed("ics_urls", "https://" + url.split("://", 1)[1])
    if host == "calendar.google.com":
        query = parse_qs(parts.query)
        source = query.get("src") or query.get("cid")
        if source:
            return Feed("google_calendar_ids", source[0])
        match = re.search(r"/calendar/ical/([^/]+)/", path)
        if match:
            return Feed("google_calendar_ids", unquote(match.group(1)))
        return None
    if host in ("lu.ma", "luma.com"):
        segments = _segments(url)
        if host == "api.lu.ma" or (segments and segments[0] == "ics"):
            calendar = parse_qs(parts.query).get("id")
            return Feed("luma_calendar_ids", calendar[0]) if calendar else None
        if len(segments) == 1 and not re.fullmatch(r"[a-z0-9]{8}", segments[0]):
            # lu.ma/<calendar-slug>; an 8-character id is a single event.
            return Feed("luma_calendar_ids", segments[0])
        return None
    if host == "api.lu.ma":
        calendar = parse_qs(parts.query).get("id")
        return Feed("luma_calendar_ids", calendar[0]) if calendar else None
    if host == "talks.cam.ac.uk":
        match = re.search(r"/(?:show/\w+|list)/(\d+)", path) or re.search(
            r"[?&]id=(\d+)", "?" + parts.query
        )
        return Feed("talks_list_ids", match.group(1)) if match else None
    if host == "camdram.net":
        segments = _segments(url)
        if len(segments) >= 2 and segments[0] == "societies":
            return Feed("camdram_slug", segments[1])
        return None
    if any(host == h or host.endswith("." + h) for h in TICKETING_HOSTS):
        return Feed("ticketing_urls", _clean(url))
    return None


def mailing_list_of(url: str) -> tuple[dict[str, str], str | None] | None:
    """``({platform, signupUrl}, sympa list name or None)`` for a sign-up link."""
    host = _host(url)
    segments = _segments(url)
    if host == "lists.cam.ac.uk" and "sympa" in segments:
        index = segments.index("sympa")
        if len(segments) > index + 2 and segments[index + 1] in ("subscribe", "info", "subrequest"):
            name = segments[index + 2]
            return {"platform": "sympa", "signupUrl": _clean(url)}, name
        return None
    if host.endswith("list-manage.com") and "subscribe" in urlsplit(url).path:
        return {"platform": "mailchimp", "signupUrl": url.split("#", 1)[0]}, None
    if host in ("eepurl.com", "mailchi.mp"):
        return {"platform": "mailchimp", "signupUrl": _clean(url)}, None
    if host == "groups.google.com" and segments[:1] == ["g"] and len(segments) > 1:
        return {"platform": "google_group", "signupUrl": _clean(url)}, None
    return None


_JOIN_TEXT = re.compile(
    r"\b(join( us| now| the club| the society)?|become a member|membership|sign ?up|register)\b",
    re.I,
)
_FORM_HOSTS = ("docs.google.com", "forms.gle", "forms.office.com", "jotform.com", "typeform.com")


def is_join_link(url: str, text: str) -> bool:
    """A link whose anchor says "join" / "membership" and that leads to a form
    or the SU's membership shop."""
    if not _JOIN_TEXT.search(text):
        return False
    host = _host(url)
    path = urlsplit(url).path.lower()
    if any(host == h or host.endswith("." + h) for h in _FORM_HOSTS):
        return "form" in path or host in ("forms.gle",)
    return host == "cambridgesu.co.uk" and ("/shop/" in path or "join" in path)


def is_termcard_link(url: str, text: str) -> bool:
    return bool(re.search(r"term ?card", f"{text} {url}", re.I))


# --- emails -------------------------------------------------------------------------------------

#: Local-part words → role (ROLES vocabulary).
ROLE_WORDS: dict[str, str] = {
    "president": "president",
    "pres": "president",
    "presidents": "president",
    "chair": "president",
    "chairs": "president",
    "secretary": "secretary",
    "sec": "secretary",
    "treasurer": "treasurer",
    "treas": "treasurer",
    "finance": "treasurer",
    "bursar": "treasurer",
    "sponsorship": "sponsorship",
    "sponsorships": "sponsorship",
    "sponsors": "sponsorship",
    "sponsor": "sponsorship",
    "corporate": "sponsorship",
    "partnerships": "sponsorship",
    "partners": "sponsorship",
    "events": "events",
    "event": "events",
    "socials": "events",
    "social": "events",
    "ents": "events",
    "publicity": "publicity",
    "marketing": "publicity",
    "media": "publicity",
    "comms": "publicity",
    "communications": "publicity",
    "press": "publicity",
    "welfare": "welfare",
    "captain": "captain",
    "captains": "captain",
    "capt": "captain",
}
#: Local-part words naming a committee post outside `ROLES` → role ``other``.
OTHER_ROLE_WORDS = frozenset(
    {
        "vicepresident",
        "vicepres",
        "vp",
        "vice",
        "vicechair",
        "access",
        "outreach",
        "careers",
        "career",
        "alumni",
        "international",
        "academic",
        "academics",
        "sport",
        "sports",
        "tech",
        "technical",
        "it",
        "design",
        "editor",
        "editors",
        "editorial",
        "newsletter",
        "equality",
        "equalities",
        "diversity",
        "inclusion",
        "liaison",
        "freshers",
        "external",
        "internal",
        "officer",
        "officers",
        "rep",
        "reps",
        "coordinator",
        "director",
        "manager",
        "fundraising",
        "charity",
        "charities",
        "environment",
        "environmental",
        "ug",
        "pg",
        "lgbt",
        "lgbtq",
        "bme",
        "accommodation",
        "housing",
    }
)
#: Long words that mark a post even inside a longer local part ("caribbeanofficer").
_OTHER_ROLE_PARTS = ("officer", "coordinator", "director", "manager", "outreach", "liaison")

#: Local-part words meaning "the organisation itself".
GENERAL_WORDS = frozenset(
    {
        "info",
        "hello",
        "hi",
        "contact",
        "contactus",
        "enquiries",
        "enquiry",
        "inquiries",
        "admin",
        "office",
        "mail",
        "team",
        "committee",
        "general",
        "society",
        "soc",
        "club",
        "membership",
        "members",
        "web",
        "webmaster",
        "jcr",
        "mcr",
    }
)
_CRSID = re.compile(r"^[a-z]{2,5}[0-9]{1,5}$")
_NAME_LIKE = re.compile(r"^[a-z]+[._-][a-z]+$")


@dataclass(frozen=True)
class EmailReading:
    """How an address reads: a role address, the general one, or nothing public."""

    email: str
    #: ``role`` (with `role`), ``general``, or ``skip`` (personal / unclear).
    kind: str
    role: str | None = None
    reason: str = ""


def classify_email(email: str, *, org_words: set[str], site_host: str | None) -> EmailReading:
    """Read one address published on the organisation's own pages.

    `org_words`: folded tokens of the organisation's names and acronyms (a
    webmail address must be named after the group to count as its own);
    `site_host`: the site's host, so ``anything@<own domain>`` that is not a
    role or a name is the group's.
    """
    address = email.strip().lower()
    local, _, domain = address.partition("@")
    domain = domain[4:] if domain.startswith("www.") else domain
    if not local or not domain:
        return EmailReading(address, "skip", reason="not an address")
    if (domain == "cam.ac.uk" or domain.endswith(".cam.ac.uk")) and _CRSID.match(local):
        return EmailReading(address, "skip", reason="personal CRSid")
    words = [word for word in re.split(r"[._+-]+", local) if word]
    for word in words:
        if word in OTHER_ROLE_WORDS:
            return EmailReading(address, "role", "other")
        if word in ROLE_WORDS:
            return EmailReading(address, "role", ROLE_WORDS[word])
    for word in words:
        role = next((r for w, r in ROLE_WORDS.items() if len(w) >= 6 and w in word), None)
        if role:
            return EmailReading(address, "role", role)
        if any(part in word for part in _OTHER_ROLE_PARTS):
            return EmailReading(address, "role", "other")
    if any(word in GENERAL_WORDS for word in words):
        return EmailReading(address, "general")
    own_domain = site_host is not None and (
        domain == site_host or site_host.endswith("." + domain) or domain.endswith("." + site_host)
    )
    named_after_group = any(
        word in local for word in org_words if len(word) >= 3
    ) or local.startswith(("cu", "camb"))
    if domain in ("cambridgesu.co.uk", "srcf.net", "sport.cam.ac.uk", "lists.cam.ac.uk"):
        return EmailReading(address, "general", reason=f"{domain} society address")
    if _NAME_LIKE.match(local) and not named_after_group:
        return EmailReading(address, "skip", reason="looks like a person's name")
    if own_domain and named_after_group:
        return EmailReading(address, "general")
    if domain in SHARED_EMAIL_DOMAINS and named_after_group:
        return EmailReading(address, "general", reason="webmail named after the group")
    return EmailReading(address, "skip", reason="cannot tell whose address it is")


def org_words(*names: str) -> set[str]:
    """Distinctive folded words (and the acronym) of an organisation's names."""
    words: set[str] = set()
    ignore = {"cambridge", "university", "society", "club", "the", "of", "and", "cu", "college"}
    for name in names:
        parts = tokens(name)
        words |= {part for part in parts if part not in ignore and len(part) >= 3}
        initials = "".join(part[0] for part in parts if part not in ("the", "of", "and"))
        if len(initials) >= 3:
            words.add(initials)
    return words


__all__ = [
    "GENERAL_WORDS",
    "NOT_SOCIETY_HANDLES",
    "OTHER_ROLE_WORDS",
    "ROLE_WORDS",
    "TICKETING_HOSTS",
    "EmailReading",
    "Feed",
    "Social",
    "classify_email",
    "feed_of",
    "is_join_link",
    "is_termcard_link",
    "mailing_list_of",
    "org_words",
    "social_of",
]
