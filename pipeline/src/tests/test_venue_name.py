"""New venue names are cleaned as webapp/lib/venue-name.ts shows them: both
suites assert webapp/lib/venue-name.fixtures.json."""

from __future__ import annotations

import json

import pytest

from camsocs_pipeline.config import REPO_ROOT
from camsocs_pipeline.locate.venue_name import venue_display_name

FIXTURES = json.loads(
    (REPO_ROOT / "webapp" / "lib" / "venue-name.fixtures.json").read_text(encoding="utf-8")
)


@pytest.mark.parametrize("case", FIXTURES["cases"], ids=lambda case: case["input"] or "empty")
def test_venue_display_name(case: dict[str, str]) -> None:
    assert venue_display_name(case["input"]) == case["output"]


@pytest.mark.parametrize("case", FIXTURES["cases"], ids=lambda case: case["input"] or "empty")
def test_idempotent(case: dict[str, str]) -> None:
    once = venue_display_name(case["input"])
    assert venue_display_name(once) == once
