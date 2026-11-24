"""OpenStreetMap Nominatim search: the coordinates of a venue
(source-research §23, docs/locations-and-map.md §2 step 4).

Nominatim's usage policy: at most one request a second, an identifying
User-Agent, results cached (a venue found once is a stored venue and is
never looked up again). The data is ODbL: the map credits OpenStreetMap.

A direct `httpx.Client`, not the polite crawler: this is an API with its own
policy, not a page under robots.txt. A search is bounded to a viewbox (the
Cambridge one by default) and a result outside it is refused whatever
Nominatim answers; only a place the model flags as outside Cambridge is
searched for without a box (`bounds=None`, `geocode.py`).
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any, Literal, Self

import httpx

from camsocs_pipeline.locate.model import CAMBRIDGE_BOUNDS, Bounds

logger = logging.getLogger(__name__)

DEFAULT_URL = "https://nominatim.openstreetmap.org"
TIMEOUT = 20.0
#: Results asked for per query; the first inside the bounds wins.
RESULTS = 3
_OSM_TYPES = {"node", "way", "relation"}

#: How much a result pins down: a named feature (a building, a club, a
#: hall), a street or a postcode (coordinates near the building, no name of
#: its own), or a settlement or district (an area only).
Level = Literal["feature", "street", "area"]

#: OSM keys / types that are a settlement or a district, not a place to go.
_AREA_TYPES = frozenset(
    {
        "city",
        "town",
        "village",
        "hamlet",
        "suburb",
        "quarter",
        "neighbourhood",
        "borough",
        "municipality",
        "county",
        "state",
        "region",
        "province",
        "country",
        "district",
        "city_district",
        "locality",
        "isolated_dwelling",
        "administrative",
        "postcode",
    }
)
_AREA_CATEGORIES = frozenset({"place", "boundary"})
_STREET_CATEGORIES = frozenset({"highway"})
#: Transport stops and stations: named after the town or street they serve
#: ("Barnes" station), so near a place, never a venue.
_TRANSPORT_CATEGORIES = frozenset({"railway", "public_transport", "aeroway"})
_TRANSPORT_TYPES = frozenset({"bus_stop", "station", "halt", "platform", "stop_position"})
_STREET_TYPES = frozenset({"road", "street", "residential"})


def level_of(category: str | None, kind: str | None, addresstype: str | None = None) -> Level:
    """A result's `Level` from its OSM key (Nominatim's `category`, Photon's
    `osm_key`), value (`type` / `osm_value`) and Nominatim's `addresstype`."""
    category = (category or "").lower()
    kind = (kind or "").lower()
    addresstype = (addresstype or "").lower()
    if kind in ("house", "houses", "building") and category in ("place", "building", ""):
        return "street" if category == "place" else "feature"
    if category in _AREA_CATEGORIES or (kind in _AREA_TYPES and category in ("", "place")):
        return "area"
    if addresstype in _AREA_TYPES and category in _AREA_CATEGORIES:
        return "area"
    if category in _STREET_CATEGORIES or (category == "" and kind in _STREET_TYPES):
        return "street"
    if category in _TRANSPORT_CATEGORIES or (category == "amenity" and kind == "bus_station"):
        return "street"
    if kind in _TRANSPORT_TYPES and category in ("", "place", "building"):
        return "street"
    return "feature"


@dataclass(frozen=True)
class OsmPlace:
    """One Nominatim result."""

    osm_type: str
    osm_id: int
    lat: float
    lng: float
    #: The OSM `name`, when the object has one.
    name: str | None
    #: "11 Sidgwick Avenue, Cambridge CB3 9DD", built from the address parts.
    address: str | None
    #: What the object is (`level_of`).
    level: Level = "feature"
    #: ISO 3166-1 alpha-2, lower case ("gb"), when the result says.
    country_code: str | None = None

    @property
    def url(self) -> str:
        """The object's page: the claims' `sourceUrl`."""
        return f"https://www.openstreetmap.org/{self.osm_type}/{self.osm_id}"


class NominatimBlocked(RuntimeError):
    """Nominatim refused us (403 or 429): no more requests this run."""


class NominatimUnavailable(RuntimeError):
    """Nominatim could not answer this query (a transport error, another
    non-200 status, a body that is not JSON). Not an answer: nothing is
    cached, and the caller retries in a later run."""


