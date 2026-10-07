"""Instagram through the official Graph API only: Business Discovery
(source-research §17). instagram.com itself is never fetched.

Checked 2026-10-07 against Meta's docs:

- **Endpoint.** ``GET https://graph.facebook.com/<version>/<META_IG_USER_ID>
  ?fields=business_discovery.username(<handle>){…}`` — asked of *our* app
  user's Instagram professional account about another professional account
  (business or creator). Personal accounts and age-gated accounts return
  nothing; that is recorded, not worked around.
- **Fields.** Public IG Media fields via field expansion: ``id, caption,
  timestamp, media_type, media_url, permalink, thumbnail_url`` and the
  ``children`` edge for carousels. ``media_url`` is omitted for media with
  copyrighted material (often Reels audio).
- **Token.** A Facebook User access token with ``instagram_basic``,
  ``instagram_manage_insights`` and ``pages_read_engagement``; sent in the
  ``Authorization: Bearer`` header, never in the URL, so it cannot reach a log.
- **Rate limits.** Business Discovery is under *Platform* rate limits (not the
  Instagram business-use-case ones). Throttling answers error codes 4, 17, 32
  or 613 (or HTTP 429); the ``X-App-Usage`` header reports ``call_count`` as a
  percentage. We send one request at a time, at least `MIN_INTERVAL` apart,
  stop the run at the first throttle, and stop early once ``call_count``
  passes `USAGE_CEILING`.

Images: `download` fetches a ``media_url`` the API returned (a signed CDN
asset URL handed to us for exactly this) so we can store our own copy; it
refuses any other host. SocTrackr's hotlinked CDN URLs expired within days
(landscape brief §3), which is why copies are stored, never hotlinked.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any
from urllib.parse import urlsplit

import httpx

logger = logging.getLogger(__name__)

GRAPH_HOST = "https://graph.facebook.com"
MEDIA_FIELDS = (
    "id,caption,timestamp,media_type,media_url,permalink,thumbnail_url,"
    "children{media_type,media_url}"
)
#: Seconds between two Graph API requests (one in flight at a time).
MIN_INTERVAL = 2.0
#: Stop the run once Meta reports this share of the hourly call budget used.
USAGE_CEILING = 80
#: Media hosts a returned ``media_url`` may point at.
MEDIA_HOST_SUFFIXES = (".cdninstagram.com", ".fbcdn.net")
MAX_MEDIA_BYTES = 8 * 1024 * 1024
THROTTLE_CODES = frozenset({4, 17, 32, 613})
#: Expired, revoked or under-permissioned tokens.
TOKEN_CODES = frozenset({10, 102, 190, 200})


class InstagramError(RuntimeError):
    """The Graph API refused a request for a reason not covered below."""


class RateLimited(InstagramError):
    """Meta is throttling us: stop for this run."""


class TokenInvalid(InstagramError):
    """The access token is expired, revoked or lacks a permission: Joshua
    must renew it (docs/setup/inbox-instagram.md)."""


class NotProfessional(InstagramError):
    """No such professional account (a personal account, a renamed handle,
    an age-gated account)."""


@dataclass(frozen=True)
class Media:
    id: str
    caption: str
    timestamp: datetime
    media_type: str
    permalink: str
    media_url: str | None = None
    thumbnail_url: str | None = None
    #: Carousel children's image URLs, in order.
    children: tuple[str, ...] = ()

    @property
    def image_urls(self) -> tuple[str, ...]:
        """Image URLs worth reading: the photo, a video's thumbnail, or the
        carousel's image children."""
        if self.media_type == "CAROUSEL_ALBUM" and self.children:
            return self.children
        if self.media_type == "VIDEO":
            return (self.thumbnail_url,) if self.thumbnail_url else ()
        return (self.media_url,) if self.media_url else ()


@dataclass(frozen=True)
class Profile:
    handle: str
    ig_id: str
    media: list[Media] = field(default_factory=list)


def _parse_time(value: str) -> datetime | None:
    # Graph API timestamps look like 2026-10-05T18:00:00+0000.
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%S%z")
    except (TypeError, ValueError):
        return None


def parse_profile(handle: str, body: dict[str, Any]) -> Profile:
    """The `business_discovery` object of a successful response."""
    discovery = body.get("business_discovery")
    if not isinstance(discovery, dict) or not discovery.get("id"):
        raise NotProfessional(f"@{handle}: no business_discovery data")
    media: list[Media] = []
    for item in (discovery.get("media") or {}).get("data") or []:
        timestamp = _parse_time(item.get("timestamp", ""))
        permalink = item.get("permalink") or ""
        if not item.get("id") or timestamp is None or not permalink.startswith("https://"):
            continue
        children = tuple(
            child["media_url"]
            for child in (item.get("children") or {}).get("data") or []
            if child.get("media_type") == "IMAGE" and child.get("media_url")
        )
        media.append(
            Media(
                id=str(item["id"]),
                caption=item.get("caption") or "",
                timestamp=timestamp,
                media_type=item.get("media_type") or "IMAGE",
                permalink=permalink,
                media_url=item.get("media_url"),
                thumbnail_url=item.get("thumbnail_url"),
                children=children,
            )
        )
    return Profile(handle=handle, ig_id=str(discovery["id"]), media=media)


