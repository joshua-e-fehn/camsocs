"""Which known venues are no place to go: a town, a district or a street
(docs/locations-and-map.md §2 step 4, "Coarse venues").

Earlier runs made venues of what a lookup found where a building was asked
for: the city's centroid ("Cambridge"), streets ("Wilberforce Road",
"Downing Street"), towns and regions ("Greater London", "Leuven"). An item
reaching one of them by key or name was then posted `exact`. Stage state
(`coarseVenues`) only remembers the street and postcode points the current
code makes, so the venues themselves are judged by what their OpenStreetMap
object is:

- a venue whose point (else name) is cited to an OSM object
  (`venues/all` `osmUrl`) is classified by that object's OSM key and value:
  from the committed gazetteer when it holds the object (no request), else
  from Nominatim's `/lookup` (≤ `LOOKUP_BATCH` objects a request, paced at
  one a second like every Nominatim request, with the crawler's
  User-Agent). Answers are kept in stage state (`venueClass`: venue key →
  ``{osm, class, type, name, checkedAt}``) and asked again after
  `RECHECK_DAYS`;
- `place` (a settlement, a district; not a square, a house, a farm or an
  island) and an administrative, political, postal or ceremonial
  `boundary` are an **area**; a `highway` (not a stop) is a **street**
  (`coarse_level`, a rule for known venues, not `nominatim.level_of`'s for
  geocoding hits); everything else (a building, an amenity, a square, a
  station, a park, a protected area) is a place one can go to;
- a venue without an OSM object (Camdram's, a society's own, a postcode's
  point) is trusted as it is.

A coarse venue is the town or street *itself* when its name is the OSM
object's (`Coarse.itself`): it is left out of the model's shortlist and of
matching by name, alias or overlap for other items. A building the model
named that was only placed at a street's point keeps its name for matching;
either way an area gives an item `area` precision and a street at most
`building` (`resolver.Locator`).

Only a real answer is kept: an outage, a refusal or the request cap
leaves a venue never classified before trusted for this run (with a
note), and one whose cached answer is past `RECHECK_DAYS` judged by that
answer; the next run asks again.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable, Mapping, MutableMapping
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any, Literal

from camsocs_pipeline.keys import venue_key
from camsocs_pipeline.locate.gazetteer import Gazetteer
from camsocs_pipeline.locate.matching import is_area_key, normalise
from camsocs_pipeline.locate.model import VenueRow
from camsocs_pipeline.locate.nominatim import (
    LOOKUP_BATCH,
    Nominatim,
    NominatimBlocked,
    NominatimUnavailable,
)
from camsocs_pipeline.locate.venue_name import venue_display_name

logger = logging.getLogger(__name__)

#: A cached class is asked for again after this long (OSM objects change).
RECHECK_DAYS = 90
#: `/lookup` requests one run makes at most (50 objects each).
MAX_LOOKUP_CALLS = 20

CoarseLevel = Literal["area", "street"]


@dataclass(frozen=True)
class Coarse:
    """A venue that is no building: what it is, and whether the venue *is*
    that town or street (its name is the OSM object's) rather than a named
    building placed at its point."""

    level: CoarseLevel
    itself: bool


@dataclass
class Classification:
    #: Venue key → how it is coarse (venues not here are places to go).
    coarse: dict[str, Coarse] = field(default_factory=dict)
    #: Venues classified from the gazetteer, the cache and `/lookup` this run.
    from_gazetteer: int = 0
    from_cache: int = 0
    #: Venues past `RECHECK_DAYS` judged by their old answer (no new one).
    from_stale: int = 0
    looked_up: int = 0
    #: `/lookup` requests made.
    calls: int = 0
    notes: list[str] = field(default_factory=list)


#: `place=*` values that are somewhere to go, not a settlement or district.
_PLACE_TO_GO = frozenset(
    {"square", "house", "houses", "farm", "island", "islet", "plot", "isolated_dwelling"}
)
#: `boundary=*` values that are a town, a district or a county. Others (a
#: protected area, a national park) are places one can go to.
_AREA_BOUNDARIES = frozenset({"administrative", "political", "postal_code", "ceremonial"})
#: `highway=*` values that are a stop, not the road: a place to go.
_HIGHWAY_STOPS = frozenset({"bus_stop", "platform", "stop"})


def coarse_level(
    category: str | None, kind: str | None, addresstype: str | None = None
) -> CoarseLevel | None:
    """How coarse a *known venue's* OSM object of this key / value is (not
    `nominatim.level_of`, which grades geocoding hits): "area" for a
    settlement or district (`place=*` but a square, a house, a farm or an
    island; an administrative, political, postal or ceremonial boundary),
    "street" for a road (`highway=*` but a stop), None for a place one can
    go to (a building, an amenity, a square, a station, a park).
    `addresstype` is accepted for the cache's shape and not read."""
    del addresstype
    category = (category or "").lower()
    kind = (kind or "").lower()
    if category == "place":
        return None if kind in _PLACE_TO_GO else "area"
    if category == "boundary":
        return "area" if kind in _AREA_BOUNDARIES else None
    if category == "highway":
        return None if kind in _HIGHWAY_STOPS else "street"
    return None


