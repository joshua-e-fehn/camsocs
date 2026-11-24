"""The deterministic half of location resolution (docs/locations-and-map.md
§2 steps 1–2): normalised venue names, the known venues by name and alias,
online-only detection, the room a venue text adds, the shortlist of venues
the model is shown, and the hash of what was read.

Nothing here reaches the network or a model.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field

from camsocs_pipeline.extract.memo import memo_key
from camsocs_pipeline.keys import venue_key
from camsocs_pipeline.locate.model import LIMITS, PendingItem, VenueRow

#: Words that say nothing about which building it is.
_STOP = frozenset(
    [
        "the",
        "a",
        "an",
        "of",
        "and",
        "at",
        "in",
        "on",
        "for",
        "to",
        "with",
        "by",
        "de",
        "la",
        "le",
        "university",
        "cambridge",
        "uk",
        "england",
        "room",
        "rooms",
        "building",
        "site",
        "street",
        "road",
        "lane",
        "avenue",
        "st",
        "rd",
    ]
)
#: Words many venue names share ("Trinity College" and "King's College"
#: Chapel share "college"): left out when two names, or a name and an item's
#: text, are compared for a word in common (`distinctive`).
GENERIC = frozenset(
    [
        "college",
        "colleges",
        "hall",
        "halls",
        "centre",
        "center",
        "society",
        "club",
        "institute",
        "department",
        "dept",
        "faculty",
        "school",
        "chapel",
        "church",
        "theatre",
        "theater",
        "seminar",
        "lecture",
        "lectures",
        "museum",
        "library",
        "house",
        "court",
        "studio",
        "lab",
        "laboratory",
        "floor",
        "main",
        "new",
        "old",
        "great",
        "little",
        "north",
        "south",
        "east",
        "west",
    ]
)
#: Venue keys of a town or district a lookup found where a building was
#: asked for (`area_venue_key`): an area's anchor, never an exact place.
#: ``--`` never occurs in `keys.venue_key` (a slug has single hyphens), so
#: no named venue can take one of these keys.
AREA_KEY_PREFIX = "ven-area--"
#: A UK postcode, and a trailing ", Cambridge" / ", UK" a venue text often ends with.
_POSTCODE = re.compile(r"\bCB\d{1,2}\s*\d[A-Z]{2}\b", re.IGNORECASE)
_TAIL = re.compile(r"(?:,\s*(?:cambridge(?:shire)?|uk|united kingdom|england))+\s*$", re.IGNORECASE)

_ONLINE = re.compile(
    r"\b(?:zoom|(?:ms |microsoft )?teams|online|virtual(?:ly)?|webinar|livestream(?:ed)?|"
    r"live[- ]?stream(?:ed)?|google meet|meet\.google\.com|webex|whereby|youtube|"
    r"link (?:to be )?(?:sent|shared|provided)|via (?:zoom|teams))\b",
    re.IGNORECASE,
)
_LINK = re.compile(r"https?://\S+|\b[\w-]+\.(?:zoom\.us|teams\.microsoft\.com)\S*", re.IGNORECASE)
#: What may stay of an online-only venue text once its online words are gone.
_FILLER = re.compile(
    r"\b(?:only|event|talk|seminar|meeting|session|via|on|and|or|the|a|link|platform|"
    r"details|tbc|tba|to|be|sent|shared|provided|registration|registered|attendees|"
    r"participants|after|before|will|in|by|email|join|us|available|here)\b",
    re.IGNORECASE,
)
_HYBRID = re.compile(r"\bhybrid\b|\bin[- ]person\b|\band online\b|\bor online\b", re.IGNORECASE)

#: Words that mark a segment as a room inside a building.
_ROOMISH = re.compile(
    r"\b(?:room|rooms|hall|theatre|theater|lecture|seminar|floor|lab|laboratory|suite|studio|"
    r"library|auditorium|lounge|bar|chapel|court|annex(?:e)?|wing|level|basement|"
    r"meeting|reading|common|parlour|buttery|LT\d*|MR\d*|[A-Z]?\d+[A-Z]?)\b",
    re.IGNORECASE,
)
#: A room or venue name that reads as a person's, or carries a link or an
#: address: never stored as either.
PERSONISH = re.compile(r"@|https?://|\b(?:dr|prof|professor|mr|mrs|ms)\.?\s", re.IGNORECASE)

#: Venues the model always sees when they are known: the main University
#: sites and the areas the contract names as anchors (§1b), by normalised name.
ANCHOR_NAMES: frozenset[str] = frozenset(
    {
        "sidgwick site",
        "new museums site",
        "downing site",
        "west cambridge site",
        "mill lane lecture rooms",
        "lady mitchell hall",
        "cambridge union",
        "university centre",
        "market square",
        "parkers piece",
        "cambridge university library",
        "the guildhall",
        "cambridge biomedical campus",
        "cambridge judge business school",
        "student services centre",
        "senate house",
        "great st marys church",
        "cambridge junction",
        "adc theatre",
        "corn exchange",
    }
)

#: Most venues the model is shown for one item.
SHORTLIST_SIZE = 60
#: Venues ranked by overlap that come before the anchors.
SHORTLIST_LEAD = 30


def normalise(text: str) -> str:
    """Lower case, accents and apostrophes gone, ``&`` as "and", punctuation as
    spaces, a postcode and a trailing ", Cambridge" dropped: "St John's
    College, Cambridge" → "st johns college"."""
    out = _POSTCODE.sub(" ", text)
    out = _TAIL.sub("", out.strip())
    out = unicodedata.normalize("NFKD", out)
    out = "".join(char for char in out if not unicodedata.category(char).startswith("M"))
    out = re.sub(r"['’‘`]", "", out.replace("&", " and ")).lower()
    out = re.sub(r"[^a-z0-9]+", " ", out)
    return " ".join(out.split())


