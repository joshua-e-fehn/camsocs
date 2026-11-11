"""The request job runner (ENG-158, `request_jobs.py`): one confirmed plan a
round, never next to a harvest, reported on the request. Fictional data."""

from __future__ import annotations

import fcntl
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from camsocs_pipeline.models.observation import EventObservation
from camsocs_pipeline.pipeline.load import ConvexError
from camsocs_pipeline.pipeline.report import RunReport
from camsocs_pipeline.request_jobs import JOB_STAGES, harvest_soon, run_job, staged_events
from camsocs_pipeline.staging.store import StagingStore
from tests.test_request_agent import _unit

NOON = datetime(2026, 11, 11, 12, 0, tzinfo=UTC)
JOB = {"key": "lr-0123456789abcdef0123", "orgKey": "org-chess", "website": "https://c.example.org/"}


class FakeLoader:
    def __init__(self, job: dict[str, Any] | None) -> None:
        self.job = job
        self.posts: list[tuple[str, dict[str, Any]]] = []

    def post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        self.posts.append((path, payload))
        return {"job": self.job} if path == "requests/jobs/next" else {"ok": True}


class Runner:
    """Stands in for `run_sync`: records its call and returns a report."""

    def __init__(self, *, failed: str | None = None, error: Exception | None = None) -> None:
        self.failed, self.error = failed, error
        self.calls: list[dict[str, Any]] = []

    def __call__(self, **kwargs: Any) -> RunReport:
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        report = RunReport(run_key="20261111T120000Z-abcdef", command="sync", dry_run=False)
        for name in kwargs["stages"]:
            stage = report.stage(name)
            if name == self.failed:
                stage.status = "failed"
        return report


def event(org_key: str, title: str, starts_at: int) -> EventObservation:
    from camsocs_pipeline.claims import parser_field
    from camsocs_pipeline.models.observation import IdentityHints, OrganiserObs

    return EventObservation(
        source_type="society_website",
        source_key=f"{org_key}:{title}",
        source_url="https://c.example.org/events",
        retrieved_at=NOON,
        event_source="website",
        external_id=f"{org_key}:{title}",
        visibility="public",
        organisers=[OrganiserObs(identity=IdentityHints(name="x", known_key=org_key))],
        fields=[
            parser_field("title", title, extractor="t", evidence="primary"),
            parser_field("startsAt", starts_at, extractor="t", evidence="primary"),
        ],
    )


def test_no_job_ends_the_round_without_the_lock(tmp_path: Path, make_settings) -> None:
    loader, runner = FakeLoader(None), Runner()
    assert run_job(loader, make_settings(), lock_path=tmp_path / "l", now=NOON, runner=runner) == (
        "no job"
    )
    assert loader.posts == [("requests/jobs/next", {"claim": False})]
    assert runner.calls == []


def test_a_job_reads_one_societys_site_loads_and_reports(tmp_path: Path, make_settings) -> None:
    settings = make_settings()
    staging = StagingStore(settings.staging_dir)
    staging.write(
        "society_website.events",
        "20261111T120000Z-abcdef",
        [
            event("org-chess", "Blitz night", 1_800_000_200_000),
            event("org-chess", "Open evening", 1_800_000_100_000),
            event("org-go", "Someone else's", 1_800_000_000_000),
        ],
    )
    loader, runner = FakeLoader(JOB), Runner()
    line = run_job(loader, settings, lock_path=tmp_path / "harvest.lock", now=NOON, runner=runner)
    assert line == "job for org-chess: done, 2 upcoming events staged"
    assert runner.calls == [
        {"settings": settings, "stages": list(JOB_STAGES), "only_orgs": frozenset({"org-chess"})}
    ]
    assert [path for path, _ in loader.posts] == [
        "requests/jobs/next",
        "requests/jobs/next",
        "requests/job",
    ]
    assert loader.posts[1][1] == {"claim": True}
    assert loader.posts[2][1] == {
        "key": JOB["key"],
        "ok": True,
        "eventCount": 2,
        "events": [
            {"title": "Open evening", "startsAt": 1_800_000_100_000},
            {"title": "Blitz night", "startsAt": 1_800_000_200_000},
        ],
    }
    assert [e["title"] for e in staged_events(settings, "org-go")] == ["Someone else's"]


