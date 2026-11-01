"""Reads every department-registry source once and reports what it gave:
``pixi run pipeline -- talks-verify [--only <dept-key>] [--json PATH]``, or
``python -m camsocs_pipeline.talks.verify``.

Each source is fetched through the polite client (``general`` purpose:
robots.txt holds, one request in flight per host, Crawl-delay honoured) and
parsed with `talks.sites.read` over the next `HORIZON_DAYS` days. One line per
source: the department and source index, the kind, ``ok`` / ``empty`` /
``error``, the number of upcoming talks parsed, the pages and detail pages
read, what was dropped and why, and the error. Nothing else.

**Aggregates only.** The report never prints a title, a speaker or a page's
text, only counts, ids and status codes: several department sites ask AI
agents not to read them (robots.txt names them), and this report is what an
agent building the registry reads (spec §1). ``--json`` writes the same facts
for `docs/talks-coverage.md`.

Sources on different hosts run in parallel threads (`WORKERS`); the client
keeps each host to one request at a time.
"""

from __future__ import annotations

import json
import sys
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from camsocs_pipeline.events.common import EventWindow, default_window
from camsocs_pipeline.talks.registry import Department, DepartmentSource, load_registry
from camsocs_pipeline.talks.sites import SourceError, read
from camsocs_pipeline.talks.sites.common import Client

HORIZON_DAYS = 70
WORKERS = 8


@dataclass
class SourceCheck:
    department: str
    index: int
    kind: str
    url: str
    status: str
    upcoming: int = 0
    talks_cam_ids: int = 0
    pages: int = 0
    details: int = 0
    dropped: dict[str, int] = field(default_factory=dict)
    notes: int = 0
    shape: str | None = None
    says_empty: bool = False
    error: str | None = None

    def line(self) -> str:
        dropped = ", ".join(f"{k} {v}" for k, v in sorted(self.dropped.items()))
        parts = [
            f"{self.department}#{self.index}",
            self.kind,
            self.status,
            f"upcoming={self.upcoming}",
            f"tcids={self.talks_cam_ids}",
            f"pages={self.pages}",
            f"details={self.details}",
        ]
        if dropped:
            parts.append(f"dropped=[{dropped}]")
        if self.shape:
            parts.append(f"shape={self.shape}")
        if self.says_empty:
            parts.append("says_empty")
        if self.notes:
            parts.append(f"detail_failures={self.notes}")
        if self.error:
            parts.append(f"error={self.error}")
        return " ".join(parts)


def check_source(
    dept: Department, index: int, source: DepartmentSource, client: Client, window: EventWindow
) -> SourceCheck:
    check = SourceCheck(dept.key, index, source.kind, source.url, "error")
    try:
        result = read(dept, source, client, window)
    except (SourceError, NotImplementedError, ValueError) as error:
        check.error = _short(str(error))
        return check
    except Exception as error:  # a parser bug must not stop the whole report
        check.error = _short(f"{type(error).__name__}: {error}")
        return check
    upcoming = [r for r in result.records if r.starts_at >= window.start]
    check.status = "ok" if upcoming else "empty"
    check.upcoming = len(upcoming)
    check.talks_cam_ids = sum(1 for r in upcoming if r.talks_cam_id)
    check.pages = result.pages
    check.details = result.details
    check.dropped = dict(result.dropped)
    check.notes = len(result.notes)
    check.shape = result.shape
    check.says_empty = result.says_empty
    return check


def _short(text: str, limit: int = 160) -> str:
    """An error line without page text: outcome, status, URL (`SourceError`)."""
    line = " ".join(text.split())
    return line if len(line) <= limit else line[: limit - 1] + "…"


def verify(
    departments: Sequence[Department],
    client: Client,
    *,
    now: datetime | None = None,
    workers: int = WORKERS,
) -> list[SourceCheck]:
    window = default_window(now, lookback_days=0, horizon_days=HORIZON_DAYS)
    jobs = [(d, i, s) for d in departments for i, s in enumerate(d.sources)]
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        futures = [pool.submit(check_source, d, i, s, client, window) for d, i, s in jobs]
        return [f.result() for f in futures]


def summary(checks: Sequence[SourceCheck]) -> str:
    ok = sum(1 for c in checks if c.status == "ok")
    empty = sum(1 for c in checks if c.status == "empty")
    errors = sum(1 for c in checks if c.status == "error")
    talks = sum(c.upcoming for c in checks)
    return f"{len(checks)} sources: {ok} ok, {empty} empty, {errors} errors; {talks} upcoming talks"


def run(
    client: Client,
    *,
    only: str | None = None,
    json_path: Path | None = None,
    echo=print,
) -> list[SourceCheck]:
    departments = load_registry()
    if only:
        departments = [d for d in departments if d.key == only]
        if not departments:
            raise ValueError(f"no department {only!r} in the registry")
    checks = verify(departments, client)
    for check in checks:
        echo(check.line())
    echo(summary(checks))
    if json_path is not None:
        payload = {
            "checkedAt": datetime.now(UTC).isoformat(timespec="seconds"),
            "sources": [asdict(c) for c in checks],
        }
        json_path.parent.mkdir(parents=True, exist_ok=True)
        json_path.write_text(json.dumps(payload, indent=1) + "\n", encoding="utf-8")
    return checks


def main(argv: Sequence[str] | None = None) -> int:
    import argparse

    from camsocs_pipeline.config import get_settings
    from camsocs_pipeline.events.common import polite_client

    parser = argparse.ArgumentParser(prog="talks-verify", description=__doc__.split("\n\n")[0])
    parser.add_argument("--only", metavar="DEPT_KEY")
    parser.add_argument("--json", type=Path, dest="json_path")
    args = parser.parse_args(argv)
    with polite_client(get_settings()) as client:
        checks = run(client, only=args.only, json_path=args.json_path)
    return 1 if any(c.status == "error" for c in checks) else 0


if __name__ == "__main__":
    sys.exit(main())
