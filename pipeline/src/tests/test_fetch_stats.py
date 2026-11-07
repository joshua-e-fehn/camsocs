"""Fetch statistics and yield metrics (L6): per stage, per host class, counts only."""

from __future__ import annotations

import re
import threading
from pathlib import Path

import pytest
from pydantic import BaseModel

from camsocs_pipeline import fetch_stats
from camsocs_pipeline.events.common import Tally, dropped_metric, tally_metrics
from camsocs_pipeline.extract.memo import LLMMemo
from camsocs_pipeline.sources.policy import (
    COLLEGE_SOCIETY_LIST,
    GENERAL,
    PERMISSION_ROBOTS_NOTE,
    ROBOTS_OVERRIDE_NOTE,
    SOCIETY_WEBSITE,
)
from camsocs_pipeline.telemetry import _NAME

#: Telemetry's metric-name shape, and Convex's rule for record keys.
_CONVEX_KEY = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,63}")


@pytest.mark.parametrize(
    ("url", "purpose", "expected"),
    [
        ("https://talks.cam.ac.uk/show/index/1", GENERAL, "never_override"),
        ("https://www.tbc.xyz/x", GENERAL, "never_override"),
        ("https://linktr.ee/somesoc", GENERAL, "linktree"),
        ("https://www.cambridgesu.co.uk/asset/Organisation/1/logo.png", GENERAL, "su_asset"),
        (
            "https://calendar.google.com/calendar/ical/abc/public/basic.ics",
            GENERAL,
            "google_calendar_feed",
        ),
        ("https://soc.example.org/", SOCIETY_WEBSITE, "society_website"),
        ("https://www.jcr.example.ac.uk/socs", COLLEGE_SOCIETY_LIST, "college_society_list"),
        ("https://soc.example.org/", GENERAL, "other"),
        ("https://www.cam.ac.uk/", GENERAL, "registry"),
        ("https://www.proctors.cam.ac.uk/register", GENERAL, "registry"),
        ("https://webservices.admin.cam.ac.uk/events/api/programmes", GENERAL, "registry"),
        ("https://www.clare.cam.ac.uk/", SOCIETY_WEBSITE, "university_main_site"),
        ("https://example.org/", GENERAL, "other"),
    ],
)
def test_host_class_comes_from_the_fetch_policy(url: str, purpose, expected: str) -> None:
    assert fetch_stats.host_class(url, purpose.bound_to(url)) == expected
    assert expected in fetch_stats.HOST_CLASSES


def test_every_metric_name_is_a_safe_record_key() -> None:
    for name in (*fetch_stats.CLASS_COUNTERS, *fetch_stats.EXTRA_COUNTERS):
        assert _NAME.fullmatch(name) and _CONVEX_KEY.fullmatch(name)
        assert not name.startswith(("_", "$"))
    assert len(set(fetch_stats.CLASS_COUNTERS)) == len(fetch_stats.CLASS_COUNTERS)


def _record(stats: fetch_stats.StageStats, klass: str, **kwargs) -> None:
    values = {"outcome": "fetched", "status": 200, "from_cache": False, "override": None}
    values.update(kwargs)
    stats.record(klass, trace=None, **values)


def test_metrics_sum_the_classes_and_by_host_class_keeps_them_apart() -> None:
    stats = fetch_stats.StageStats("probe")
    _record(stats, "society_website", override=ROBOTS_OVERRIDE_NOTE)
    _record(stats, "registry", outcome="unchanged", status=304, from_cache=True)
    _record(stats, "registry", outcome="unreachable", status=None)
    _record(stats, "registry", override=PERMISSION_ROBOTS_NOTE)
    _record(stats, "not-a-class", outcome="http_error", status=500)

    metrics = stats.metrics()
    assert list(metrics) == list(fetch_stats.CLASS_COUNTERS)
    assert metrics["fetchRequests"] == 5
    assert metrics["fetchFetched"] == 2 and metrics["fetchUnchanged"] == 1
    assert metrics["fetchUnreachable"] == 1 and metrics["fetchHttpError"] == 1
    assert metrics["fetchCacheHits"] == 1
    assert (metrics["fetchStatus2xx"], metrics["fetchStatus3xx"], metrics["fetchStatus5xx"]) == (
        2,
        1,
        1,
    )
    assert metrics["fetchOverrideSociety"] == 1 and metrics["fetchOverridePermission"] == 1
    classes = stats.by_host_class()
    assert set(classes) == {"society_website", "registry", "other"}
    assert classes["registry"]["fetchRequests"] == 3
    assert classes["other"]["fetchHttpError"] == 1, "an unknown class is `other`"


