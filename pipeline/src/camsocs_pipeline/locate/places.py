"""Google Places Text Search, for place ids only (source-research §23,
docs/locations-and-map.md §0.3, decision D13).

Google's Maps Platform terms forbid showing Places coordinates on a
non-Google map and limit caching them to 30 days; a place id may be stored
indefinitely. So the field mask asks for ``places.id`` and nothing else (the
free "IDs only" SKU): coordinates always come from OpenStreetMap. The id only
builds an exact "Open in Google Maps" link.

The key (`GOOGLE_PLACES_API_KEY`) goes in a header, never in a URL, and is
never logged. Without it the stage skips Places with a note.
"""

from __future__ import annotations

import logging
import re
from typing import Self

import httpx

from camsocs_pipeline.locate.model import CAMBRIDGE_BOUNDS, Bounds

logger = logging.getLogger(__name__)

SEARCH_URL = "https://places.googleapis.com/v1/places:searchText"
FIELD_MASK = "places.id"
TIMEOUT = 20.0
#: What the server accepts (convex/lib/fields.ts `VENUE_SPECS.googlePlaceId`).
PLACE_ID = re.compile(r"^[A-Za-z0-9_-]{10,300}$")


class PlacesBlocked(RuntimeError):
    """The key was refused or the quota is spent: no more requests this run."""


class PlacesUnavailable(RuntimeError):
    """Places gave no answer to this query (a transport error, another
    non-200 status, a body that is not JSON): not "nothing found"."""


def place_url(place_id: str) -> str:
    """The claims' `sourceUrl` for a place id."""
    return f"https://www.google.com/maps/place/?q=place_id:{place_id}"


class Places:
    """Text Search restricted to the Cambridge rectangle, ids only."""

    def __init__(
        self,
        *,
        api_key: str,
        user_agent: str,
        bounds: Bounds = CAMBRIDGE_BOUNDS,
        client: httpx.Client | None = None,
    ) -> None:
        self._key = api_key
        self.bounds = bounds
        self._owns = client is None
        self._client = client or httpx.Client(timeout=TIMEOUT)
        self._user_agent = user_agent
        self.calls = 0
        self.errors = 0
        self.blocked = False

    def __repr__(self) -> str:
        return "Places(…)"  # never the key

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def close(self) -> None:
        if self._owns:
            self._client.close()

    def place_id(self, query: str) -> str | None:
        """The id of the first place Google finds for `query` inside the
        rectangle, or None when it answered and found none. Raises
        `PlacesBlocked` on 401/403/429 and `PlacesUnavailable` when it gave
        no answer."""
        if self.blocked:
            raise PlacesBlocked("Places refused an earlier request this run")
        self.calls += 1
        body = {
            "textQuery": " ".join(query.split()),
            "pageSize": 1,
            "locationRestriction": {
                "rectangle": {
                    "low": {"latitude": self.bounds.south, "longitude": self.bounds.west},
                    "high": {"latitude": self.bounds.north, "longitude": self.bounds.east},
                }
            },
        }
        headers = {
            "X-Goog-Api-Key": self._key,
            "X-Goog-FieldMask": FIELD_MASK,
            "Content-Type": "application/json",
            "User-Agent": self._user_agent,
        }
        try:
            response = self._client.post(SEARCH_URL, json=body, headers=headers)
        except httpx.HTTPError as error:
            self.errors += 1
            logger.warning("Places: %s", type(error).__name__)
            raise PlacesUnavailable(type(error).__name__) from error
        if response.status_code in (401, 403, 429):
            self.blocked = True
            raise PlacesBlocked(f"Places answered {response.status_code}")
        if response.status_code != 200:
            self.errors += 1
            logger.warning("Places: HTTP %s", response.status_code)
            raise PlacesUnavailable(f"HTTP {response.status_code}")
        try:
            places = response.json().get("places") or []
        except (ValueError, AttributeError) as error:
            self.errors += 1
            raise PlacesUnavailable("a body that is not a JSON object") from error
        for place in places:
            found = place.get("id") if isinstance(place, dict) else None
            if isinstance(found, str) and PLACE_ID.fullmatch(found):
                return found
        return None


__all__ = [
    "FIELD_MASK",
    "PLACE_ID",
    "SEARCH_URL",
    "Places",
    "PlacesBlocked",
    "PlacesUnavailable",
    "place_url",
]