def test_a_failed_stage_or_start_is_reported_by_name_or_class(
    tmp_path: Path, make_settings
) -> None:
    loader = FakeLoader(JOB)
    line = run_job(
        loader, make_settings(), lock_path=tmp_path / "l", now=NOON, runner=Runner(failed="load")
    )
    assert line == "job for org-chess: stage load failed"
    assert loader.posts[-1] == (
        "requests/job",
        {"key": JOB["key"], "ok": False, "error": "stage load failed"},
    )
    loader = FakeLoader(JOB)
    run_job(
        loader,
        make_settings(),
        lock_path=tmp_path / "l",
        now=NOON,
        runner=Runner(error=ConvexError("401 with a key in it")),
    )
    assert loader.posts[-1][1] == {"key": JOB["key"], "ok": False, "error": "ConvexError"}
    # Whatever stops the run, the job is reported (and queued again), not left running.
    loader = FakeLoader(JOB)
    run_job(
        loader,
        make_settings(),
        lock_path=tmp_path / "l",
        now=NOON,
        runner=Runner(error=OSError("disk full")),
    )
    assert loader.posts[-1][1] == {"key": JOB["key"], "ok": False, "error": "OSError"}


def test_a_job_waits_for_a_running_or_imminent_harvest(tmp_path: Path, make_settings) -> None:
    lock = tmp_path / "harvest.lock"
    loader, runner = FakeLoader(JOB), Runner()
    with lock.open("a") as held:
        fcntl.flock(held, fcntl.LOCK_EX)
        line = run_job(loader, make_settings(), lock_path=lock, now=NOON, runner=runner)
    assert line == "a job waits: a harvest holds the lock"
    # Not claimed, so no try was counted.
    assert loader.posts == [("requests/jobs/next", {"claim": False})]

    loader = FakeLoader(JOB)
    soon = datetime(2026, 11, 12, 4, 10, tzinfo=UTC)
    line = run_job(loader, make_settings(), lock_path=lock, now=soon, runner=runner)
    assert line.startswith("a job waits: a scheduled harvest")
    assert runner.calls == []


def test_the_quiet_time_follows_the_timers_in_london_time() -> None:
    assert harvest_soon(datetime(2026, 11, 12, 4, 10, tzinfo=UTC))  # daily 04:30 GMT
    assert not harvest_soon(datetime(2026, 11, 12, 4, 31, tzinfo=UTC))
    assert harvest_soon(datetime(2026, 11, 12, 3, 45, tzinfo=UTC))  # longer than a job may run
    assert not harvest_soon(datetime(2026, 11, 12, 3, 30, tzinfo=UTC))
    assert harvest_soon(datetime(2026, 7, 13, 3, 10, tzinfo=UTC))  # 04:30 BST is 03:30 UTC
    assert harvest_soon(datetime(2026, 11, 15, 1, 45, tzinfo=UTC))  # Sunday 02:00
    assert not harvest_soon(datetime(2026, 11, 14, 1, 45, tzinfo=UTC))  # a Saturday
    events = _unit("camsocs-harvest-events.timer")
    assert events["Timer.OnCalendar"] == ["*-*-* 04:30:00 Europe/London"]
    assert _unit("camsocs-harvest-full.timer")["Timer.OnCalendar"] == [
        "Sun *-*-* 02:00:00 Europe/London"
    ]


def test_the_unit_runs_the_command_as_camsocs_like_the_harvest() -> None:
    service = _unit("camsocs-request-jobs.service")
    assert service["Service.User"] == ["camsocs"]
    assert service["Service.ExecStart"][0].endswith("pipeline -- --env prod request-jobs")
    assert "--as-is" in service["Service.ExecStart"][0]
    assert service["Service.CapabilityBoundingSet"] == [""]
    assert "CAMSOCS_STATE_DIR=/var/lib/camsocs" in service["Service.Environment"]
    assert service["Service.ReadWritePaths"] == ["/opt/camsocs /var/lib/camsocs"]
    assert "Unit.OnFailure" not in service, "a failed job shows on the request instead"
    hidden = service["Service.InaccessiblePaths"][0].split()
    for path in ("-/docker", "-/run/docker.sock", "-/etc/camsocs", "-/var/log/camsocs"):
        assert path in hidden
    assert _unit("camsocs-request-jobs.timer")["Timer.OnUnitActiveSec"] == ["1min"]
