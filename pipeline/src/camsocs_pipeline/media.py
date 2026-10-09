"""Our own copies of images (event images, logos): never a hotlink.

SocTrackr hotlinked Instagram CDN images and every one had expired within days
(source-research §17), so the public site only ever shows a file we stored
(`imageUrl` / `logoUrl` come from a `storageId`, convex/lib/projections.ts).

The work is split so harvest stages never call Convex:

1. **Harvest** — a stage that finds an image calls `probe_image`, which
   fetches it through the polite client (robots, pacing, cache) and checks it
   is a raster image the files route accepts (PNG, JPEG, WebP, GIF or AVIF by
   its magic bytes, at most 2 MB; never SVG). Only then does the stage record
   the field, as ``{"sourceUrl": url}``.
2. **Load** — `pipeline.load.attach_stored_files` turns each such value into
   ``{"storageId", "sourceUrl"}`` by uploading the bytes `CachedImages`
   reads back from the cache (`POST /api/pipeline/files`, de-duplicated by
   content on the server). A value whose bytes cannot be had is not posted, so
   an earlier stored copy is never replaced by a reference to nothing.

Organisation logos are fetched with the society purpose (`sources/policy.py`,
D3): an SU ``/asset/`` logo linked from a society's listing may be copied
although the SU's robots.txt disallows ``/asset/``. Event images keep the
general purpose.
"""

from __future__ import annotations

import logging
from datetime import timedelta

from camsocs_pipeline.config import ConfigError, Settings
from camsocs_pipeline.sources.base import PoliteClient
from camsocs_pipeline.sources.policy import GENERAL, FetchPurpose

logger = logging.getLogger(__name__)

#: The files route's ceiling (webapp/convex/ingest/files.ts).
MAX_FILE_BYTES = 2 * 1024 * 1024

#: How long a cached image is reused at load time without asking the server.
IMAGE_CACHE_TTL = timedelta(days=14)

IMAGE_ACCEPT = "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9"


def sniff_raster(data: bytes) -> str | None:
    """The MIME type of a raster image the files route accepts, from its
    magic bytes; None for anything else (SVG, HTML error pages, PDFs)."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    if data[4:8] == b"ftyp" and data[8:12] in (b"avif", b"avis"):
        return "image/avif"
    return None


def usable_image(data: bytes | None) -> str | None:
    """The content type if `data` is an image we may store, else None."""
    if not data or len(data) > MAX_FILE_BYTES:
        return None
    return sniff_raster(data)


def probe_image(client: PoliteClient, url: str, purpose: FetchPurpose = GENERAL) -> bool:
    """Harvest-time check (step 1): fetch `url` politely and keep it only if
    it is a storable raster image. True means the cache now holds it."""
    try:
        result = client.fetch(url, fresh_for=IMAGE_CACHE_TTL, accept=IMAGE_ACCEPT, purpose=purpose)
    except ValueError:
        return False
    return result.ok and usable_image(result.content) is not None


class CachedImages:
    """Load-time source of image bytes (step 2), read through the polite
    client's cache (a cold cache fetches politely). The client is built on
    first use, so a run that stores no images needs no User-Agent."""

    def __init__(self, settings: Settings, client: PoliteClient | None = None) -> None:
        self._settings = settings
        self._client = client
        self._unavailable: str | None = None

    def __call__(self, url: str, purpose: FetchPurpose = GENERAL) -> tuple[bytes, str] | None:
        client = self._ensure_client()
        if client is None:
            return None
        try:
            result = client.fetch(
                url, fresh_for=IMAGE_CACHE_TTL, accept=IMAGE_ACCEPT, purpose=purpose
            )
        except ValueError:
            return None
        content_type = usable_image(result.content) if result.ok else None
        if content_type is None or result.content is None:
            return None
        return result.content, content_type

    @property
    def unavailable(self) -> str | None:
        """Why no image could be read at all (no User-Agent configured)."""
        return self._unavailable

    def _ensure_client(self) -> PoliteClient | None:
        if self._client is None and self._unavailable is None:
            try:
                user_agent = self._settings.require_user_agent()
            except ConfigError as error:
                self._unavailable = str(error)
                logger.warning("images are not stored: %s", error)
                return None
            self._client = PoliteClient(
                user_agent=user_agent,
                cache_dir=self._settings.cache_dir,
                min_interval=self._settings.min_host_interval,
            )
        return self._client

    def close(self) -> None:
        if self._client is not None:
            self._client.close()


__all__ = [
    "IMAGE_CACHE_TTL",
    "MAX_FILE_BYTES",
    "CachedImages",
    "probe_image",
    "sniff_raster",
    "usable_image",
]
