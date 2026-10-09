"""Deterministic reading of a society site's links (§11, §13–15) — what is
special to a website. What a link or address *is* (socials, emails, the CRSid
rule) is decided once, in `sources.links` (`social_link`, `classify_email`).

- **Feeds** (`feed_of`): ICS / webcal, Google Calendar ids, Luma calendars,
  talks.cam list ids (stored as ids only: talks.cam content is never fetched
  here, §6), Camdram society slugs, ticketing organiser pages (Fixr, Ticket
  Tailor, Eventbrite, Dice, TicketSource, Youni, Skiddle — links only, §15).
- **Mailing lists** (`mailing_list_of`): Sympa (``lists.cam.ac.uk``), Mailchimp,
  Google Groups sign-up pages.
- **Join and termcard links** by what the anchor says.
- `NOT_SOCIETY_HANDLES`: accounts a society site links that are not the
  society's (the University, the SU, the site builder).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import parse_qs, unquote, urlsplit


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


__all__ = [
    "NOT_SOCIETY_HANDLES",
    "TICKETING_HOSTS",
    "Feed",
    "feed_of",
    "is_join_link",
    "is_termcard_link",
    "mailing_list_of",
]