def classify_error(status: int, body: Any) -> InstagramError:
    """A Graph API error body → the exception that says what to do."""
    error = body.get("error") if isinstance(body, dict) else None
    error = error if isinstance(error, dict) else {}
    code = error.get("code")
    subcode = error.get("error_subcode")
    message = str(error.get("message") or f"HTTP {status}")[:300]
    if status == 429 or code in THROTTLE_CODES:
        return RateLimited(message)
    if code in TOKEN_CODES:
        return TokenInvalid(message)
    lowered = message.lower()
    if (
        code == 110
        or subcode == 2207013
        or "cannot find user" in lowered
        or "not an instagram business" in lowered
        or (code == 100 and "username" in lowered)
    ):
        return NotProfessional(message)
    return InstagramError(f"code {code}: {message}")


class BusinessDiscovery:
    """A paced, single-stream Business Discovery client. One per run."""

    def __init__(
        self,
        *,
        ig_user_id: str,
        access_token: str,
        version: str,
        user_agent: str,
        client: httpx.Client | None = None,
        min_interval: float = MIN_INTERVAL,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if not ig_user_id.isdigit():
            raise ValueError("META_IG_USER_ID must be the numeric Instagram user id")
        self.ig_user_id = ig_user_id
        self.version = version
        self._token = access_token
        self._owns_client = client is None
        self._client = client or httpx.Client(timeout=60.0)
        self._headers = {"User-Agent": user_agent}
        self._min_interval = min_interval
        self._sleep = sleep
        self._clock = clock
        self._last: float | None = None
        #: The latest `X-App-Usage` call_count (percent), if Meta sent one.
        self.call_count: int | None = None

    def __repr__(self) -> str:  # never the token
        return f"BusinessDiscovery(ig_user_id={self.ig_user_id!r}, version={self.version!r})"

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    @property
    def near_limit(self) -> bool:
        return self.call_count is not None and self.call_count >= USAGE_CEILING

    def fields_for(self, handle: str, media_limit: int) -> str:
        return (
            f"business_discovery.username({handle})"
            f"{{id,username,media.limit({media_limit}){{{MEDIA_FIELDS}}}}}"
        )

    def source_url(self, handle: str) -> str:
        """What we read about an account, as a readable, token-free URL — the
        honest `source_url` of an account-level observation."""
        return (
            f"{GRAPH_HOST}/{self.version}/{self.ig_user_id}"
            f"?fields=business_discovery.username({handle})"
        )

    def _pace(self) -> None:
        if self._last is not None:
            wait = self._min_interval - (self._clock() - self._last)
            if wait > 0:
                self._sleep(wait)

    def fetch(self, handle: str, *, media_limit: int = 12) -> Profile:
        """A professional account's profile id and recent media."""
        self._pace()
        try:
            response = self._client.get(
                f"{GRAPH_HOST}/{self.version}/{self.ig_user_id}",
                params={"fields": self.fields_for(handle, media_limit)},
                headers={**self._headers, "Authorization": f"Bearer {self._token}"},
            )
        finally:
            self._last = self._clock()
        self._record_usage(response)
        try:
            body = response.json()
        except ValueError:
            body = {}
        if response.status_code != 200:
            raise classify_error(response.status_code, body)
        return parse_profile(handle, body)

    def _record_usage(self, response: httpx.Response) -> None:
        raw = response.headers.get("x-app-usage")
        if not raw:
            return
        try:
            usage = json.loads(raw)
            self.call_count = int(usage.get("call_count", 0))
        except (ValueError, TypeError, AttributeError):
            return

    def download(self, url: str) -> bytes | None:
        """An image the API pointed us at, from Meta's CDN only; None on any
        failure (the event is kept without an image)."""
        host = (urlsplit(url).hostname or "").lower()
        if not url.startswith("https://") or not host.endswith(MEDIA_HOST_SUFFIXES):
            logger.info("instagram: refusing a media URL on %s", host or "no host")
            return None
        try:
            response = self._client.get(url, headers=self._headers)
        except httpx.HTTPError as error:
            logger.info("instagram: media download failed (%s)", type(error).__name__)
            return None
        if response.status_code != 200 or len(response.content) > MAX_MEDIA_BYTES:
            return None
        return response.content


__all__ = [
    "BusinessDiscovery",
    "InstagramError",
    "Media",
    "NotProfessional",
    "Profile",
    "RateLimited",
    "TokenInvalid",
    "classify_error",
    "parse_profile",
]
