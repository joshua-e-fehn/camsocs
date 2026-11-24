"""postcodes.io (https://postcodes.io): the coordinates of a UK postcode,
the last geocoding step for a building whose name OpenStreetMap does not
know (source-research §23, docs/locations-and-map.md §2 step 4).

The data is the ONS Postcode Directory under the Open Government Licence
v3.0 ("Contains OS data © Crown copyright and database right; Contains Royal
Mail data © Royal Mail copyright and database right; Source: Office for
National Statistics"). A postcode's point is the centroid of its addresses,
so a venue placed by its postcode is a `building` guess, never `exact`. The
service is free and asks for no key; we pace requests, cap them per run, and
a placed venue is stored, so it is never looked up again.
"""

from __future__ import annotations

import logging
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Self
from urllib.parse import quote

import httpx

logger = logging.getLogger(__name__)

DEFAULT_URL = "https://api.postcodes.io"
TIMEOUT = 20.0
#: A UK postcode anywhere in a line of text ("…, Cambridge CB3 0FD").
UK_POSTCODE = re.compile(
    r"\b(GIR ?0AA|[A-PR-UWYZ][A-HK-Y]?\d[A-Z\d]? ?\d[ABD-HJLNP-UW-Z]{2})\b", re.IGNORECASE
)


def find_postcode(text: str | None) -> str | None:
    """The last UK postcode in `text`, upper case with one space ("CB3 0FD")."""
    if not text:
        return None
    hits = UK_POSTCODE.findall(text)
    if not hits:
        return None
    raw = re.sub(r"\s+", "", hits[-1]).upper()
    return f"{raw[:-3]} {raw[-3:]}"


@dataclass(frozen=True)
class PostcodePoint:
    postcode: str
    lat: float
    lng: float
    #: The district it lies in ("Cambridge", "South Cambridgeshire").
    district: str | None

    @property
    def url(self) -> str:
        """The lookup itself: the claims' `sourceUrl`."""
        return f"{DEFAULT_URL}/postcodes/{quote(self.postcode)}"


class PostcodesBlocked(RuntimeError):
    """postcodes.io refused us (403 or 429): no more requests this run."""


class PostcodesUnavailable(RuntimeError):
    """postcodes.io gave no answer (a transport error, a 5xx, a body that is
    not JSON): not "no such postcode"."""


class Postcodes:
    """`GET /postcodes/<postcode>` with pacing, a call count and a cache."""

    def __init__(
        self,
        *,
        user_agent: str,
        base_url: str = DEFAULT_URL,
        interval: float = 0.25,
        client: httpx.Client | None = None,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.interval = max(interval, 0.1)
        self._owns = client is None
        self._client = client or httpx.Client(timeout=TIMEOUT)
        self._headers = {"User-Agent": user_agent}
        self._clock = clock
        self._sleep = sleep
        self._last: float | None = None
        self._cache: dict[str, PostcodePoint | None] = {}
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

    def lookup(self, postcode: str) -> PostcodePoint | None:
        """The point of `postcode`, or None when postcodes.io has no such
        postcode (404) or no coordinates for it. Raises `PostcodesBlocked`
        on 403/429 and `PostcodesUnavailable` on no answer."""
        code = find_postcode(postcode)
        if code is None:
            return None
        if code in self._cache:
            return self._cache[code]
        if self.blocked:
            raise PostcodesBlocked("postcodes.io refused an earlier request this run")
        self._pace()
        self.calls += 1
        try:
            response = self._client.get(
                f"{self.base_url}/postcodes/{quote(code)}", headers=self._headers
            )
        except httpx.HTTPError as error:
            self.errors += 1
            logger.warning("postcodes.io: %s", type(error).__name__)
            raise PostcodesUnavailable(type(error).__name__) from error
        if response.status_code in (403, 429):
            self.blocked = True
            raise PostcodesBlocked(f"postcodes.io answered {response.status_code}")
        if response.status_code == 404:
            self._cache[code] = None
            return None
        if response.status_code != 200:
            self.errors += 1
            raise PostcodesUnavailable(f"HTTP {response.status_code}")
        try:
            result = response.json().get("result")
        except (ValueError, AttributeError) as error:
            self.errors += 1
            raise PostcodesUnavailable("a body that is not a JSON object") from error
        point = None
        if isinstance(result, dict):
            lat, lng = result.get("latitude"), result.get("longitude")
            if isinstance(lat, int | float) and isinstance(lng, int | float):
                district = result.get("admin_district")
                point = PostcodePoint(
                    postcode=str(result.get("postcode") or code),
                    lat=round(float(lat), 6),
                    lng=round(float(lng), 6),
                    district=district if isinstance(district, str) else None,
                )
        self._cache[code] = point
        return point


__all__ = [
    "DEFAULT_URL",
    "UK_POSTCODE",
    "PostcodePoint",
    "Postcodes",
    "PostcodesBlocked",
    "PostcodesUnavailable",
    "find_postcode",
]
