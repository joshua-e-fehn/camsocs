"""The committed Cambridge gazetteer: the first lookup for a Cambridge
building, before Nominatim (docs/locations-and-map.md §2 step 4,
source-research §23).

`data/cambridge_places.json` holds OpenStreetMap's named University,
college and department buildings and common venues of Cambridge, read
through the Overpass API by `gazetteer_build.py` (ODbL). Each place has
its OSM name, its other OSM names (`alt_name`, `official_name`, … and the
departments its `occupier` tag names) and its point.
`data/cambridge_aliases.json` adds curated lookup names for buildings a
listing names differently ("Faculty of Music" is "11 West Road", the
"Hodgkin-Huxley Seminar Room" is in the Physiology Building); each points
at one place by OSM id.

`Gazetteer.find(texts)` reads the texts in order (the building the model
names, its OSM query, …) and returns the first place one of them names:

1. the whole text, else a segment of it ("Recital Room, Faculty of Music"
   → "Faculty of Music"), that *is* an alias, a place's name or one of its
   other names (on a tie, the segment with more distinctive words, then the
   later one: the building usually follows the room);
2. else the longest alias or name the text *contains* as whole words
   ("Seminar Room West RDC (A0.015)" → "RDC"), once the parts of the text
   that read as an address are gone ("Hidden Rooms, Jesus Lane" is not
   Jesus College); the name needs two distinctive words, unless it is an
   alias or a college's own;
3. else a place whose name has exactly the text's distinctive words
   ("Economics Faculty" → "Faculty of Economics"): two words or more, or
   one college's short name ("Girton").

What is never matched on its own:

- a room's name ("Chapel", "Library", "Main Hall", "The Bar": no word
  outside `ROOM_WORDS`): only with its college, "Fitzwilliam College
  Chapel", or "Chapel" in a text that also names "Fitzwilliam College";
- a placeholder or the University itself as a name ("TBA", "Cambridge
  University"), and a name of under four letters ("E", "Chi");
- a pub's, bar's, café's or restaurant's name, except as the whole text or
  a segment of two words or more, and never a college's short name (the
  restaurant "Trinity").

An alias beats a name, a name beats another name. A name several places
share counts when they lie within `CLUSTER_M` of one another (the six
"Department of Land Economy" buildings on Silver Street): a college's main
feature, then the one with an address, then the lowest OSM id, stands for
them. Otherwise it is ambiguous and matches nothing.

A hit is an OSM object, so the venue made from it carries OSM's own name,
address and point (`resolver`), cited to the object's OSM page: never the
item's wording, so talks may use it (G1). Nothing here reaches the network.
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from functools import cache
from pathlib import Path

from camsocs_pipeline.locate.matching import distinctive, normalise, tokens

DATA_DIR = Path(__file__).parent / "data"
PLACES_PATH = DATA_DIR / "cambridge_places.json"
ALIASES_PATH = DATA_DIR / "cambridge_aliases.json"

#: Places sharing a name are one place when they all lie this close.
CLUSTER_M = 300.0
#: Kinds whose name counts only as a whole segment (a pub called "The
#: Castle" is not every text that mentions a castle).
SEGMENT_ONLY_KINDS = frozenset(
    {
        "amenity=pub",
        "amenity=bar",
        "amenity=cafe",
        "amenity=restaurant",
        "amenity=nightclub",
        "amenity=biergarten",
        "tourism=hotel",
    }
)
#: Kinds of a college's (or another institution's) main feature.
COLLEGE_KINDS = frozenset({"amenity=university", "amenity=college", "building=college"})
#: Words that name a room or a part of a site, not which one: a name of
#: only these (and `matching.GENERIC` and stop words) is a room's ("Chapel",
#: "Main Hall", "The Bar", "Combination Room") that every college has.
ROOM_WORDS = frozenset(
    {
        "ante",
        "antechapel",
        "annexe",
        "auditorium",
        "bar",
        "block",
        "boathouse",
        "buttery",
        "cafe",
        "canteen",
        "cellar",
        "cellars",
        "chamber",
        "chapel",
        "cloister",
        "cloisters",
        "combination",
        "committee",
        "common",
        "conference",
        "council",
        "crypt",
        "dining",
        "fellows",
        "foyer",
        "forecourt",
        "function",
        "garden",
        "gardens",
        "gym",
        "gymnasium",
        "kitchen",
        "kitchens",
        "lawn",
        "lodge",
        "lounge",
        "lower",
        "master",
        "masters",
        "meeting",
        "office",
        "offices",
        "parlour",
        "pavilion",
        "porters",
        "quad",
        "reading",
        "reception",
        "refectory",
        "senior",
        "junior",
        "servery",
        "staircase",
        "study",
        "upper",
        "wing",
    }
)
#: Names OSM sometimes carries that name no building ("TBA" on Heycock
#: Wing, "Cambridge University" on the Centre for Material Culture).
PLACEHOLDER_NAMES = frozenset(
    {
        "tba",
        "tbc",
        "tbd",
        "tbca",
        "unknown",
        "n a",
        "na",
        "none",
        "null",
        "various",
        "university",
        "the university",
        "cambridge",
        "city of cambridge",
        "university of cambridge",
        "the university of cambridge",
        "cambridge university",
    }
)
#: Where a text splits into segments.
_SEGMENTS = re.compile(r"[,;•|()\[\]/]| - | – | — ")
#: Rank of how a phrase names a place (lower wins on equal length).
_ALIAS, _NAME, _ALT = 0, 1, 2


@dataclass(frozen=True)
class GazetteerPlace:
    osm_type: str
    osm_id: int
    #: OSM's `name` (else the department its `occupier` tag names).
    name: str
    alt_names: tuple[str, ...]
    operator: str | None
    kind: str | None
    address: str | None
    lat: float
    lng: float

    @property
    def ident(self) -> str:
        return f"{self.osm_type}/{self.osm_id}"

    @property
    def url(self) -> str:
        """The object's OSM page: the claims' `sourceUrl`."""
        return f"https://www.openstreetmap.org/{self.osm_type}/{self.osm_id}"


@dataclass(frozen=True)
class GazetteerHit:
    place: GazetteerPlace
    #: The text and the phrase of it that named the place.
    text: str
    phrase: str
    #: alias | name | alt | overlap
    how: str


def name_variants(name: str) -> set[str]:
    """A name, normalised, and the same without a bracketed part:
    "Centre for Mathematical Sciences (University of Cambridge)" → also
    "centre for mathematical sciences"."""
    out = {normalise(name)}
    bare = re.sub(r"\([^)]*\)", " ", name)
    if bare != name:
        out.add(normalise(bare))
    return {variant for variant in out if variant}


#: The last word of a street's name.
_ROAD_WORDS = frozenset(
    {
        "road",
        "street",
        "lane",
        "avenue",
        "way",
        "close",
        "drive",
        "place",
        "hill",
        "parade",
        "terrace",
        "row",
        "walk",
        "passage",
        "gardens",
        "crescent",
    }
)


def addressish(phrase: str) -> bool:
    """Whether a normalised name reads as an address ("11 west road", "mill
    lane"): it starts with a house number or ends with a street word."""
    words = phrase.split()
    return bool(words) and (words[0][0].isdigit() or words[-1] in _ROAD_WORDS)


def lookup_name(name: str) -> bool:
    """Whether a place's (non-alias) name may be looked up at all: not a
    placeholder or the University itself ("TBA", "Cambridge University"),
    four letters or more, with a word of three letters or more ("E", "Fu",
    "Building 20" are not)."""
    phrase = normalise(name)
    if len(phrase) < 4 or phrase in PLACEHOLDER_NAMES:
        return False
    return any(len(word) >= 3 and word.isalpha() for word in tokens(name))


def core_words(phrase: str) -> set[str]:
    """The words of a name that say which place it is: its distinctive
    words without room words (`ROOM_WORDS`) and short or numeric ones.
    Empty for a room's name ("Main Hall", "The Bar", "Seminar Room 1")."""
    return {word for word in distinctive(phrase) - ROOM_WORDS if len(word) >= 3 and word.isalpha()}


def _usable(phrase: str) -> bool:
    """Whether a normalised name may be looked for inside a longer text on
    its own: two distinctive words, one of them three letters or more
    ("Conservation", "Council" or "Physiology Building" alone do not)."""
    return bool(core_words(phrase)) and len(distinctive(phrase) - ROOM_WORDS) >= 2


def operator_phrase(operator: str | None) -> str | None:
    """A college's name as its places' `operator` tag gives it, normalised
    and without the University: "Fitzwilliam College (University of
    Cambridge)", "Newnham College, University of Cambridge" → "fitzwilliam
    college". None for the University itself or no operator."""
    if not operator:
        return None
    bare = re.sub(r"\([^)]*\)", " ", operator).split(",")[0]
    phrase = normalise(bare)
    if not phrase or phrase in PLACEHOLDER_NAMES or not core_words(phrase):
        return None
    return phrase


#: A segment of a text that is a postcode-bearing address.
_POSTCODE = re.compile(r"\bCB\d{1,2}\s*\d[A-Z]{2}\b", re.IGNORECASE)
#: Street words that end a run of words naming a street inside a segment.
_RUN_WORDS = ("street", "road", "lane", "avenue", "drive", "parade", "terrace", "crescent")
_STREET_RUN = re.compile(r"\b(?:(?:st|saint) )?[a-z]+ (?:" + "|".join(_RUN_WORDS) + r")\b")


def address_free(text: str) -> list[str]:
    """The normalised segments of a text without what reads as an address,
    for the looser lookups: a segment that starts with a house number, ends
    with a street word or holds a postcode is dropped, and a street's name
    inside a segment ("Pembroke Street lecture") is cut out."""
    out: list[str] = []
    for segment in _SEGMENTS.split(text):
        if _POSTCODE.search(segment):
            continue
        phrase = normalise(segment)
        words = phrase.split()
        if not words or words[0][0].isdigit() or words[-1] in _RUN_WORDS:
            continue
        phrase = " ".join(_STREET_RUN.sub(" ", phrase).split())
        if phrase:
            out.append(phrase)
    return out


def _metres(a: GazetteerPlace, b: GazetteerPlace) -> float:
    lat = math.radians((a.lat + b.lat) / 2)
    dy = (a.lat - b.lat) * 111_320.0
    dx = (a.lng - b.lng) * 111_320.0 * math.cos(lat)
    return math.hypot(dx, dy)


@dataclass
class Gazetteer:
    places: dict[str, GazetteerPlace]
    #: When the places were read from OpenStreetMap (the claims' `retrievedAt`).
    retrieved_at: datetime
    #: Normalised phrase → (rank, place ids).
    _phrases: dict[str, tuple[int, frozenset[str]]] = field(default_factory=dict)
    #: Normalised phrase → whether it may be found inside a longer text.
    _inside: dict[str, bool] = field(default_factory=dict)
    #: Distinctive words of a name → place ids.
    _words: dict[frozenset[str], set[str]] = field(default_factory=dict)
    #: Names that read as an address → place ids: matched by the whole text only.
    _whole: dict[str, set[str]] = field(default_factory=dict)
    #: A room's name → (place id, its college's name): matched only in a
    #: text that also names that college.
    _rooms: dict[str, list[tuple[str, str]]] = field(default_factory=dict)
    #: The ids of colleges' main features, and their short names' words
    #: ({"girton"}, {"murray", "edwards"}).
    _colleges: set[str] = field(default_factory=set)
    _college_words: set[frozenset[str]] = field(default_factory=set)

    # -- loading -------------------------------------------------------------------------

    @classmethod
    def load(cls, places_path: Path = PLACES_PATH, aliases_path: Path | None = ALIASES_PATH):
        data = json.loads(places_path.read_text(encoding="utf-8"))
        stamp = datetime.fromisoformat(str(data["retrievedAt"]).replace("Z", "+00:00"))
        places = {}
        for row in data["places"]:
            place = GazetteerPlace(
                osm_type=row["osmType"],
                osm_id=int(row["osmId"]),
                name=row["name"],
                alt_names=tuple(row.get("altNames") or ()),
                operator=row.get("operator"),
                kind=row.get("kind"),
                address=row.get("address"),
                lat=float(row["lat"]),
                lng=float(row["lng"]),
            )
            places[place.ident] = place
        aliases: list[tuple[str, str]] = []
        if aliases_path is not None and aliases_path.exists():
            for entry in json.loads(aliases_path.read_text(encoding="utf-8"))["aliases"]:
                aliases += [(name, entry["osm"]) for name in entry["names"]]
        return cls.of(places, aliases, stamp.astimezone(UTC))

    @classmethod
    def of(
        cls,
        places: dict[str, GazetteerPlace],
        aliases: Iterable[tuple[str, str]] = (),
        retrieved_at: datetime | None = None,
    ) -> Gazetteer:
        out = cls(places=places, retrieved_at=retrieved_at or datetime.now(UTC))
        for ident, place in places.items():
            if place.kind not in COLLEGE_KINDS:
                continue
            own = operator_phrase(place.name)
            college = operator_phrase(place.operator)
            if own and (own == college or (college is None and own.endswith(" college"))):
                # Its own operator ("Girton College (University of Cambridge)"),
                # or an untagged college (St John's has no operator).
                out._colleges.add(ident)
                out._college_words.add(frozenset(distinctive(own)))
        # A college's short name ("fitzwilliam") qualifies its rooms only
        # when no other college shares it (Trinity College, Trinity Hall).
        shorts: dict[str, set[str]] = {}
        for place in places.values():
            college = operator_phrase(place.operator)
            if college:
                short = " ".join(w for w in college.split() if w in distinctive(college))
                shorts.setdefault(short, set()).add(college)
        found: dict[str, dict[int, set[str]]] = {}
        segment_only: dict[str, bool] = {}
        qualified: set[str] = set()

        def add(phrase: str, rank: int, ident: str) -> None:
            found.setdefault(phrase, {}).setdefault(rank, set()).add(ident)

        for ident, place in places.items():
            only = place.kind in SEGMENT_ONLY_KINDS
            college = operator_phrase(place.operator)
            for rank, names in ((_NAME, [place.name]), (_ALT, place.alt_names)):
                for name in names:
                    if not lookup_name(name):
                        continue
                    for phrase in name_variants(name):
                        if len(phrase) < 4 or phrase in PLACEHOLDER_NAMES:
                            continue
                        if addressish(phrase):
                            # "11 West Road", "Mill Lane (Pembroke College)":
                            # only the whole text, never a part of an address.
                            out._whole.setdefault(phrase, set()).add(ident)
                            continue
                        if not core_words(phrase):
                            # A room every college has ("Chapel", "The Bar"):
                            # only with the college it belongs to.
                            if college and not only:
                                out._rooms.setdefault(phrase, []).append((ident, college))
                                room = phrase.removeprefix("the ")
                                combos = {f"{college} {room}", f"{room} {college}"}
                                short = " ".join(
                                    w for w in college.split() if w in distinctive(college)
                                )
                                if short and len(shorts.get(short, ())) == 1:
                                    combos |= {f"{short} {room}", f"{room} {short}"}
                                for combo in combos:
                                    add(combo, rank, ident)
                                    qualified.add(combo)
                            continue
                        add(phrase, rank, ident)
                        segment_only[phrase] = segment_only.get(phrase, False) or only
                        words = frozenset(distinctive(phrase))
                        if words:
                            out._words.setdefault(words, set()).add(ident)
        for name, ident in aliases:
            if ident not in places:
                raise ValueError(f"gazetteer alias {name!r} points at {ident}, not in the data")
            add(normalise(name), _ALIAS, ident)
        for phrase, ranks in found.items():
            rank = min(ranks)
            ids = frozenset(ranks[rank])
            out._phrases[phrase] = (rank, ids)
            out._inside[phrase] = (
                rank == _ALIAS
                or phrase in qualified
                or (
                    not segment_only.get(phrase)
                    and (_usable(phrase) or (bool(core_words(phrase)) and ids <= out._colleges))
                )
            )
        return out

    @staticmethod
    @cache
    def default() -> Gazetteer:
        """The committed data, read once per process."""
        return Gazetteer.load()

    # -- lookups -------------------------------------------------------------------------

    def get(self, ident: str) -> GazetteerPlace | None:
        return self.places.get(ident)

    def find(self, texts: Sequence[str | None]) -> GazetteerHit | None:
        """The place the first of `texts` that names one names (see the
        module docstring), or None."""
        for text in texts:
            if not text or not text.strip():
                continue
            hit = self._exact(text) or self._inside_of(text) or self._overlap(text)
            if hit is not None:
                return hit
        return None

    def _one(self, ids: Iterable[str]) -> GazetteerPlace | None:
        """The place a set of ids stands for: one id, or a cluster within
        `CLUSTER_M` (a college's main feature, then the first with an
        address, then the lowest id)."""
        places = sorted(
            (self.places[i] for i in ids),
            key=lambda p: (p.ident not in self._colleges, p.address is None, p.osm_type, p.osm_id),
        )
        if not places:
            return None
        first = places[0]
        if all(_metres(first, other) <= CLUSTER_M for other in places[1:]):
            return first
        return None

    def _segment_only(self, ident: str) -> bool:
        return self.places[ident].kind in SEGMENT_ONLY_KINDS

    def _exact(self, text: str) -> GazetteerHit | None:
        whole = normalise(text)
        if whole in self._whole and whole not in self._phrases:
            place = self._one(self._whole[whole])
            return GazetteerHit(place, text, whole, "name") if place is not None else None
        segments = [text, *_SEGMENTS.split(text)]
        #: (rank, fewer distinctive words, earlier segment) → the lowest wins.
        best: tuple[tuple[int, int, int], GazetteerPlace, str, str] | None = None
        for index, segment in enumerate(segments):
            phrase = normalise(segment)
            if not phrase:
                continue
            candidates: list[tuple[int, frozenset[str], str]] = []
            entry = self._phrases.get(phrase)
            if entry is not None:
                ids = entry[1]
                one_word = len(phrase.split()) == 1
                if one_word and (phrase != whole or frozenset({phrase}) in self._college_words):
                    # A pub's or restaurant's one-word name is only the whole
                    # text, and never a college's short name ("Trinity").
                    ids = frozenset(i for i in ids if not self._segment_only(i))
                candidates.append((entry[0], ids, ("alias", "name", "alt")[entry[0]]))
            rooms = self._rooms.get(phrase)
            if rooms:
                # "Chapel" in "Chapel, Fitzwilliam College": the college's chapel.
                ids = frozenset(ident for ident, college in rooms if f" {college} " in f" {whole} ")
                candidates.append((_NAME, ids, "room"))
            for rank, ids, how in candidates:
                place = self._one(ids) if ids else None
                if place is None:
                    continue
                score = (0 if index == 0 else 1, rank, -len(distinctive(phrase)), -index)
                if best is None or score < best[0]:
                    best = (score, place, phrase, how)
        if best is None:
            return None
        return GazetteerHit(best[1], text, best[2], best[3])

    def _inside_of(self, text: str) -> GazetteerHit | None:
        candidates: list[tuple[int, int, str]] = []
        # Every run of words of an address-free segment that is a known phrase.
        for segment in address_free(text):
            words = segment.split()
            for start in range(len(words)):
                for end in range(start + 1, len(words) + 1):
                    phrase = " ".join(words[start:end])
                    if phrase in self._phrases and self._inside.get(phrase):
                        rank = self._phrases[phrase][0]
                        candidates.append((-len(phrase), rank, phrase))
        for _length, rank, phrase in sorted(candidates):
            place = self._one(self._phrases[phrase][1])
            if place is not None:
                return GazetteerHit(place, text, phrase, ("alias", "name", "alt")[rank])
        return None

    def _overlap(self, text: str) -> GazetteerHit | None:
        segments = address_free(text)
        for segment in [" ".join(segments), *segments]:
            words = frozenset(distinctive(segment))
            if not core_words(segment):
                continue
            ids = {i for i in self._words.get(words, ()) if not self._segment_only(i)}
            if not ids:
                continue
            if len(words) == 1:
                # One word names a college ("Girton", "Pembroke"), and only
                # when one college has it ("Trinity" is two).
                colleges = {i for i in ids if i in self._colleges}
                names = {operator_phrase(self.places[i].operator) for i in colleges}
                if len(names) != 1:
                    continue
                ids = colleges
            place = self._one(ids)
            if place is not None:
                return GazetteerHit(place, text, " ".join(sorted(words)), "overlap")
        return None


__all__ = [
    "ALIASES_PATH",
    "CLUSTER_M",
    "COLLEGE_KINDS",
    "PLACEHOLDER_NAMES",
    "PLACES_PATH",
    "ROOM_WORDS",
    "Gazetteer",
    "GazetteerHit",
    "GazetteerPlace",
    "address_free",
    "addressish",
    "core_words",
    "lookup_name",
    "name_variants",
    "operator_phrase",
]