def is_itself(venue: VenueRow, osm_name: str | None) -> bool:
    """Whether the venue is the OSM object itself: its name is the object's
    (as `locate` posts it, or minting the same key). A nameless object is
    never a venue's name, so a venue on it is a building placed there."""
    if not osm_name:
        return False
    if normalise(venue.name) in (normalise(osm_name), normalise(venue_display_name(osm_name))):
        return True
    try:
        return venue_key(osm_name) == venue.key
    except ValueError:
        return False


def classify_venues(
    venues: Iterable[VenueRow],
    *,
    state: MutableMapping[str, Any],
    now: datetime,
    nominatim: Nominatim | None = None,
    gazetteer: Gazetteer | None = None,
    max_calls: int = MAX_LOOKUP_CALLS,
) -> Classification:
    """Classify `venues` (see the module docstring). `state` is the stage
    state's `venueClass` map, updated in place with every `/lookup` answer;
    `nominatim` None (a dry run): the gazetteer and the cache only."""
    out = Classification()
    recheck_before = (now - timedelta(days=RECHECK_DAYS)).date()
    todo: dict[str, list[VenueRow]] = {}
    #: Venue key → its cached answer past `RECHECK_DAYS`.
    stale: dict[str, dict[str, Any]] = {}
    answered: set[str] = set()
    for venue in venues:
        ident = venue.osm_ident
        if ident is None or is_area_key(venue.key):
            continue
        place = gazetteer.get(ident) if gazetteer is not None else None
        if place is not None:
            category, _, kind = (place.kind or "").partition("=")
            _judge(out, venue, category or None, kind or None, None, place.name)
            out.from_gazetteer += 1
            continue
        cached = state.get(venue.key)
        if isinstance(cached, dict) and cached.get("osm") == ident:
            if _fresh(cached.get("checkedAt"), recheck_before):
                _judge_cached(out, venue, cached)
                out.from_cache += 1
                continue
            # Due to be asked again: until a real answer comes, the old
            # one stands (an outage or the cap never un-classifies a venue).
            stale[venue.key] = cached
        todo.setdefault(ident, []).append(venue)
    if not todo or nominatim is None:
        if todo:
            out.notes.append(f"{len(todo)} venues not classified (no lookups in this run)")
        _keep_stale(out, todo, stale, answered=set())
        return out
    idents = list(todo)
    batches = [idents[i : i + LOOKUP_BATCH] for i in range(0, len(idents), LOOKUP_BATCH)]
    left = 0
    for number, batch in enumerate(batches):
        if number >= max_calls:
            left += len(batch)
            continue
        try:
            found = nominatim.lookup(batch)
        except (NominatimBlocked, NominatimUnavailable) as error:
            logger.warning("locate: venue classes not looked up (%s)", error)
            out.notes.append(
                f"Nominatim lookup did not answer ({error}); "
                "unclassified venues are trusted this run"
            )
            left += sum(len(b) for b in batches[number:])
            break
        out.calls += 1
        stamp = now.date().isoformat()
        answered.update(batch)
        for ident in batch:
            osm = found.get(ident)
            for venue in todo[ident]:
                # An object Nominatim no longer has is remembered as such
                # (no class), so it is not asked for again every run.
                state[venue.key] = {
                    "osm": ident,
                    "class": osm.category if osm else None,
                    "type": osm.kind if osm else None,
                    "addresstype": osm.addresstype if osm else None,
                    "name": osm.name if osm else None,
                    "checkedAt": stamp,
                }
                out.looked_up += 1
                if osm is not None:
                    _judge(out, venue, osm.category, osm.kind, osm.addresstype, osm.name)
    if left:
        out.notes.append(f"{left} venue objects wait for the next run's lookup")
    _keep_stale(out, todo, stale, answered)
    return out


def _keep_stale(
    out: Classification,
    todo: Mapping[str, list[VenueRow]],
    stale: Mapping[str, Mapping[str, Any]],
    answered: set[str],
) -> None:
    """Judge the venues whose recheck got no answer by their old one."""
    for ident, rows in todo.items():
        if ident in answered:
            continue
        for venue in rows:
            cached = stale.get(venue.key)
            if cached is not None:
                _judge_cached(out, venue, cached)
                out.from_stale += 1


def _judge_cached(out: Classification, venue: VenueRow, cached: Mapping[str, Any]) -> None:
    _judge(
        out,
        venue,
        cached.get("class"),
        cached.get("type"),
        cached.get("addresstype"),
        cached.get("name"),
    )


def _judge(
    out: Classification,
    venue: VenueRow,
    category: str | None,
    kind: str | None,
    addresstype: str | None,
    name: str | None,
) -> None:
    level = coarse_level(category, kind, addresstype)
    if level is not None:
        out.coarse[venue.key] = Coarse(level=level, itself=is_itself(venue, name))


def _fresh(stamp: object, before: date) -> bool:
    if not isinstance(stamp, str):
        return False
    try:
        return date.fromisoformat(stamp[:10]) > before
    except ValueError:
        return False


__all__ = [
    "MAX_LOOKUP_CALLS",
    "RECHECK_DAYS",
    "Classification",
    "Coarse",
    "CoarseLevel",
    "classify_venues",
    "coarse_level",
    "is_itself",
]
