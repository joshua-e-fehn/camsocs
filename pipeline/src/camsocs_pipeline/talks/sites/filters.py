"""Which department-site items are talks, and of what kind. Deterministic
keyword rules over the item's title and the categories its source gives
(never the description: a description mentions everything). Whole words,
case-insensitive.

**Kept** (`is_talk`): an item whose title names a talk (`TALK_WORDS`: talk,
lecture, seminar, colloquium, symposium, conference, workshop, panel,
debate, discussion, "in conversation", book launch or book talk, keynote,
masterclass, forum, roundtable, webinar, journal club, "work in progress",
oration, sermon).

**Dropped**: an item whose title or category names something else
(`NOT_TALK_WORDS`) and does not also name a talk: exhibitions, open days and
admissions or applicant events, family, children's and craft events, short
courses and summer schools, concerts, recitals, screenings, tours, worship,
socials (drinks, dinners, brunch, quizzes, board games), careers fairs,
retreats, wellbeing sessions (yoga, sound baths), events for schools.
"Exhibition talk" or "Curator's lecture" is kept: the talk word wins.

**Neither**: an item that names no kind at all ("Bat and rodent virus
discovery in natural history museum collections") is kept from a
department's own listing, where nearly everything is a seminar, and dropped
from a mixed listing (a museum's, a garden's, a college's;
`common.requires_talk_keyword`).

**Kind** (`talk_kind`), first match wins: conference (conference,
symposium, summit, congress), workshop (workshop, masterclass, hackathon,
tutorial, training), lecture (lecture, keynote, oration, sermon), seminar
(seminar, colloquium, talk, journal club, discussion group, lunch, webinar,
reading group), otherwise ``other``.

**Elsewhere** (`is_elsewhere`): an item whose venue names another city or
country (London, Antalya, Johannesburg …) and not Cambridge or online is
not a Cambridge talk and is dropped. "Cambridge" is the active campus's
location (`NameRules.location_pattern`, decision D8): the word or a CB
postcode for Cambridge.

**Cancelled** (`is_cancelled`): a title starting or bracketing
"Cancelled"/"Postponed", or a status the source states. **Online**
(`is_online`): a venue naming Zoom, Teams, "online", "virtual" or a webinar,
or an attendance mode the source states.
"""

from __future__ import annotations

import functools
import re
from collections.abc import Iterable

TALK_WORDS = (
    r"talks?|lectures?|seminars?|colloqui(?:um|a)|symposi(?:um|a)|conferences?|workshops?|"
    r"panels?|panel discussion|debates?|discussions?|in conversation|conversations? with|"
    r"book (?:launch|talk)|keynotes?|masterclass(?:es)?|forum|roundtable|round table|"
    r"webinars?|journal club|work[- ]in[- ]progress|q\s*&\s*a|oration|sermons?"
)
#: Only words that rarely sit in a research talk's title: "social", "party",
#: "services", "performance" or "reception" (Classics' reception studies) are
#: not here, so a department seminar about them is not lost.
NOT_TALK_WORDS = (
    r"exhibitions?|open days?|open mornings?|admissions?|applicants?|offer holders?|"
    r"taster days?|family (?:fun|days?|events?|activit(?:y|ies)|friendly|trail)|for families|"
    r"kids|for children|children'?s activit(?:y|ies)|toddlers?|half[- ]term|crafts?|"
    r"storytime|story time|short courses?|summer schools?|concerts?|recitals?|choirs?|gigs?|"
    r"screenings?|film nights?|guided tours?|tours?|guided walks?|evensong|eucharist|"
    r"worship|adoration|retreats?|yoga|pilates|sound baths?|meditation|mindfulness|socials|"
    r"drinks|dinners?|brunch|breakfast|quiz(?:zes)?|ceilidh|bop|careers fairs?|fayre|"
    r"light trail|bake sale|board games?|writing group|coffee morning|for schools|school pupils"
)

_TALK = re.compile(rf"\b(?:{TALK_WORDS})\b", re.IGNORECASE)
_NOT_TALK = re.compile(rf"\b(?:{NOT_TALK_WORDS})\b", re.IGNORECASE)

