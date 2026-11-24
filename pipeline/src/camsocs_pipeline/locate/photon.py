"""Photon (komoot's OpenStreetMap search, https://photon.komoot.io): the
fallback when Nominatim's free-text search misses a venue's long official
name (source-research §23, docs/locations-and-map.md §2 step 4).

Photon searches the same OpenStreetMap data (ODbL) with a forgiving,
typo-tolerant index, so "Battcock Centre for Experimental Astrophysics" or
"Energy Interdisciplinary Research Centre" may be found where Nominatim
answers nothing. Its public instance asks for fair use: we send at most one
request a second with our identifying User-Agent, a capped number a run, and
a found venue is stored, so it is never looked up again. A result carries
the OSM object's type and id, so its claims cite the object's OSM page like
Nominatim's (source type `osm_nominatim`, extractor `locate.photon.*`).
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from typing import Any, Self

import httpx

from camsocs_pipeline.locate.model import CAMBRIDGE_BOUNDS, Bounds
from camsocs_pipeline.locate.nominatim import OsmPlace, address_line, level_of

logger = logging.getLogger(__name__)

DEFAULT_URL = "https://photon.komoot.io"
TIMEOUT = 20.0
RESULTS = 3
_OSM_TYPES = {"N": "node", "W": "way", "R": "relation"}


class PhotonBlocked(RuntimeError):
    """Photon refused us (403 or 429): no more requests this run."""


class PhotonUnavailable(RuntimeError):
    """Photon gave no answer to this query (a transport error, another
    non-200 status, a body that is not JSON): not "nothing found"."""


class Photon:
    """`/api?q=` with pacing, a call count and an in-run cache by query."""

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

    def search(self, query: str, *, bounds: Bounds | None = None) -> OsmPlace | None:
        """The first result for `query` inside `bounds` (None: anywhere), or
        None when Photon answered and found nothing there. Raises
        `PhotonBlocked` once refused and `PhotonUnavailable` on no answer."""
        query = " ".join(query.split())
        if not query:
            return None
        cache_key = f"{query}|{bounds.viewbox if bounds else '*'}"
        if cache_key in self._cache:
            return self._cache[cache_key]
        if self.blocked:
            raise PhotonBlocked("Photon refused an earlier request this run")
        self._pace()
        self.calls += 1
        params = {"q": query, "limit": str(RESULTS), "lang": "en"}
        if bounds is not None:
            # Photon's bbox is minLon,minLat,maxLon,maxLat.
            params["bbox"] = f"{bounds.west:g},{bounds.south:g},{bounds.east:g},{bounds.north:g}"
        try:
            response = self._client.get(
                f"{self.base_url}/api", params=params, headers=self._headers
            )
        except httpx.HTTPError as error:
            self.errors += 1
            logger.warning("Photon: %s", type(error).__name__)
            raise PhotonUnavailable(type(error).__name__) from error
        if response.status_code in (403, 429):
            self.blocked = True
            raise PhotonBlocked(f"Photon answered {response.status_code}")
        if response.status_code != 200:
            self.errors += 1
            logger.warning("Photon: HTTP %s", response.status_code)
            raise PhotonUnavailable(f"HTTP {response.status_code}")
        try:
            body = response.json()
            features = body.get("features") if isinstance(body, dict) else None
        except ValueError as error:
            self.errors += 1
            raise PhotonUnavailable("a body that is not JSON") from error
        found = None
        for feature in features if isinstance(features, list) else []:
            place = parse_feature(feature)
            if place is not None and (bounds is None or bounds.contains(place.lat, place.lng)):
                found = place
                break
        self._cache[cache_key] = found
        return found


def parse_feature(feature: Any) -> OsmPlace | None:
    """An `OsmPlace` from one Photon GeoJSON feature, or None when malformed."""
    if not isinstance(feature, dict):
        return None
    props = feature.get("properties")
    geometry = feature.get("geometry")
    if not isinstance(props, dict) or not isinstance(geometry, dict):
        return None
    try:
        lng, lat = (float(value) for value in geometry["coordinates"][:2])
        osm_type = _OSM_TYPES[str(props["osm_type"])]
        osm_id = int(props["osm_id"])
    except (KeyError, TypeError, ValueError):
        return None
    name = props.get("name")
    country = props.get("countrycode")
    return OsmPlace(
        osm_type=osm_type,
        osm_id=osm_id,
        lat=round(lat, 6),
        lng=round(lng, 6),
        name=name.strip() if isinstance(name, str) and name.strip() else None,
        address=address_line(
            house_number=props.get("housenumber"),
            road=props.get("street"),
            town=props.get("city") or props.get("town") or props.get("village"),
            postcode=props.get("postcode"),
        ),
        level=level_of(
            props.get("osm_key") if isinstance(props.get("osm_key"), str) else None,
            props.get("osm_value") if isinstance(props.get("osm_value"), str) else None,
        ),
        country_code=country.lower() if isinstance(country, str) and country else None,
    )


__all__ = ["DEFAULT_URL", "Photon", "PhotonBlocked", "PhotonUnavailable", "parse_feature"]
