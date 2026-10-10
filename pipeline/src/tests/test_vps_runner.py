"""The VPS runner (decision D5, docs/ops-vps.md): `ops/vps/camsocs-harvest.sh`
end to end against a real local git origin, with `pixi`, `flock` and `timeout`
replaced by shims that record their arguments, and `camsocs-status.py`.

No network, no systemd: what the script does with the checkout, which
commands it runs with which limits, its exit codes and the status file it
leaves.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

REPO = Path(__file__).resolve().parents[3]
HARVEST = REPO / "ops" / "vps" / "camsocs-harvest.sh"

#: Git without the developer's own configuration (signing, hooks, templates).
GIT_ENV = {
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_AUTHOR_NAME": "camsocs test",
    "GIT_AUTHOR_EMAIL": "test@example.org",
    "GIT_COMMITTER_NAME": "camsocs test",
    "GIT_COMMITTER_EMAIL": "test@example.org",
}

SHIMS = {
    # Records its arguments; `install` and `run` exit as the test says; `run`
    # writes the summary the test gives to the path after --summary-json.
    "pixi": r"""#!/usr/bin/env bash
echo "pixi $*" >>"$SHIM_CALLS"
case "$1" in
  install) exit "${SHIM_INSTALL_EXIT:-0}" ;;
  run)
    case " $* " in *" prune-cache "*) exit "${SHIM_PRUNE_EXIT:-0}" ;; esac
    previous=""
    for argument in "$@"; do
      if [[ "$previous" == "--summary-json" && -n "${SHIM_SUMMARY:-}" ]]; then
        printf '%s' "$SHIM_SUMMARY" >"$argument"
      fi
      previous="$argument"
    done
    echo "pipeline output line"
    sleep "${SHIM_RUN_SLEEP:-0}"
    exit "${SHIM_RUN_EXIT:-0}"
    ;;
esac
""",
    "flock": r"""#!/usr/bin/env bash
echo "flock $*" >>"$SHIM_CALLS"
exit "${SHIM_FLOCK_EXIT:-0}"
""",
    # GNU timeout's interface: options, the duration, then the command. The
    # test's SHIM_TIMEOUT_EXIT ends the pipeline run, SHIM_GIT_TIMEOUT_EXIT git.
    "timeout": r"""#!/usr/bin/env bash
echo "timeout $*" >>"$SHIM_CALLS"
case " $* " in
  *" sync "*) if [[ -n "${SHIM_TIMEOUT_EXIT:-}" ]]; then exit "$SHIM_TIMEOUT_EXIT"; fi ;;
  *" git "*) if [[ -n "${SHIM_GIT_TIMEOUT_EXIT:-}" ]]; then exit "$SHIM_GIT_TIMEOUT_EXIT"; fi ;;