def test_a_stage_without_fetches_adds_only_its_non_zero_extras() -> None:
    stats = fetch_stats.StageStats("probe")
    assert stats.metrics() == {}
    stats.count("llmCacheHits", 0)
    stats.count("llmGenerations", 2)
    assert stats.metrics() == {"llmGenerations": 2}


def test_notes_outside_a_fetch_land_under_other_and_need_an_active_stage() -> None:
    fetch_stats.note_retry()  # no stage: ignored
    with fetch_stats.activate("probe") as stats:
        fetch_stats.note_robots_unreachable("https://down.example/robots.txt")
        fetch_stats.note_contacted("https://down.example/robots.txt")
        fetch_stats.note_wait(1.25)
        fetch_stats.note_wait(-3)
    assert fetch_stats.current() is None
    other = stats.by_host_class()["other"]
    assert other["robotsHostsUnreachable"] == 1 and other["hostsContacted"] == 1
    assert other["fetchWaitS"] == 1.25 and other["fetchRequests"] == 0


def test_activate_nests_and_restores() -> None:
    with fetch_stats.activate("outer") as outer:
        with fetch_stats.activate("inner") as inner:
            fetch_stats.count("llmGenerations")
        fetch_stats.count("llmCacheHits")
    assert inner.metrics() == {"llmGenerations": 1}
    assert outer.metrics() == {"llmCacheHits": 1}


def test_worker_threads_count_into_the_active_stage() -> None:
    """A stage's ThreadPoolExecutor workers inherit no ContextVar: the
    collector is process-global, the per-fetch trace thread-local."""

    def work() -> None:
        for _ in range(200):
            with fetch_stats.fetch_trace() as trace:
                fetch_stats.note_retry()
                fetch_stats.note_contacted("https://a.example/")
            fetch_stats.record_fetch(
                "https://a.example/x",
                GENERAL,
                outcome="fetched",
                status=200,
                from_cache=False,
                override=None,
                trace=trace,
            )

    with fetch_stats.activate("pooled") as stats:
        threads = [threading.Thread(target=work) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

    metrics = stats.metrics()
    assert metrics["fetchRequests"] == 1600 and metrics["fetchRetries"] == 1600
    assert metrics["hostsContacted"] == 1


# --- yield metrics -------------------------------------------------------------


def test_drop_reasons_become_camel_case_metric_names() -> None:
    assert dropped_metric("a room booking, not an event") == "droppedARoomBookingNotAnEvent"
    assert dropped_metric("talks from another list's series") == (
        "droppedTalksFromAnotherListSSeries"
    )
    assert dropped_metric("!!!") == "droppedOther"
    assert len(dropped_metric("word " * 40)) == 64


def test_the_tally_becomes_metrics() -> None:
    tally = Tally(staged=7, venues=2, resolved_organisers=5, unresolved_organisers=1, link_in_bio=1)
    tally.drop("naive time", 2)
    tally.drop("outside the window")
    metrics = tally_metrics(tally)
    assert metrics == {
        "eventsStaged": 7,
        "venues": 2,
        "organisersResolved": 5,
        "organisersUnresolved": 1,
        "linkInBio": 1,
        "droppedNaiveTime": 2,
        "droppedOutsideTheWindow": 1,
    }
    for name in metrics:
        assert _NAME.fullmatch(name)


class Reply(BaseModel):
    title: str


def test_the_llm_memo_counts_hits_and_generations(tmp_path: Path) -> None:
    memo = LLMMemo(tmp_path / "llm")
    with fetch_stats.activate("termcards") as stats:
        assert memo.get("cards_v1", "k1", Reply) is None
        memo.put("cards_v1", "k1", Reply(title="Quiz"), "bulk-model-1")
        assert memo.get("cards_v1", "k1", Reply) is not None
        assert memo.get("cards_v1", "k1", Reply) is not None
    assert stats.metrics() == {"llmCacheHits": 2, "llmGenerations": 1}
