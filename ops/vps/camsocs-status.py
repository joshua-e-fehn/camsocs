#!/usr/bin/env python3
"""Write the VPS runner's status files (decision D5; docs/ops-vps.md "Status and logs").

    camsocs-status.py --state-dir /var/lib/camsocs --group events --env prod \\
        --started 2026-10-10T03:30:00Z --finished 2026-10-10T03:52:10Z \\
        --exit-code 0 --phase done --commit 0123456789ab \\
        --log /var/log/camsocs/2026-10-10-events.log \\
        --run-summary /var/lib/camsocs/run-events.json [--invocation ID]

`camsocs-harvest.sh` calls it on every exit once it holds the lock, and when
the weekly run could not have the lock at all (phase ``lock``). It writes
``<state-dir>/status-<group>.json`` (that group's latest run) and
``<state-dir>/status.json`` (the latest run of any group), each whole or not
at all (a temporary file renamed into place):

    {"group", "environment", "startedAt", "finishedAt", "exitCode",
     "result": "ok" | "failed" | "timed_out" | "stopped",
     "phase": "done" | "lock" | "update" | "install" | "pipeline" | "prune" | "script"
              | "stopped",
     "commit", "logFile", "invocationId",
     "runKey", "summary": [one line per stage], "failedStages", "warnings",
     "error", "coverage": {"listed", "counterparts", "upcomingEvents", "report"} | null}

The run's own part comes from the pipeline's ``--summary-json`` file; when the
pipeline never wrote one (the update failed, the run was killed) those fields
are empty. Standard library only, so it runs with the host's python3 even when
the pixi environment does not install.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

#: Exit codes with a name of their own (camsocs-harvest.sh's header).
TIMED_OUT = {124, 137}
STOPPED = {143}


def result_of(exit_code: int) -> str:
    if exit_code == 0:
        return "ok"
    if exit_code in TIMED_OUT:
        return "timed_out"
    if exit_code in STOPPED:
        return "stopped"
    return "failed"


def read_run_summary(path: Path | None) -> dict[str, Any]:
    """The pipeline's ``--summary-json`` output, or ``{}`` when there is none
    (or it cannot be read: the status file is still written)."""
    if path is None or not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def build_status(
    *,
    group: str,
    environment: str,
    started: str,
    finished: str,
    exit_code: int,
    phase: str,
    commit: str,
    log_file: str,
    run: dict[str, Any],
    invocation: str = "",
) -> dict[str, Any]:
    stages = run.get("stages") if isinstance(run.get("stages"), list) else []
    return {
        "group": group,
        "environment": environment,
        "startedAt": started,
        "finishedAt": finished,
        "exitCode": exit_code,
        "result": result_of(exit_code),
        "phase": phase,
        "commit": commit or None,
        "logFile": log_file,
        "invocationId": invocation or None,
        "runKey": run.get("runKey"),
        "summary": list(run.get("summary") or []),
        "failedStages": [
            stage.get("name")
            for stage in stages
            if isinstance(stage, dict) and stage.get("status") == "failed"
        ],
        "warnings": list(run.get("warnings") or []),
        "error": run.get("error"),
        "coverage": run.get("coverage"),
    }


def write_json(path: Path, payload: dict[str, Any]) -> None:
    """Whole or not at all: a reader (the alert, an operator) never sees half a file."""
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(payload, indent=1, ensure_ascii=False) + "\n", "utf-8")
    temporary.replace(path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--group", required=True)
    parser.add_argument("--env", default="prod")
    parser.add_argument("--started", required=True)
    parser.add_argument("--finished", required=True)
    parser.add_argument("--exit-code", type=int, required=True)
    parser.add_argument("--phase", required=True)
    parser.add_argument("--commit", default="")
    parser.add_argument("--log", default="")
    parser.add_argument("--run-summary", type=Path)
    parser.add_argument("--invocation", default="")
    args = parser.parse_args(argv)
    if not args.group.isidentifier():
        parser.error(f"not a group name: {args.group!r}")

    status = build_status(
        group=args.group,
        environment=args.env,
        started=args.started,
        finished=args.finished,
        exit_code=args.exit_code,
        phase=args.phase,
        commit=args.commit,
        log_file=args.log,
        run=read_run_summary(args.run_summary),
        invocation=args.invocation,
    )
    args.state_dir.mkdir(parents=True, exist_ok=True)
    write_json(args.state_dir / f"status-{args.group}.json", status)
    write_json(args.state_dir / "status.json", status)
    return 0


if __name__ == "__main__":
    sys.exit(main())
