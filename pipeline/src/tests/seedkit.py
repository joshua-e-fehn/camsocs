"""Test doubles for the seed harvesters: canned fetch results, no network.

The fixtures under ``fixtures/seed/`` are synthetic pages with the structure of
the live ones (checked 2026-10-07) and no real personal data.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

from camsocs_pipeline.sources.base import FetchResult

FIXTURES = Path(__file__).parent / "fixtures" / "seed"
FETCHED_AT = "2026-10-07T12:00:00+00:00"


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def ok(
    url: str, body: str | bytes, *, final_url: str | None = None, ctype="text/html"
) -> FetchResult:
    data = body.encode("utf-8") if isinstance(body, str) else body
    return FetchResult(
        url=url,
        final_url=final_url or url,
        outcome="fetched",
        status=200,
        fetched_at=FETCHED_AT,
        content=data,
        content_type=f"{ctype}; charset=utf-8",
        content_sha256=hashlib.sha256(data).hexdigest(),
    )


def failed(url: str, outcome: str, status: int | None = None, detail: str | None = None):
    return FetchResult(
        url=url,
        final_url=url,
        outcome=outcome,  # type: ignore[arg-type]
        status=status,
        fetched_at=FETCHED_AT,
        detail=detail,
    )


class FakeClient:
    """Answers `fetch` from a dict of canned results; unknown URLs are 404s.
    Records every URL asked for, so a test can assert what was never fetched."""

    def __init__(self, pages: dict[str, FetchResult] | None = None) -> None:
        self.pages = dict(pages or {})
        self.asked: list[str] = []

    def fetch(self, url: str, **_kwargs) -> FetchResult:
        self.asked.append(url)
        return self.pages.get(url) or failed(url, "not_found", 404)

    def robots_verdict(self, url: str) -> str:
        result = self.pages.get(url)
        return "disallowed" if result and result.outcome == "disallowed_by_robots" else "allowed"

    def __enter__(self):
        return self

    def __exit__(self, *_exc) -> None:
        return None
