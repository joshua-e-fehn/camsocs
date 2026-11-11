"""The request job runner (ENG-158): carries out a plan the broker confirmed.

Confirming a listing request whose plan reads the society's events page
(`webapp/convex/broker/listingRequests.ts`, `acceptCorrections` with
`readEvents`) applies the website at once, keeps it for the scraper
(`websiteSources`) and queues a job on the request. Every minute
(`camsocs-request-jobs.timer`, `camsocs request-jobs`) this runner asks Convex
for the oldest job (`POST /api/pipeline/requests/jobs/next`) and, when there
is one:

1. takes the harvest lock without waiting (`$CAMSOCS_STATE_DIR/harvest.lock`,
   the lock of `ops/vps/camsocs-harvest.sh`): politeness holds only inside
   one run, and a job never runs next to a harvest. It does not start in the
   half hour before a scheduled harvest either, because the daily run skips
   its tick when the lock is held;
2. claims the job (which counts a try) and runs `website_events` for that one
   organisation, then `load`: every other site's staged events are carried
   forward untouched, and the load posts the latest of everything, as after
   a daily run;
3. reports to `POST /api/pipeline/requests/job`: the upcoming events staged
   for the organisation (titles and start times), or the failed stage's
   name. Convex queues a failed job again, three tries in all.

The request then shows the result on the dashboard, and the broker closes it.
Nothing here logs a request's text; a job carries only a request key, an
organisation key and a website.
"""

from __future__ import annotations

import fcntl
import logging
import os
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Protocol
from zoneinfo import ZoneInfo

from camsocs_pipeline.config import ConfigError, Settings
from camsocs_pipeline.models.observation import EventObservation
from camsocs_pipeline.pipeline.load import ConvexError
from camsocs_pipeline.pipeline.report import RunReport
from camsocs_pipeline.pipeline.sync import run_sync
from camsocs_pipeline.request_site import MAX_EVENTS, upcoming
from camsocs_pipeline.staging.store import StagingStore, events_directory

logger = logging.getLogger(__name__)

#: The stages a job runs, in registry order.
JOB_STAGES = ("website_events", "load")
#: Scheduled harvests, London time (`ops/vps/systemd/camsocs-harvest-*.timer`):
#: the daily events run, and the weekly full run on Sundays (weekday 6).
LONDON = ZoneInfo("Europe/London")
DAILY_HARVEST = (4, 30)
WEEKLY_HARVEST = (6, 2, 0)
#: A job does not start this long before one of them.
QUIET_BEFORE = timedelta(minutes=30)


class Poster(Protocol):
    def post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]: ...


def default_lock_path() -> Path:
    return Path(os.environ.get("CAMSOCS_STATE_DIR", "/var/lib/camsocs")) / "harvest.lock"


def harvest_soon(now: datetime) -> bool:
    """Whether a scheduled harvest starts within `QUIET_BEFORE` of `now`."""
    now = now.astimezone(LONDON)
    daily = now.replace(hour=DAILY_HARVEST[0], minute=DAILY_HARVEST[1], second=0, microsecond=0)
    if daily < now:
        daily += timedelta(days=1)
    weekday, hour, minute = WEEKLY_HARVEST
    weekly = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    weekly += timedelta(days=(weekday - now.weekday()) % 7)
    if weekly < now:
        weekly += timedelta(days=7)
    return min(daily, weekly) - now <= QUIET_BEFORE


@contextmanager
def harvest_lock(path: Path) -> Iterator[bool]:
    """The harvest's lock, taken without waiting: yields whether it is held.
    Where the lock's directory does not exist (a developer's machine) there
    is no harvest to collide with, and the job runs unlocked."""
    if not path.parent.is_dir():
        yield True
        return
    with path.open("a") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
            return
        try:
            yield True
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def staged_events(settings: Settings, org_key: str) -> list[dict[str, Any]]:
    """The upcoming events staged from `org_key`'s own website, soonest first."""
    staging = StagingStore(settings.staging_dir)
    records = [
        record
        for record in staging.read_latest(events_directory("society_website"))
        if isinstance(record, EventObservation)
        and any(o.identity.known_key == org_key for o in record.organisers)
    ]
    return upcoming(records)


def _failure(report: RunReport) -> str:
    failed = [stage.name for stage in report.stages if not stage.ok]
    return f"stage {failed[0]} failed" if failed else "run failed"


Runner = Callable[..., RunReport]


def run_job(
    loader: Poster,
    settings: Settings,
    *,
    lock_path: Path | None = None,
    now: datetime | None = None,
    runner: Runner = run_sync,
) -> str:
    """One round: at most one job. Returns a line for the journal."""
    now = now or datetime.now(UTC)
    if (loader.post("requests/jobs/next", {"claim": False}).get("job")) is None:
        return "no job"
    if harvest_soon(now):
        return "a job waits: a scheduled harvest starts within half an hour"
    with harvest_lock(lock_path or default_lock_path()) as held:
        if not held:
            return "a job waits: a harvest holds the lock"
        job = loader.post("requests/jobs/next", {"claim": True}).get("job")
        if job is None:
            return "no job"
        key, org_key = job["key"], job["orgKey"]
        try:
            report = runner(
                settings=settings, stages=list(JOB_STAGES), only_orgs=frozenset({org_key})
            )
        except (ConfigError, ConvexError, ValueError) as error:
            logger.warning("request job did not start (%s)", type(error).__name__)
            loader.post("requests/job", {"key": key, "ok": False, "error": type(error).__name__})
            return f"job for {org_key}: failed before any stage"
        if not report.ok:
            loader.post("requests/job", {"key": key, "ok": False, "error": _failure(report)})
            return f"job for {org_key}: {_failure(report)}"
        events = staged_events(settings, org_key)
        loader.post(
            "requests/job",
            {
                "key": key,
                "ok": True,
                "eventCount": len(events),
                "events": [
                    {"title": event["title"], "startsAt": event["startsAt"]}
                    for event in events[:MAX_EVENTS]
                ],
            },
        )
        return f"job for {org_key}: done, {len(events)} upcoming events staged"
