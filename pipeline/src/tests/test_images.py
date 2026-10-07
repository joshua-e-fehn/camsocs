"""Images and PDFs prepared for vision and for our stored copies."""

from __future__ import annotations

import io
import os

from PIL import Image

from camsocs_pipeline.extract.images import (
    MAX_UPLOAD_BYTES,
    MAX_VISION_SIDE,
    render_pdf,
    upload_image,
    vision_image,
)
from camsocs_pipeline.extract.llm import sniff_image_type
from tests.fakes import TERMCARD_LINES, make_pdf


def encoded(image: Image.Image, fmt: str) -> bytes:
    out = io.BytesIO()
    image.save(out, format=fmt)
    return out.getvalue()


def test_small_png_and_jpeg_pass_through_and_large_ones_shrink() -> None:
    small = encoded(Image.new("RGB", (100, 50), "red"), "PNG")
    assert vision_image(small) == small
    large = encoded(Image.new("RGB", (4000, 1000), "blue"), "PNG")
    shrunk = vision_image(large)
    assert shrunk is not None and sniff_image_type(shrunk) == "image/jpeg"
    assert max(Image.open(io.BytesIO(shrunk)).size) <= MAX_VISION_SIDE
    # Formats the vision helper cannot send as-is are converted.
    webp = encoded(Image.new("RGB", (80, 80), "green"), "WEBP")
    assert sniff_image_type(vision_image(webp)) == "image/jpeg"


def test_garbage_is_not_an_image() -> None:
    assert vision_image(b"not an image") is None
    assert upload_image(b"%PDF-1.4 nope") is None


def test_upload_image_keeps_small_files_and_reencodes_big_ones() -> None:
    small = encoded(Image.new("RGB", (100, 50), "red"), "PNG")
    assert upload_image(small) == (small, "image/png")
    noise = Image.frombytes("RGB", (1400, 1400), os.urandom(1400 * 1400 * 3))
    big = encoded(noise, "PNG")
    assert len(big) > MAX_UPLOAD_BYTES
    prepared = upload_image(big)
    assert prepared is not None
    data, content_type = prepared
    assert content_type == "image/jpeg" and len(data) <= MAX_UPLOAD_BYTES


def test_render_pdf_returns_pages_and_the_text_layer() -> None:
    rendered = render_pdf(make_pdf(TERMCARD_LINES))
    assert rendered is not None and rendered.pages == 1
    assert sniff_image_type(rendered.images[0]) == "image/png"
    assert "Week 2 Wednesday 7pm" in rendered.text
    assert render_pdf(b"%PDF-1.4 broken") is None