_KINDS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("conference", re.compile(r"\b(?:conferences?|symposi(?:um|a)|summit|congress)\b", re.I)),
    (
        "workshop",
        re.compile(r"\b(?:workshops?|masterclass(?:es)?|hackathon|tutorials?|training)\b", re.I),
    ),
    ("lecture", re.compile(r"\b(?:lectures?|keynotes?|oration|sermons?)\b", re.I)),
    (
        "seminar",
        re.compile(
            r"\b(?:seminars?|colloqui(?:um|a)|talks?|journal club|discussion group|lunch|"
            r"webinars?|reading group)\b",
            re.I,
        ),
    ),
)

_CANCELLED = re.compile(
    r"^\W*(?:cancell?ed|postponed)\b|[(\[]\s*(?:cancell?ed|postponed)\s*[)\]]"
    r"|\bthis (?:talk|seminar|lecture|event) (?:has been|is) (?:cancell?ed|postponed)\b",
    re.IGNORECASE,
)
_ONLINE = re.compile(r"\b(?:online|zoom|ms teams|microsoft teams|teams|virtual|webinar)\b", re.I)


def is_talk(title: str, categories: Iterable[str] = (), *, require_keyword: bool = False) -> bool:
    """Whether an item is a talk (module docstring)."""
    labels = " | ".join(c for c in categories if c)
    if _TALK.search(title) or _TALK.search(labels):
        return True
    if _NOT_TALK.search(title) or _NOT_TALK.search(labels):
        return False
    return not require_keyword


def talk_kind(title: str, categories: Iterable[str] = ()) -> str:
    text = f"{title} | {' | '.join(c for c in categories if c)}"
    for kind, pattern in _KINDS:
        if pattern.search(text):
            return kind
    return "other"


#: Places a venue may name that are not Cambridge (a COP side event, an
#: alumni dinner abroad, a London launch).
_ELSEWHERE = re.compile(
    r"\b(?:london|oxford|edinburgh|manchester|birmingham|bristol|brussels|paris|berlin|"
    r"geneva|rome|madrid|new york|washington|boston|san francisco|toronto|singapore|"
    r"hong kong|beijing|shanghai|tokyo|delhi|mumbai|dubai|johannesburg|nairobi|sydney|"
    r"melbourne|antalya|t[uü]rkiye|turkey|usa|united states|south africa|india|china|"
    r"japan|germany|france|italy|spain|canada|australia)\b",
    re.IGNORECASE,
)
#: ...and venues that are online, or Cambridge venues whose names hold one of
#: those places. The campus's own location comes first (`here_regex`).
_HERE_TAIL = (
    r"|\bonline\b|\bzoom\b|\bvirtual\b"
    r"|\bancient india\b|\bedinburgh building\b|\bbrooklands avenue\b"
)
#: Cambridge's venue rule: `here_regex` of its location pattern is this
#: regex byte for byte (tests/test_cam_patterns_frozen.py).
_HERE = re.compile(
    r"\bcambridge\b|\bCB\d{1,2}\b|\bonline\b|\bzoom\b|\bvirtual\b"
    r"|\bancient india\b|\bedinburgh building\b|\bbrooklands avenue\b",
    re.I,
)


@functools.cache
def here_regex(location_pattern: str) -> re.Pattern[str]:
    """Venues that are here: the campus's location, online, or a Cambridge
    venue named after somewhere else; compiled once per campus."""
    return re.compile(location_pattern + _HERE_TAIL, re.I)


def is_elsewhere(venue: str | None) -> bool:
    """Whether a venue names a place other than the active campus's town
    (Cambridge) and not online. "St John's College" or "Hoyle Lecture
    Theatre" name no place: kept."""
    if not venue or not _ELSEWHERE.search(venue):
        return False
    from camsocs_pipeline.campuses import active

    return not here_regex(active().names.location_pattern).search(venue)


def is_cancelled(title: str, text: str | None = None) -> bool:
    return bool(_CANCELLED.search(title) or (text and _CANCELLED.search(text[:300])))


def is_online(*texts: str | None) -> bool:
    return any(t and _ONLINE.search(t) for t in texts)