def tokens(text: str) -> set[str]:
    """The words of `text` that can tell two venues apart."""
    return {word for word in normalise(text).split() if word not in _STOP and len(word) > 1}


def distinctive(text: str) -> set[str]:
    """`tokens` without the words many venue names share (`GENERIC`)."""
    return tokens(text) - GENERIC


def area_venue_key(name: str) -> str:
    """The key of the area venue a town or district found by a lookup is
    posted under ("Leuven" → ``ven-area--leuven``)."""
    return AREA_KEY_PREFIX + venue_key(name).removeprefix("ven-")


def is_area_key(key: str | None) -> bool:
    """Whether `key` is an area venue's (`area_venue_key`)."""
    return bool(key) and key.startswith(AREA_KEY_PREFIX)  # type: ignore[union-attr]


def is_online_only(text: str) -> bool:
    """Whether a venue text names only an online place: "Zoom", "Online
    (link sent on registration)", a meeting link. "Hybrid", "In person and
    online" or anything naming a room or building is not."""
    if not text.strip() or _HYBRID.search(text):
        return False
    if not (_ONLINE.search(text) or _LINK.search(text)):
        return False
    rest = _LINK.sub(" ", text)
    rest = _ONLINE.sub(" ", rest)
    rest = _FILLER.sub(" ", rest)
    return not re.sub(r"[^A-Za-z0-9]+", "", rest)


#: A venue text that names no screening place: Camdram's placeholders for a
#: film production ("Short Film", "On Location"), or nothing at all.
_FILM_PLACEHOLDER = re.compile(
    r"^(?:|short film|(?:student )?film|film shoot(?:ing)?|filming|on location|"
    r"location tbc|various locations?|tbc|tba|n/?a)$",
    re.IGNORECASE,
)
#: Words in a Camdram title that mark a film production: a short film, a shoot.
#: Narrow on purpose: "the film", "filming", "35mm" or "on location" in a
#: title say as often that an event is about film (a society AGM, a talk, a
#: workshop, a photo walk) as that it is one.
_FILM = re.compile(
    r"\bshort[- ]film\b|\bstudent film\b|\bfilm shoot(?:ing)?\b|\(film\)",
    re.IGNORECASE,
)
#: Words that mark a screening or a showing, which has a place even when the
#: venue text lists none (the description often names it).
_SCREENING = re.compile(
    r"\bscreening|\bcinema\b|\bpicturehouse\b|\bpremiere\b|\bshowcase\b|"
    r"\bfestival\b|\bnight\b|\bwatch(?:ing)?\b",
    re.IGNORECASE,
)