class Nominatim:
    """Search with pacing (`interval` seconds between requests), a call
    count, and an in-run cache by query."""

    def __init__(
        self,
        *,
        user_agent: str,
        base_url: str = DEFAULT_URL,
        interval: float = 1.0,
        bounds: Bounds = CAMBRIDGE_BOUNDS,
        client: httpx.Client | None = None,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.interval = max(interval, 1.0)
        self.bounds = bounds
        self._owns = client is None
        self._client = client or httpx.Client(timeout=TIMEOUT)
        self._headers = {"User-Agent": user_agent, "Accept-Language": "en"}
        self._clock = clock
        self._sleep = sleep
        self._last: float | None = None
        self._cache: dict[str, OsmPlace | None] = {}
        self.calls = 0
        self.errors = 0
        self.blocked = False

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def close(self) -> None:
        if self._owns:
            self._client.close()

    def _pace(self) -> None:
        if self._last is not None:
            wait = self.interval - (self._clock() - self._last)
            if wait > 0:
                self._sleep(wait)
        self._last = self._clock()

    def search(
        self,
        query: str,
        *,
        bounds: Bounds | Literal["default"] | None = "default",
        countrycodes: str | None = "gb",
    ) -> OsmPlace | None:
        """The first result for `query` inside `bounds` (the client's own by
        default; None: anywhere, for a place outside Cambridge), or None
        when Nominatim answered and found nothing there. `countrycodes`
        narrows the search to countries ("gb"; None: any). Raises
        `NominatimBlocked` once Nominatim refuses us, and
        `NominatimUnavailable` when it gave no answer (which is never cached
        as "nothing found")."""
        query = " ".join(query.split())
        if not query:
            return None
        box = self.bounds if bounds == "default" else bounds
        params = {"q": query}
        return self._get(params, box, countrycodes)

    def search_structured(
        self,
        *,
        street: str | None = None,
        city: str | None = None,
        postalcode: str | None = None,
        bounds: Bounds | Literal["default"] | None = "default",
        countrycodes: str | None = "gb",
    ) -> OsmPlace | None:
        """Nominatim's structured search (`street=`, `city=`, `postalcode=`):
        an address a free-text search misses. Same answers and errors as
        `search`."""
        params = {
            key: " ".join(value.split())
            for key, value in (("street", street), ("city", city), ("postalcode", postalcode))
            if value and value.strip()
        }
        if not params or set(params) == {"city"}:
            return None
        box = self.bounds if bounds == "default" else bounds
        return self._get(params, box, countrycodes)

    def _get(
        self, query: dict[str, str], box: Bounds | None, countrycodes: str | None
    ) -> OsmPlace | None:
        cache_key = "|".join(
            [
                *(f"{k}={v}" for k, v in sorted(query.items())),
                box.viewbox if box else "*",
                countrycodes or "*",
            ]
        )
        if cache_key in self._cache:
            return self._cache[cache_key]
        if self.blocked:
            raise NominatimBlocked("Nominatim refused an earlier request this run")
        self._pace()
        self.calls += 1
        params = {
            **query,
            "format": "jsonv2",
            "addressdetails": "1",
            "limit": str(RESULTS),
        }
        if box is not None:
            params |= {"viewbox": box.viewbox, "bounded": "1"}
        if countrycodes:
            params["countrycodes"] = countrycodes
        try:
            response = self._client.get(
                f"{self.base_url}/search", params=params, headers=self._headers
            )
        except httpx.HTTPError as error:
            self.errors += 1
            logger.warning("Nominatim: %s", type(error).__name__)
            raise NominatimUnavailable(type(error).__name__) from error
        if response.status_code in (403, 429):
            self.blocked = True
            raise NominatimBlocked(f"Nominatim answered {response.status_code}")
        if response.status_code != 200:
            self.errors += 1
            logger.warning("Nominatim: HTTP %s", response.status_code)
            raise NominatimUnavailable(f"HTTP {response.status_code}")
        try:
            results = response.json()
        except ValueError as error:
            self.errors += 1
            raise NominatimUnavailable("a body that is not JSON") from error
        found = _first_inside(results if isinstance(results, list) else [], box)
        self._cache[cache_key] = found
        return found

    def find(self, queries: Iterable[str | None]) -> OsmPlace | None:
        """The first query (in order, each once) that finds a place."""
        seen: set[str] = set()
        for query in queries:
            if not query or query in seen:
                continue
            seen.add(query)
            place = self.search(query)
            if place is not None:
                return place
        return None


def _first_inside(results: Iterable[Any], box: Bounds | None) -> OsmPlace | None:
    for result in results:
        place = parse_result(result)
        if place is not None and (box is None or box.contains(place.lat, place.lng)):
            return place
    return None


def parse_result(result: Any) -> OsmPlace | None:
    """An `OsmPlace` from one jsonv2 result, or None when it is malformed."""
    if not isinstance(result, dict):
        return None
    try:
        osm_type = str(result["osm_type"])
        osm_id = int(result["osm_id"])
        lat = float(result["lat"])
        lng = float(result["lon"])
    except (KeyError, TypeError, ValueError):
        return None
    if osm_type not in _OSM_TYPES:
        return None
    name = result.get("name")
    parts = result.get("address")
    country = parts.get("country_code") if isinstance(parts, dict) else None
    return OsmPlace(
        osm_type=osm_type,
        osm_id=osm_id,
        lat=round(lat, 6),
        lng=round(lng, 6),
        name=name.strip() if isinstance(name, str) and name.strip() else None,
        address=_address(parts),
        level=level_of(
            _text(result.get("category")),
            _text(result.get("type")),
            _text(result.get("addresstype")),
        ),
        country_code=country.lower() if isinstance(country, str) and country else None,
    )


def _text(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def address_line(
    *,
    house_number: Any = None,
    road: Any = None,
    town: Any = None,
    postcode: Any = None,
) -> str | None:
    """ "11 Sidgwick Avenue, Cambridge CB3 9DD" from its parts (None when empty)."""
    street = " ".join(str(part) for part in (house_number, road) if isinstance(part, str) and part)
    tail = " ".join(str(part) for part in (town, postcode) if isinstance(part, str) and part)
    out = ", ".join(part for part in (street, tail) if part)
    return out or None


def _address(parts: Any) -> str | None:
    """ "11 Sidgwick Avenue, Cambridge CB3 9DD" from Nominatim's address parts."""
    if not isinstance(parts, dict):
        return None
    street = " ".join(
        str(parts[key]) for key in ("house_number", "road") if isinstance(parts.get(key), str)
    )
    town = next(
        (parts[key] for key in ("city", "town", "village") if isinstance(parts.get(key), str)),
        None,
    )
    postcode = parts.get("postcode") if isinstance(parts.get("postcode"), str) else None
    tail = " ".join(part for part in (town, postcode) if part)
    out = ", ".join(part for part in (street, tail) if part)
    return out or None


__all__ = [
    "DEFAULT_URL",
    "Level",
    "Nominatim",
    "NominatimBlocked",
    "NominatimUnavailable",
    "OsmPlace",
    "address_line",
    "level_of",
    "parse_result",
]
