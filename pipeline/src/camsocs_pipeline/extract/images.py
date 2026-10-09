"""Images and PDFs for vision extraction and for our own stored copies.

- `vision_image`: any raster image → PNG/JPEG bytes no larger than
  `MAX_VISION_SIDE` on the longest side (what the strong model reads well and
  cheaply).
- `upload_image`: an image → bytes and type the `/api/pipeline/files` route
  accepts (≤ 2 MB, PNG/JPEG/WebP/GIF), re-encoded as JPEG only when too big.
- `render_pdf`: the first pages of a PDF → page images plus the PDF's text
  layer. The text layer is what quotes from a termcard PDF are checked
  against; an image-only card has none, so its claims stay `inferred`.

Pillow guards against decompression bombs (`Image.MAX_IMAGE_PIXELS`); any
image that fails to decode is skipped, never retried with looser limits.
"""

from __future__ import annotations

import io
import logging
from dataclasses import dataclass

import pypdfium2 as pdfium
from PIL import Image, UnidentifiedImageError

logger = logging.getLogger(__name__)

MAX_VISION_SIDE = 2048
#: `MAX_FILE_BYTES` of webapp/convex/ingest/files.ts.
MAX_UPLOAD_BYTES = 2 * 1024 * 1024
MAX_PDF_PAGES = 4
PDF_RENDER_SCALE = 2.0

_FORMAT_TYPES = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp", "GIF": "image/gif"}


def _open(data: bytes) -> Image.Image | None:
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
        return image
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as error:
        logger.info("Skipping an image that does not decode (%s)", type(error).__name__)
        return None


def _jpeg(image: Image.Image, *, max_side: int, quality: int = 85) -> bytes:
    copy = image.convert("RGB")
    copy.thumbnail((max_side, max_side))
    out = io.BytesIO()
    copy.save(out, format="JPEG", quality=quality, optimize=True)
    return out.getvalue()


def vision_image(data: bytes) -> bytes | None:
    """Bytes the vision model accepts (`extract.llm.sniff_image_type`), shrunk
    to `MAX_VISION_SIDE`; None if `data` is not a decodable image."""
    image = _open(data)
    if image is None:
        return None
    if image.format in ("PNG", "JPEG") and max(image.size) <= MAX_VISION_SIDE:
        return data
    return _jpeg(image, max_side=MAX_VISION_SIDE)


def upload_image(data: bytes) -> tuple[bytes, str] | None:
    """`(bytes, content type)` for `ConvexLoader.upload_file`, or None."""
    image = _open(data)
    if image is None:
        return None
    if image.format in _FORMAT_TYPES and len(data) <= MAX_UPLOAD_BYTES:
        return data, _FORMAT_TYPES[image.format]
    for side, quality in ((2048, 85), (1600, 80), (1200, 75), (900, 70)):
        encoded = _jpeg(image, max_side=side, quality=quality)
        if len(encoded) <= MAX_UPLOAD_BYTES:
            return encoded, "image/jpeg"
    return None


@dataclass(frozen=True)
class RenderedPdf:
    images: list[bytes]
    text: str
    pages: int


def render_pdf(
    data: bytes, *, max_pages: int = MAX_PDF_PAGES, first_page: int = 0
) -> RenderedPdf | None:
    """`max_pages` pages from `first_page` (0-based) as PNG plus their text
    layer; None if the bytes are not a readable PDF. `pages` is the whole
    document's page count, so a caller can read a long PDF in chunks."""
    try:
        document = pdfium.PdfDocument(data)
    except pdfium.PdfiumError as error:
        logger.info("Skipping a PDF that does not open (%s)", error)
        return None
    try:
        images: list[bytes] = []
        texts: list[str] = []
        for index in range(first_page, min(len(document), first_page + max_pages)):
            page = document[index]
            texts.append(page.get_textpage().get_text_bounded())
            rendered = page.render(scale=PDF_RENDER_SCALE).to_pil()
            rendered.thumbnail((MAX_VISION_SIDE, MAX_VISION_SIDE))
            out = io.BytesIO()
            rendered.save(out, format="PNG", optimize=True)
            images.append(out.getvalue())
        return RenderedPdf(images=images, text="\n".join(texts).strip(), pages=len(document))
    finally:
        document.close()


__all__ = [
    "MAX_UPLOAD_BYTES",
    "MAX_VISION_SIDE",
    "RenderedPdf",
    "render_pdf",
    "upload_image",
    "vision_image",
]