def is_film_without_venue(
    *, title: str, description: str | None, place_text: str, source_type: str
) -> bool:
    """Whether an event is a film production listed with no screening venue:
    a Camdram "show" that is a short film or a shoot ("Lost and Found
    (Short Film)", venue "Short Film" or "On Location"). Only Camdram lists
    productions this way; any other source's film-ish event (a film society
    AGM, a talk about film) goes to the model. A screening or a showcase
    (which has a place even when none is listed, often in the description)
    is not; neither is a film with a real venue text, which is placed like
    any other event."""
    if source_type != "camdram":
        return False
    place = re.sub(r"\s+", " ", place_text).strip(" .,-")
    if not _FILM_PLACEHOLDER.fullmatch(place):
        return False
    if any(_SCREENING.search(text) for text in (title, place, description or "")):
        return False
    if _FILM.search(title) or re.search(r"\bfilm\b", place, re.IGNORECASE):
        return True
    # "On Location" is Camdram's venue for a film; a show with no venue whose
    # description calls it a short film is one.
    return place.lower() == "on location" or bool(_FILM.search(description or ""))


def single_line(text: str | None, limit: int) -> str | None:
    """One line of at most `limit` characters, or None when nothing is left."""
    if text is None:
        return None
    out = " ".join(text.split())
    if not out:
        return None
    return out if len(out) <= limit else out[: limit - 1].rstrip() + "…"


#: A UK postcode inside a room's text, or a Cambridge one cut short ("CB2 3P", "CB2").
_ANY_POSTCODE = re.compile(r"\b[A-Z]{1,2}\d[A-Z\d]?\s+\d[A-Z]{2}\b")
_CB_POSTCODE = re.compile(r"\bCB\d{1,2}(?:\s*\d[A-Z]{0,2})?\b", re.IGNORECASE)
#: The last word of a street's name (abbreviations included).
_STREET_END = frozenset(
    {
        "road",
        "rd",
        "street",
        "st",
        "lane",
        "ln",
        "avenue",
        "ave",
        "drive",
        "terrace",
        "crescent",
        "parade",
    }
)
#: Street words that read as an address only after a house number ("4-5
#: Peas Hill", "12 Trinity Place"): rooms are called "… Garden" too.
_NUMBERED_STREET_END = _STREET_END | {
    "hill",
    "way",
    "place",
    "row",
    "walk",
    "close",
    "gardens",
    "passage",
    "square",
    "green",
}
#: A house number at the start of a segment: "4", "4-5", "12a".
_HOUSE_NUMBER = re.compile(r"^\d+[a-z]?(?:\s*[-–]\s*\d+[a-z]?)?\s+[a-z]", re.IGNORECASE)
#: A segment that is only the town or the country.
_TOWNS = frozenset({"cambridge", "cambridgeshire", "uk", "united kingdom", "england", "gb"})
#: Words a venue's name may carry beside it in a room's text and still be
#: only the venue ("Trinity Hall Cambridge", "University of X").
_VENUE_FILLER = frozenset(
    {"cambridge", "cambridgeshire", "uk", "england", "university", "of", "the"}
)


def _address_segment(segment: str) -> bool:
    """Whether a segment of a room's text is (part of) an address: a
    postcode, even cut short; a street ("Trinity Ln", "Wilberforce Road");
    a house number and a street ("4-5 Peas Hill"); the town alone."""
    words = normalise(segment).split()
    if not words:
        return True
    if " ".join(words) in _TOWNS:
        return True
    if _ANY_POSTCODE.search(segment) or _CB_POSTCODE.search(segment):
        return True
    if words[-1] in _STREET_END and len([word for word in words if word != "the"]) >= 2:
        # "Wilberforce Road", "Trinity Ln"; never "The Drive" (a room's name).
        return True
    return bool(_HOUSE_NUMBER.match(segment.strip())) and words[-1] in _NUMBERED_STREET_END


def _names_the_venue(segment: str, venue_name: str) -> bool:
    """Whether a segment of a room's text is the venue itself ("Trinity
    Hall Cambridge" at Trinity Hall, "BrewBoard" at BrewBoard): every word
    the venue's name has, and nothing more than generic words, or its
    initials ("CMS"). A generic word more ("Chapel", "Lecture Theatre")
    makes it a room of the venue, kept."""
    own = tokens(venue_name)
    words = tokens(segment)
    bare = segment.strip()
    if (
        len(own) >= 2
        and re.fullmatch(r"[A-Z]{2,6}", bare)
        and bare.lower()
        == "".join(word[0] for word in normalise(venue_name).split() if word in own)
    ):
        # "CMS" at the Centre for Mathematical Sciences: its initials.
        return True
    if not own or not words:
        return normalise(segment) == normalise(venue_name)
    if normalise(segment) == normalise(venue_name):
        return True
    # Every word of the venue's name and nothing but the town around it
    # ("Trinity Hall Cambridge"). Any other word, generic or not, is the
    # room's ("Trinity College Chapel", "Wolfson College Lecture Theatre").
    said = set(normalise(segment).split())
    name = set(normalise(venue_name).split()) - _VENUE_FILLER
    return bool(name) and name <= said and said - name <= _VENUE_FILLER


