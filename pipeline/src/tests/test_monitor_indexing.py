"""`search_indexing` (monitor.py `check_indexing`): the daily indexing
check's summary from Convex, as counts. Invented numbers only."""

from __future__ import annotations

from datetime import UTC, datetime

from camsocs_pipeline.monitor import INDEXING_NAME, check_indexing

NOW = datetime(2026, 11, 8, 9, 0, tzinfo=UTC)
RAN = int(datetime(2026, 11, 8, 7, 5, tzinfo=UTC).timestamp() * 1000)


def test_ok_when_nothing_is_wrong() -> None:
    result = check_indexing(lambda: {"runAt": RAN, "problems": 0, "sitemapIssues": 0}, now=NOW)
    assert result.name == INDEXING_NAME
    assert result.status == "ok"
    assert result.value == 0
    assert result.detail == {"problems": 0, "sitemapIssues": 0, "hoursSinceRun": 1.9}


def test_fails_on_problems_or_sitemap_issues_with_counts_only() -> None:
    result = check_indexing(lambda: {"runAt": RAN, "problems": 3, "sitemapIssues": 1}, now=NOW)
    assert result.status == "failed"
    assert result.value == 4
    assert result.reason is None
    assert "fails when > 0" in result.line()


def test_fails_when_the_check_stopped_running() -> None:
    old = RAN - 40 * 3_600_000
    result = check_indexing(lambda: {"runAt": old, "problems": 0, "sitemapIssues": 0}, now=NOW)
    assert result.status == "failed"
    assert result.value == 1
    assert result.detail["hoursSinceRun"] == 41.9


def test_unknown_never_pages_when_convex_fails_or_the_check_never_ran() -> None:
    def broken() -> dict[str, object]:
        raise ConnectionError("down")

    assert check_indexing(broken, now=NOW).status == "unknown"
    assert check_indexing(broken, now=NOW).reason == "ConnectionError"
    never = check_indexing(lambda: {"runAt": None, "problems": 0, "sitemapIssues": 0}, now=NOW)
    assert never.status == "unknown"
    malformed = check_indexing(lambda: {"runAt": RAN, "problems": "3"}, now=NOW)
    assert malformed.status == "unknown"
