"""`location_unresolved_share` (monitor.py `check_location_coverage`): the
next 14 days' location coverage from Convex, as counts, in shadow mode
(decision D9). Invented numbers only."""

from __future__ import annotations

from camsocs_pipeline import monitor
from camsocs_pipeline.monitor import LOCATION_NAME, check_location_coverage

SUMMARY = {
    "from": 0,
    "to": 1,
    "upcoming": 200,
    "resolved": 198,
    "unknown": 2,
    "byPrecision": {
        "exact": 150,
        "building": 40,
        "area": 3,
        "online": 5,
        "unknown": 1,
        "missing": 1,
    },
    "unresolvedShare": 0.01,
    "truncated": False,
}


def test_ok_at_or_under_two_percent_with_counts_only() -> None:
    result = check_location_coverage(lambda: SUMMARY)
    assert result.name == LOCATION_NAME == "location_unresolved_share"
    assert result.status == "ok" and result.value == 0.01 and result.threshold == 0.02
    assert result.shadow and result.window_hours == 336
    assert result.detail == {
        "upcoming": 200,
        "resolved": 198,
        "unknown": 2,
        "missing": 1,
        "truncated": 0,
    }
    assert result.line().startswith("shadow location_unresolved_share: ok, 0.01")


def test_fails_above_two_percent_but_never_pages() -> None:
    result = check_location_coverage(lambda: {**SUMMARY, "unresolvedShare": 0.0512})
    assert result.status == "failed" and result.value == 0.0512
    assert "shadow, never pages" in result.line()


def test_unknown_when_convex_does_not_answer_or_answers_badly() -> None:
    def broken() -> dict[str, object]:
        raise ConnectionError("down")

    down = check_location_coverage(broken)
    assert (down.status, down.reason, down.shadow) == ("unknown", "ConnectionError", True)
    malformed = check_location_coverage(lambda: {**SUMMARY, "unresolvedShare": "1%"})
    assert malformed.status == "unknown"


def test_it_is_a_convex_shadow_check_not_a_posthog_one() -> None:
    assert monitor.CONVEX_SHADOW_CHECKS == (LOCATION_NAME,)
    assert LOCATION_NAME not in monitor.SHADOW_CHECKS
    assert LOCATION_NAME not in monitor.CHECK_NAMES
