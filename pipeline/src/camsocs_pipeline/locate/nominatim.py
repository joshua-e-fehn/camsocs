"""OpenStreetMap Nominatim search: the coordinates of a venue
(source-research §23, docs/locations-and-map.md §2 step 4).

Nominatim's usage policy: at most one request a second, an identifying
User-Agent, results cached (a venue found once is a stored venue and is
never looked up again). The data is ODbL: the map credits OpenStreetMap.

A direct `httpx.Client`, not the polite crawler: this is an API with its own
policy, not a page under robots.txt. Results are bounded to the Cambridge
viewbox and refused outside `CAMBRIDGE_BOUNDS` whatever Nominatim answers.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any, Self

import httpx

from camsocs_pipeline.locate.model import CAMBRIDGE_BOUNDS, Bounds

logger = logging.getLogger(__name__)

DEFAULT_URL = "https://nominatim.openstreetmap.org"
TIMEOUT = 20.0
#: Results asked for per query; the first inside the bounds wins.
RESULTS = 3
_OSM_TYPES = {"node", "way", "relation"}


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

    def search(self, query: str) -> OsmPlace | None:
        """The first result for `query` inside the bounds, or None when
        Nominatim answered and found nothing there. Raises `NominatimBlocked`
        once Nominatim refuses us, and `NominatimUnavailable` when it gave no
        answer (which is never cached as "nothing found")."""
        query = " ".join(query.split())
        if not query:
            return None
        if query in self._cache:
            return self._cache[query]
        if self.blocked:
            raise NominatimBlocked("Nominatim refused an earlier request this run")
        self._pace()
        self.calls += 1
        params = {
            "q": query,
            "format": "jsonv2",
            "addressdetails": "1",
            "limit": str(RESULTS),
            "viewbox": self.bounds.viewbox,
            "bounded": "1",
            "countrycodes": "gb",
        }
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
        found = self._first_inside(results if isinstance(results, list) else [])
        self._cache[query] = found
        return found

    def _first_inside(self, results: Iterable[Any]) -> OsmPlace | None:
        for result in results:
            place = parse_result(result)
            if place is not None and self.bounds.contains(place.lat, place.lng):
                return place
        return None

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
    return OsmPlace(
        osm_type=osm_type,
        osm_id=osm_id,
        lat=round(lat, 6),
        lng=round(lng, 6),
        name=name.strip() if isinstance(name, str) and name.strip() else None,
        address=_address(result.get("address")),
    )


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
    "Nominatim",
    "NominatimBlocked",
    "NominatimUnavailable",
    "OsmPlace",
    "parse_result",
]