esac
while [[ "$1" == --* ]]; do shift; done
shift
exec "$@"
""",
}

SUMMARY = {
    "group": "events",
    "environment": "prod",
    "runKey": "20261010T033000Z-abcdef",
    "command": "sync --group events",
    "ok": True,
    "error": None,
    "warnings": [],
    "stages": [
        {"name": "calendar_feeds", "status": "ok", "inserted": 219},
        {"name": "report", "status": "ok", "metrics": {"listed": 793}},
    ],
    "summary": [
        "calendar_feeds: 219 new, 0 updated, 0 unchanged, 0 skipped",
        "report: nothing to do",
    ],
    "coverage": {"listed": 793, "counterparts": 168, "upcomingEvents": 533},
}


def git(*args: str, cwd: Path) -> str:
    done = subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
        env={**os.environ, **GIT_ENV},
    )
    return done.stdout.strip()


class Host:
    """A checkout of a local origin, the state and log directories, and shims."""

    def __init__(self, tmp: Path) -> None:
        self.tmp = tmp
        self.seed = tmp / "seed"
        self.origin = tmp / "origin.git"
        self.root = tmp / "opt-camsocs"
        self.state = tmp / "var-lib-camsocs"
        self.logs = tmp / "var-log-camsocs"
        self.bin = tmp / "bin"
        self.calls_file = tmp / "calls.txt"
        self.seed.mkdir()
        git("init", "-q", cwd=self.seed)
        git("checkout", "-q", "-b", "main", cwd=self.seed)
        self.first = self.commit("first")
        git("clone", "-q", "--bare", str(self.seed), str(self.origin), cwd=tmp)
        git("remote", "add", "origin", str(self.origin), cwd=self.seed)
        git("clone", "-q", "--branch", "main", str(self.origin), str(self.root), cwd=tmp)
        self.bin.mkdir()
        for name, body in SHIMS.items():
            path = self.bin / name
            path.write_text(body)
            path.chmod(0o755)

    def commit(self, message: str) -> str:
        (self.seed / "pixi.toml").write_text(f"# {message}\n")
        git("add", "pixi.toml", cwd=self.seed)
        git("commit", "-q", "-m", message, cwd=self.seed)
        return git("rev-parse", "HEAD", cwd=self.seed)

    def push(self, message: str) -> str:
        sha = self.commit(message)
        git("push", "-q", "origin", "main", cwd=self.seed)
        return sha

    def head(self) -> str:
        return git("rev-parse", "HEAD", cwd=self.root)

    def run(self, *args: str, **shim: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["bash", str(HARVEST), *args],
            env=self.env(**shim),
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )

    def env(self, **shim: str) -> dict[str, str]:
        return {
            **os.environ,
            **GIT_ENV,
            "PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}",
            "CAMSOCS_ROOT": str(self.root),
            "CAMSOCS_STATE_DIR": str(self.state),
            "CAMSOCS_LOG_DIR": str(self.logs),
            "CAMSOCS_PYTHON": sys.executable,
            "INVOCATION_ID": "invocation-1",
            "SHIM_CALLS": str(self.calls_file),
            **shim,
        }

    def calls(self) -> list[str]:
        return self.calls_file.read_text().splitlines() if self.calls_file.exists() else []

    def status(self, group: str) -> dict:
        return json.loads((self.state / f"status-{group}.json").read_text())

    def log(self, group: str) -> str:
        day = datetime.now(ZoneInfo("Europe/London")).strftime("%Y-%m-%d")
        return (self.logs / f"{day}-{group}.log").read_text()


@pytest.fixture
def host(tmp_path: Path) -> Host:
    return Host(tmp_path)


def test_a_daily_run_pulls_installs_runs_and_records_its_status(host: Host) -> None:
    new = host.push("second")

    done = host.run("events", SHIM_SUMMARY=json.dumps(SUMMARY))

    assert done.returncode == 0, done.stdout + done.stderr
    assert host.head() == new
    manifest = f"--manifest-path {host.root}/pixi.toml"
    summary = host.state / "run-events.json"
    run = f"pixi run --locked {manifest} pipeline -- --env prod sync --group events"
    prune = f"pixi run --locked {manifest} pipeline -- --env prod prune-cache"
    assert host.calls() == [
        "flock -n 9",
        # git and pixi have limits too: a hung pull never holds the lock.
        "timeout --kill-after=1m 15m git pull --ff-only --quiet origin main",
        f"timeout --kill-after=1m 30m pixi install --locked {manifest}",
        f"pixi install --locked {manifest}",  # what timeout ran
        f"timeout --kill-after=10m 2h {run} --summary-json {summary}",
        f"{run} --summary-json {summary}",
        # Retention after every run, the daily one too (R7, R4).
        f"timeout --kill-after=1m 30m {prune}",
        prune,
    ]
    status = host.status("events")
    assert status == json.loads((host.state / "status.json").read_text())
    assert status["group"] == "events" and status["environment"] == "prod"
    assert (status["exitCode"], status["result"], status["phase"]) == (0, "ok", "done")
    assert status["commit"] == new[:12]
    assert status["runKey"] == SUMMARY["runKey"]
    assert status["summary"] == SUMMARY["summary"]
    assert status["coverage"] == SUMMARY["coverage"]
    assert status["failedStages"] == []
    assert status["invocationId"] == "invocation-1"
    assert status["startedAt"] <= status["finishedAt"]
    assert (host.state / "last-good-commit").read_text().strip() == new
    log = host.log("events")
    assert "pipeline output line" in log and "finished with exit code 0" in log
    assert "update:" in done.stdout, "the script's own lines reach the journal"


def test_the_weekly_run_has_six_hours_and_prunes_the_cache(host: Host) -> None:
    done = host.run("full", SHIM_SUMMARY=json.dumps(SUMMARY | {"group": "full"}))

    assert done.returncode == 0, done.stdout + done.stderr
    calls = [call for call in host.calls() if call.startswith(("flock", "timeout"))]
    assert calls[0] == "flock -w 10800 9", "the weekly run waits for a daily one"
    assert calls[3].startswith("timeout --kill-after=10m 6h pixi run --locked")
    assert calls[3].endswith(f"sync --group full --summary-json {host.state}/run-full.json")
    assert calls[4] == (
        f"timeout --kill-after=1m 30m pixi run --locked --manifest-path {host.root}/pixi.toml "
        "pipeline -- --env prod prune-cache"
    )
    assert host.status("full")["phase"] == "done"


def test_a_weekly_run_that_cannot_have_the_lock_fails_and_alerts(host: Host) -> None:
    done = host.run("full", SHIM_FLOCK_EXIT="1")
    assert done.returncode == 75, "non-zero: OnFailure= sends the alert"
    assert host.calls() == ["flock -w 10800 9"], "nothing else ran"
    status = host.status("full")
    assert (status["exitCode"], status["result"], status["phase"]) == (75, "failed", "lock")
    assert status["invocationId"] == "invocation-1"
    assert "did not start" in host.log("full")


def test_a_hung_pull_is_cut_off_and_fails_the_update(host: Host) -> None:
    before = host.head()
    host.push("second")
    done = host.run("events", SHIM_GIT_TIMEOUT_EXIT="124")
    assert done.returncode == 10
    assert host.head() == before
    assert host.status("events")["phase"] == "update"


def test_a_failed_pull_stops_the_run_and_keeps_the_checkout(host: Host) -> None:
    before = host.head()
    host.push("unreachable")
    git("remote", "set-url", "origin", str(host.tmp / "gone.git"), cwd=host.root)
    host.state.mkdir()
    (host.state / "run-events.json").write_text(json.dumps(SUMMARY))  # an earlier run's

    done = host.run("events")

    assert done.returncode == 10
    assert host.head() == before
    assert not any(call.startswith("pixi") for call in host.calls())
    status = host.status("events")
    assert (status["result"], status["phase"]) == ("failed", "update")
    assert status["summary"] == [] and status["runKey"] is None, "no earlier run's summary"
    assert not (host.state / "last-good-commit").exists()


def test_an_environment_that_does_not_install_puts_the_checkout_back(host: Host) -> None:
    before = host.head()
    host.push("broken lock file")

    done = host.run("events", SHIM_INSTALL_EXIT="1")

    assert done.returncode == 11
    assert host.head() == before
    assert git("symbolic-ref", "--short", "HEAD", cwd=host.root) == "main"
    installs = [call for call in host.calls() if call.startswith("pixi install")]
    assert len(installs) == 2, "the new commit's, then the previous one's again"
    assert not any(" sync " in call for call in host.calls()), "the pipeline never ran"
    assert host.status("events")["phase"] == "install"


def test_a_failed_stage_fails_the_run_with_the_pipelines_exit_code(host: Host) -> None:
    failed = SUMMARY | {
        "ok": False,
        "stages": [{"name": "calendar_feeds", "status": "failed"}, {"name": "load"}],
    }

    done = host.run("events", SHIM_RUN_EXIT="1", SHIM_SUMMARY=json.dumps(failed))

    assert done.returncode == 1
    status = host.status("events")
    assert (status["result"], status["phase"]) == ("failed", "pipeline")
    assert status["failedStages"] == ["calendar_feeds"]
    assert not (host.state / "last-good-commit").exists()


def test_a_run_over_its_limit_is_recorded_as_timed_out(host: Host) -> None:
    done = host.run("events", SHIM_TIMEOUT_EXIT="124")
    assert done.returncode == 124
    status = host.status("events")
    assert (status["result"], status["phase"]) == ("timed_out", "pipeline")
    assert "timed out after 2h" in host.log("events")


def test_a_run_systemd_stops_is_recorded_as_stopped(host: Host) -> None:
    import signal
    import time

    process = subprocess.Popen(
        ["bash", str(HARVEST), "events"],
        env=host.env(SHIM_RUN_SLEEP="3"),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    deadline = time.monotonic() + 30
    while not any(call.startswith("timeout") for call in host.calls()):
        assert time.monotonic() < deadline, "the pipeline never started"
        time.sleep(0.05)
    process.send_signal(signal.SIGTERM)
    assert process.wait(timeout=30) == 143
    status = host.status("events")
    assert (status["exitCode"], status["result"], status["phase"]) == (143, "stopped", "stopped")


def test_a_prune_that_fails_after_a_good_run_fails_the_run(host: Host) -> None:
    done = host.run("full", SHIM_PRUNE_EXIT="1")
    assert done.returncode == 12
    assert host.status("full")["phase"] == "prune"


def test_a_held_lock_skips_the_daily_tick_quietly(host: Host) -> None:
    done = host.run("events", SHIM_FLOCK_EXIT="1")
    assert done.returncode == 0
    assert host.calls() == ["flock -n 9"]
    assert not (host.state / "status-events.json").exists()
    assert "skipping this tick" in host.log("events")


def test_a_pinned_commit_is_checked_out_instead_of_pulling(host: Host) -> None:
    host.push("second")
    host.state.mkdir()
    (host.state / "pin").write_text(f"{host.first}\n")

    done = host.run("events")

    assert done.returncode == 0, done.stdout + done.stderr
    assert host.head() == host.first
    # The pin removed, the next run is back on main at the newest commit.
    (host.state / "pin").unlink()
    assert host.run("events").returncode == 0
    assert git("symbolic-ref", "--short", "HEAD", cwd=host.root) == "main"
    assert host.head() == git("rev-parse", "HEAD", cwd=host.seed)


@pytest.mark.parametrize("args", [(), ("daily",), ("events", "full")])
def test_anything_but_one_group_is_a_usage_error(host: Host, args: tuple[str, ...]) -> None:
    done = host.run(*args)
    assert done.returncode == 64
    assert "usage" in done.stderr
    assert host.calls() == []


# --- the installer's revision: root installs only what it fetched itself ---------------

INSTALL = REPO / "ops" / "vps" / "install.sh"
OPS_FILES = (
    "camsocs-harvest.sh",
    "camsocs-alert.py",
    "camsocs-status.py",
    "install.sh",
    "logrotate/camsocs",
    "systemd/camsocs-harvest@.service",
    "systemd/camsocs-alert@.service",
)


def _fetch(tmp: Path, origin: Path, revision: str) -> subprocess.CompletedProcess[str]:
    """Runs install.sh's `fetch_revision` against a local origin, with root's
    `install -o root` replaced (the test is no root) and GNU timeout too."""
    script = f"""