def clean_room(room: str | None, venue_name: str) -> str | None:
    """A room as the row stores it: one line ≤ 120 characters of what the
    text adds to the venue. Never the venue's own name ("BrewBoard" at
    BrewBoard), never an address or a part of one (a street, "4-5 Peas
    Hill", a postcode even cut short, the town), never a link or an
    honorific (a room is never a person): "Bridgetower Room, Trinity Hall
    Cambridge, Trinity Ln" at Trinity Hall → "Bridgetower Room"."""
    out = single_line(room, LIMITS["room"])
    if out is None or PERSONISH.search(out):
        return None
    segments = [part.strip() for part in re.split(r"[,;]| - | – ", out) if part.strip()]
    kept = [
        part
        for part in segments
        if not _address_segment(part) and not _names_the_venue(part, venue_name)
    ]
    if not kept:
        return None
    out = ", ".join(kept)
    if _POSTCODE.search(out) or normalise(out) in ("", normalise(venue_name)):
        return None
    words = tokens(out)
    if words and words <= tokens(venue_name) and not re.search(r"\d", out):
        # "Hall" at Fitzpatrick Hall: part of the venue's own name, not a room.
        return None
    return out


@dataclass
class VenueIndex:
    """The known venues, by key and by every normalised name and alias. A
    name two venues share matches neither (like `OrgLookup.resolve_venue`)."""

    venues: dict[str, VenueRow] = field(default_factory=dict)
    _by_name: dict[str, set[str]] = field(default_factory=dict)
    #: Venues that are a town, a district or a street themselves
    #: (`venue_class.Coarse.itself`): reached by key only, never by a name,
    #: an alias or overlap, and never in the model's shortlist.
    hidden: set[str] = field(default_factory=set)

    @classmethod
    def of(cls, rows: Iterable[VenueRow], hidden: Iterable[str] = ()) -> VenueIndex:
        index = cls(hidden=set(hidden))
        for row in rows:
            index.add(row)
        return index

    def hide(self, key: str) -> None:
        """Take a venue out of matching by name (it is a town or a street)."""
        row = self.venues.get(key)
        if row is not None:
            for name in self._names(row):
                self._by_name.get(name, set()).discard(key)
        self.hidden.add(key)

    def named(self) -> list[VenueRow]:
        """The venues a name may reach: no area venue, no hidden one."""
        return [row for row in self.venues.values() if self.nameable(row.key)]

    def nameable(self, key: str) -> bool:
        return not is_area_key(key) and key not in self.hidden

    def add(self, row: VenueRow) -> None:
        old = self.venues.get(row.key)
        if old is not None:
            for name in self._names(old):
                self._by_name.get(name, set()).discard(old.key)
        self.venues[row.key] = row
        for name in self._names(row):
            self._by_name.setdefault(name, set()).add(row.key)

    def _names(self, row: VenueRow) -> set[str]:
        if not self.nameable(row.key):
            # A town found for a building: reached by its key only, never
            # by a name a building may share ("Cambridge", "Barnes").
            return set()
        return {n for n in (normalise(row.name), *(normalise(a) for a in row.aliases)) if n}

    def get(self, key: str | None) -> VenueRow | None:
        return self.venues.get(key) if key else None

    def by_name(self, text: str) -> VenueRow | None:
        """The one venue whose name or an alias is `text`, normalised."""
        keys = self._by_name.get(normalise(text), set())
        return self.venues[next(iter(keys))] if len(keys) == 1 else None

    def match(self, text: str) -> tuple[VenueRow, str | None] | None:
        """The venue a venue text names exactly, and the room it adds: the
        whole text, else a comma-separated tail ("Seminar Room 1, Isaac
        Newton Institute" → the institute, room "Seminar Room 1"), else its
        first segment when what follows reads as a room."""
        text = _TAIL.sub("", _POSTCODE.sub("", text).strip()).strip(" ,;")
        if not text:
            return None
        whole = self.by_name(text)
        if whole is not None:
            return whole, None
        segments = [part.strip() for part in re.split(r"[,;]| - | – ", text) if part.strip()]
        for start in range(1, len(segments)):
            venue = self.by_name(", ".join(segments[start:]))
            if venue is None:
                venue = self.by_name(segments[start]) if start == len(segments) - 1 else None
            if venue is not None:
                room = ", ".join(segments[:start])
                return venue, clean_room(room, venue.name)
        if len(segments) > 1:
            venue = self.by_name(segments[0])
            rest = ", ".join(segments[1:])
            if venue is not None and _ROOMISH.search(rest):
                return venue, clean_room(rest, venue.name)
        return None

    def room_beyond(self, venue: VenueRow, text: str) -> str | None:
        """What a venue text adds to the venue it points at: "Seminar Room 1,
        Isaac Newton Institute" with that institute → "Seminar Room 1". None
        when the text does not name the venue (it may be a different
        spelling of it, not a room)."""
        found = self.match(text)
        if found is not None and found[0].key == venue.key:
            return found[1]
        return None

    def shortlist(self, item: PendingItem, size: int = SHORTLIST_SIZE) -> list[VenueRow]:
        """Up to `size` venues the model is shown: those sharing the most words
        with the item's venue text, title and organisers, then the colleges
        and the main sites (`ANCHOR_NAMES`), then more by overlap."""
        wanted = (
            tokens(item.place_text)
            | tokens(" ".join(item.organisers))
            | tokens(" ".join(item.organiser_places))
        )
        title = tokens(item.title)

        def score(row: VenueRow) -> int:
            names = tokens(" ".join([row.name, *row.aliases]))
            return 3 * len(names & wanted) + len(names & title)

        named = self.named()
        ranked = sorted(((score(row), row.name, row.key) for row in named), reverse=True)
        overlap = [self.venues[key] for points, _name, key in ranked if points > 0]
        anchors = sorted(
            (row for row in named if row.college_key or normalise(row.name) in ANCHOR_NAMES),
            key=lambda row: row.name,
        )
        lead = min(SHORTLIST_LEAD, size // 2)
        chosen: dict[str, VenueRow] = {}
        for row in [*overlap[:lead], *anchors, *overlap[lead:]]:
            if len(chosen) >= size:
                break
            chosen.setdefault(row.key, row)
        return list(chosen.values())


def input_hash(item: PendingItem, prompt_version: str) -> str:
    """The hash of everything the stage reads of an item (§2 step 1): the
    prompt version, kind, title, description (its first 1,500 characters),
    venue text, venue key, online flag, organisers and the organisers' usual
    places, these only when the item names no venue (the only case the hint
    decides; in any order, so a society's new event that reorders them does
    not ask again for every item it lists). A stored row with this
    hash is not resolved again. ``<prompt>:<sha256>``, inside the server's
    ``[A-Za-z0-9:_-]{1,128}``."""
    digest = memo_key(
        prompt_version,
        item.kind,
        item.title,
        (item.description or "")[:1500],
        item.place_text,
        item.venue_key or "",
        "online" if item.online else "",
        "\n".join(item.organisers),
        *(
            ["\n".join(sorted(item.organiser_places))]
            if item.organiser_places and not item.place_text and not item.venue_key
            else []
        ),
    )
    return f"{prompt_version}:{digest}"


def by_overlap(rows: Sequence[VenueRow], text: str) -> VenueRow | None:
    """The one venue whose name shares every distinctive word with `text`
    (used to reuse a venue the model proposed as new under another spelling)."""
    words = tokens(text)
    if not words:
        return None
    hits = [row for row in rows if not is_area_key(row.key) and words and tokens(row.name) == words]
    return hits[0] if len(hits) == 1 else None


__all__ = [
    "ANCHOR_NAMES",
    "AREA_KEY_PREFIX",
    "GENERIC",
    "PERSONISH",
    "SHORTLIST_SIZE",
    "VenueIndex",
    "area_venue_key",
    "by_overlap",
    "clean_room",
    "distinctive",
    "input_hash",
    "is_area_key",
    "is_film_without_venue",
    "is_online_only",
    "normalise",
    "single_line",
    "tokens",
]