set -euo pipefail
source "{INSTALL}"
install() {{ mkdir -p "${{@: -1}}"; }}
timeout() {{ while [[ "$1" == --* ]]; do shift; done; shift; "$@"; }}
REPO_URL="{origin}"
MIRROR="{tmp}/mirror/camsocs.git"
WORK="{tmp}/work"
mkdir -p "$WORK"
fetch_revision "$1"
cat "$REV_DIR/camsocs-harvest.sh"
"""
    return subprocess.run(
        ["bash", "-c", script, "_", revision],
        capture_output=True,
        text=True,
        env={**os.environ, **GIT_ENV},
        check=False,
        timeout=60,
    )


def test_the_installer_extracts_a_reviewed_commit_of_main_from_its_own_mirror(
    tmp_path: Path,
) -> None:
    seed = tmp_path / "seed"
    seed.mkdir()
    git("init", "-q", cwd=seed)
    git("checkout", "-q", "-b", "main", cwd=seed)
    for name in OPS_FILES:
        path = seed / "ops" / "vps" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"# reviewed {name}\n")
    git("add", ".", cwd=seed)
    git("commit", "-q", "-m", "reviewed", cwd=seed)
    reviewed = git("rev-parse", "HEAD", cwd=seed)
    # A commit that never reached main (a branch someone pushed).
    git("checkout", "-q", "-b", "other", cwd=seed)
    (seed / "ops" / "vps" / "camsocs-harvest.sh").write_text("# not reviewed\n")
    git("commit", "-q", "-am", "elsewhere", cwd=seed)
    elsewhere = git("rev-parse", "HEAD", cwd=seed)
    git("checkout", "-q", "main", cwd=seed)
    origin = tmp_path / "origin.git"
    git("clone", "-q", "--bare", str(seed), str(origin), cwd=tmp_path)

    done = _fetch(tmp_path, origin, reviewed)
    assert done.returncode == 0, done.stderr
    assert done.stdout.strip().endswith("# reviewed camsocs-harvest.sh")

    refused = _fetch(tmp_path, origin, elsewhere)
    assert refused.returncode != 0
    assert "is not on main" in refused.stderr or "is not a commit" in refused.stderr
