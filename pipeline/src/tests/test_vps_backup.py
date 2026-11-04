"""The backup of Convex production (ENG-44, docs/ops-vps.md §10):
`ops/vps/camsocs-backup.py` against a fake Convex CLI and a fake local backend
that record what they were asked, with synthetic snapshots only; the alert's
backup messages; the installer's key check.

No network and no Convex: the fakes stand in for `convex export` / `convex
import` and for `convex-local-backend`. (The real CLI and backend were run
against each other by hand for ENG-44; docs/ops-vps.md §10 "Tested".)
"""

from __future__ import annotations

import importlib.util
import json
import os
import stat
import subprocess
import sys
import zipfile
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import ModuleType

import pytest

REPO = Path(__file__).resolve().parents[3]
OPS = REPO / "ops" / "vps"
#: A synthetic key of production's shape, assembled at run time (no
#: key-shaped literal in the repo).
KEY = "prod:cheerful-bandicoot-511|" + "e30" + "x" * 40
#: A marker in every synthetic document: it must never reach the journal.
MARKER = "Synthetic Person Example"


def script(name: str) -> ModuleType:
    """Import an ops script (its file name has hyphens) as a module."""
    module_name = name.replace("-", "_")
    spec = importlib.util.spec_from_file_location(module_name, OPS / f"{name}.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module  # dataclasses look their module up
    spec.loader.exec_module(module)
    return module


backup = script("camsocs-backup")
alert = script("camsocs-alert")


def documents(table: str, count: int) -> list[dict]:
    return [
        {"_id": f"{table[:2]}{i:04d}", "_creationTime": 1.7e12 + i, "name": f"{MARKER} {i}"}
        for i in range(count)
    ]


TABLES = {
    "people": documents("people", 30),
    "organisations": documents("organisations", 5),
    "talks": [],
    "_components/betterAuth/user": documents("user", 2),
    "_storage": [{"_id": "kg01", "_creationTime": 1.7e12, "sha256": "ab", "size": 4}],
}
FILES = {"_storage/kg01.png": b"\x89PNG"}


def snapshot(
    path: Path,
    tables: dict[str, list[dict]] | None = None,
    files: dict[str, bytes] | None = None,
    *,
    shuffle: bool = False,
) -> Path:
    """A ZIP in the layout `convex export` writes (README, _tables, one folder
    per table with documents.jsonl and generated_schema.jsonl, _storage)."""
    tables = TABLES if tables is None else tables
    files = FILES if files is None else files
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("README.md", "# Welcome to your Convex snapshot export!\n")
        archive.writestr("_tables/documents.jsonl", '{"name":"people","id":10001}\n')
        archive.writestr(
            "_components/betterAuth/_tables/documents.jsonl", '{"name":"user","id":10001}\n'
        )
        for name, rows in tables.items():
            ordered = list(reversed(rows)) if shuffle else rows
            lines = [
                json.dumps(row, indent=None if not shuffle else 1).replace("\n", "")
                for row in ordered
            ]
            archive.writestr(f"{name}/documents.jsonl", "".join(f"{line}\n" for line in lines))
            archive.writestr(f"{name}/generated_schema.jsonl", '"uniform"\n')
        for name, data in files.items():
            archive.writestr(name, data)
    return path


# --- fakes -------------------------------------------------------------------------------

FAKE_CONVEX = r"""#!/usr/bin/env python3
import json, os, shutil, sys, zipfile
state = os.environ["FAKE_STATE"]
args = sys.argv[1:]
with open(os.path.join(state, "calls.jsonl"), "a") as log:
    log.write(json.dumps({
        "args": args,
        "convexEnv": sorted(k for k in os.environ if k.startswith("CONVEX_")),
        "cwd": os.getcwd(),
    }) + "\n")
env_file = args[args.index("--env-file") + 1]
settings = dict(
    line.split("=", 1) for line in open(env_file).read().splitlines() if "=" in line
)
print("some CLI output")
if args[0] == "export":
    target = args[args.index("--path") + 1]
    if "CONVEX_DEPLOY_KEY" in settings:  # production
        if os.environ.get("FAKE_EXPORT_EXIT"):
            sys.exit(int(os.environ["FAKE_EXPORT_EXIT"]))
        shutil.copy(os.environ["FAKE_SNAPSHOT"], target)
    else:  # the restore test's own backend
        imported = open(os.path.join(state, "imported")).read()
        if os.environ.get("FAKE_TAMPER"):
            with zipfile.ZipFile(imported) as src, zipfile.ZipFile(target, "w") as dst:
                for info in src.infolist():
                    data = src.read(info)
                    if info.filename == "people/documents.jsonl":
                        data = data.replace(b"Example 1", b"Example X")
                    dst.writestr(info, data)
        else:
            shutil.copy(imported, target)
elif args[0] == "import":
    url = settings.get("CONVEX_SELF_HOSTED_URL", "")
    if "CONVEX_DEPLOY_KEY" in settings or not url.startswith("http://127.0.0.1:"):
        sys.exit(99)  # the restore test must only ever name its own backend
    open(os.path.join(state, "imported"), "w").write(args[-1])
    sys.exit(int(os.environ.get("FAKE_IMPORT_EXIT", "0")))
"""

FAKE_BACKEND = r"""#!/usr/bin/env python3
import http.server, json, os, signal, sys
args = sys.argv[1:]
if args[:2] == ["keygen", "admin-key"]:
    print("fake-admin-key")
    sys.exit(0)
if os.environ.get("FAKE_BACKEND_EXIT"):
    sys.exit(int(os.environ["FAKE_BACKEND_EXIT"]))
port = int(args[args.index("--port") + 1])
name = args[args.index("--instance-name") + 1]
with open(os.path.join(os.environ["FAKE_STATE"], "backend.json"), "w") as out:
    json.dump({"pid": os.getpid(), "interface": args[args.index("--interface") + 1]}, out)

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(name.encode())
    def log_message(self, *a):
        pass

signal.signal(signal.SIGTERM, lambda *a: sys.exit(0))
http.server.HTTPServer(("127.0.0.1", port), Handler).serve_forever()
"""


class Host:
    """A backup directory, a key file, the fakes, and the environment the
    units would give the script."""

    def __init__(self, tmp: Path) -> None:
        self.tmp = tmp
        self.dir = tmp / "var-lib-camsocs-backup"
        self.state = tmp / "fake-state"
        self.state.mkdir()
        self.tools = tmp / "tools"
        self.tools.mkdir()
        self.key = tmp / "backup.env"
        self.key.write_text(f"CONVEX_DEPLOY_KEY={KEY}\n")
        self.key.chmod(0o600)
        self.convex = self._executable("convex", FAKE_CONVEX)
        self.backend = self._executable("convex-local-backend", FAKE_BACKEND)
        self.snapshot = snapshot(tmp / "export.zip")
        self.env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "CAMSOCS_BACKUP_DIR": str(self.dir),
            "CAMSOCS_BACKUP_TOOLS": str(self.tools),
            "CAMSOCS_BACKUP_ENV": str(self.key),
            "CAMSOCS_CONVEX": str(self.convex),
            "CAMSOCS_LOCAL_BACKEND": str(self.backend),
            "CAMSOCS_BACKUP_MIN_FREE_MB": "1",
            "CAMSOCS_RESTORE_WORK": str(tmp),
            "FAKE_STATE": str(self.state),
            "FAKE_SNAPSHOT": str(self.snapshot),
            # Must never reach the CLI: the deployment comes from --env-file.
            "CONVEX_DEPLOY_KEY": "prod:someone-else-123|stray",
        }

    def _executable(self, name: str, text: str) -> Path:
        path = self.tmp / "bin" / name
        path.parent.mkdir(exist_ok=True)
        path.write_text(text)
        path.chmod(0o755)
        return path

    def run(self, *argv: str, **env: str) -> int:
        environ = {**self.env, **env}
        old = dict(os.environ)
        os.environ.clear()
        os.environ.update(environ)
        try:
            return backup.main(list(argv), environ)
        finally:
            os.environ.clear()
            os.environ.update(old)

    def calls(self) -> list[dict]:
        path = self.state / "calls.jsonl"
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text().splitlines()]

    def backups(self) -> list[str]:
        return sorted(p.name for p in self.dir.glob("convex-prod-*.zip"))


@pytest.fixture
def host(tmp_path: Path) -> Host:
    return Host(tmp_path)


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch):
    """`now_utc` that moves a day each time a backup starts."""
    moments = iter(datetime(2026, 11, 1, 1, 30, tzinfo=UTC) + timedelta(days=d) for d in range(60))
    current = {"now": next(moments)}

    def tick() -> None:
        current["now"] = next(moments)

    monkeypatch.setattr(backup, "now_utc", lambda: current["now"])
    return tick


# --- inspect ------------------------------------------------------------------------------


def test_a_snapshot_is_read_as_tables_with_counts_and_storage_with_files(tmp_path: Path) -> None:
    contents = backup.inspect(snapshot(tmp_path / "s.zip"))

    assert {name: t["documents"] for name, t in contents["tables"].items()} == {
        "_components/betterAuth/user": 2,
        "_storage": 1,
        "organisations": 5,
        "people": 30,
        "talks": 0,
    }
    assert contents["storage"] == {
        "_storage": {"files": 1, "digest": contents["storage"]["_storage"]["digest"]}
    }
    assert contents["documents"] == 38 and contents["files"] == 1
    # Names and numbers only: nothing of a document is in what it returns.
    assert MARKER not in json.dumps(contents)


def test_the_digest_ignores_order_and_formatting_but_not_content(tmp_path: Path) -> None:
    plain = backup.inspect(snapshot(tmp_path / "a.zip"))
    shuffled = backup.inspect(snapshot(tmp_path / "b.zip", shuffle=True))
    changed_rows = {**TABLES, "people": [*documents("people", 29), {"_id": "pe0029", "name": "x"}]}
    changed = backup.inspect(snapshot(tmp_path / "c.zip", changed_rows))

    assert plain["tables"] == shuffled["tables"]
    assert backup.compare(plain, shuffled) == []
    assert backup.compare(plain, changed) == ["people: 30 documents, but their content differs"]


@pytest.mark.parametrize(
    "member, data",
    [
        ("people/documents.jsonl", b"{not json\n"),
        ("people/documents.jsonl", b'{"name": "no id"}\n'),
        ("people/documents.jsonl", b'{"_id": "a"}\n{"_id": "a"}\n'),
        ("people/documents.jsonl", b'["a list"]\n'),
    ],
)
def test_a_snapshot_with_a_bad_document_is_refused(
    tmp_path: Path, member: str, data: bytes
) -> None:
    path = tmp_path / "bad.zip"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(member, data)
    with pytest.raises(backup.Failure) as raised:
        backup.inspect(path)
    assert raised.value.code == backup.BAD_SNAPSHOT


def test_a_damaged_or_foreign_file_is_refused(tmp_path: Path) -> None:
    good = snapshot(tmp_path / "s.zip")
    damaged = tmp_path / "damaged.zip"
    raw = bytearray(good.read_bytes())
    at = raw.find(b"Example 3")
    raw[at : at + 7] = b"EXAMPLE"  # same length, wrong CRC
    damaged.write_bytes(bytes(raw))
    foreign = tmp_path / "foreign.zip"
    foreign.write_text("not a zip")
    empty = tmp_path / "empty.zip"
    with zipfile.ZipFile(empty, "w") as archive:
        archive.writestr("README.md", "")

    for path in (damaged, foreign, empty):
        with pytest.raises(backup.Failure) as raised:
            backup.inspect(path)
        assert raised.value.code == backup.BAD_SNAPSHOT, path.name


# --- the key ------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        "CONVEX_DEPLOY_KEY=dev:hushed-rhinoceros-215|abc\n",
        "CONVEX_DEPLOY_KEY=prod:other-deployment-123|abc\n",
        "CONVEX_DEPLOY_KEY=preview:team:project|abc\n",
        f"CONVEX_DEPLOY_KEY={KEY}\nCONVEX_DEPLOYMENT=dev:hushed-rhinoceros-215\n",
        f"CONVEX_DEPLOY_KEY={KEY}\nCONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210\n",
        "CONVEX_DEPLOYMENT=prod:cheerful-bandicoot-511\n",
        "",
    ],
)
def test_only_productions_deploy_key_alone_is_accepted(tmp_path: Path, text: str) -> None:
    path = tmp_path / "backup.env"
    path.write_text(text)
    with pytest.raises(backup.Failure) as raised:
        backup.check_key_file(path, "cheerful-bandicoot-511")
    assert raised.value.code == backup.CONFIG
    assert "abc" not in str(raised.value)


def test_productions_key_is_accepted_with_comments_and_quotes(tmp_path: Path) -> None:
    path = tmp_path / "backup.env"
    path.write_text(f"# ENG-44 backup key\n\nCONVEX_DEPLOY_KEY='{KEY}'\n")
    assert backup.check_key_file(path, "cheerful-bandicoot-511") == path


# --- backup -------------------------------------------------------------------------------


def test_a_backup_exports_production_reads_it_back_and_keeps_it_private(
    host: Host, clock, capsys: pytest.CaptureFixture[str]
) -> None:
    assert host.run("backup") == 0

    name = "convex-prod-20261101T013000Z.zip"
    assert host.backups() == [name]
    final = host.dir / name
    manifest = json.loads((host.dir / "convex-prod-20261101T013000Z.manifest.json").read_text())
    assert manifest["deployment"] == "cheerful-bandicoot-511"
    assert manifest["tables"]["people"]["documents"] == 30
    assert manifest["documents"] == 38 and manifest["files"] == 1
    assert manifest["sha256"] == backup._sha256_file(final)
    assert manifest["fileStorage"] is True
    for path in host.dir.iterdir():
        assert stat.S_IMODE(path.stat().st_mode) == 0o600, path.name
    assert stat.S_IMODE(host.dir.stat().st_mode) == 0o700

    (call,) = host.calls()
    assert call["args"][:3] == ["export", "--env-file", str(host.key)]
    assert "--include-file-storage" in call["args"]
    assert call["convexEnv"] == []  # no stray CONVEX_DEPLOY_KEY reaches the CLI
    assert call["cwd"] == str(host.tools)

    status = json.loads((host.dir / "status-backup.json").read_text())
    assert status["result"] == "ok" and status["backup"] == name and status["kept"] == 1
    out = capsys.readouterr().out
    assert "38 documents, 1 files" in out
    # The CLI's output goes to the private log, never the journal.
    assert (
        "some CLI output" not in out
        and "some CLI output" in (host.dir / "last-backup.log").read_text()
    )
    assert MARKER not in out and KEY not in out


def test_only_the_newest_backups_are_kept(host: Host, clock) -> None:
    for _ in range(4):
        assert host.run("backup", CAMSOCS_BACKUP_KEEP="2") == 0
        clock()
    assert host.backups() == [
        "convex-prod-20261103T013000Z.zip",
        "convex-prod-20261104T013000Z.zip",
    ]
    assert sorted(p.name for p in host.dir.glob("*.manifest.json")) == [
        "convex-prod-20261103T013000Z.manifest.json",
        "convex-prod-20261104T013000Z.manifest.json",
    ]


def test_a_failed_export_keeps_every_earlier_backup(host: Host, clock) -> None:
    assert host.run("backup", CAMSOCS_BACKUP_KEEP="1") == 0
    clock()
    assert host.run("backup", CAMSOCS_BACKUP_KEEP="1", FAKE_EXPORT_EXIT="1") == backup.EXPORT_FAILED
    assert host.backups() == ["convex-prod-20261101T013000Z.zip"]
    assert not list(host.dir.glob(".*partial*"))
    status = json.loads((host.dir / "status-backup.json").read_text())
    assert status["result"] == "failed" and status["exitCode"] == backup.EXPORT_FAILED


def test_an_export_that_is_not_a_snapshot_is_not_kept(host: Host, clock) -> None:
    host.snapshot.write_bytes(b"PK\x03\x04 truncated")
    assert host.run("backup") == backup.BAD_SNAPSHOT
    assert host.backups() == []
    assert not list(host.dir.glob(".*partial*"))


def test_an_empty_export_is_not_a_backup(host: Host, clock) -> None:
    snapshot(host.snapshot, {"people": [], "_storage": []}, {})
    assert host.run("backup") == backup.BAD_SNAPSHOT
    assert host.backups() == []


def test_a_table_that_shrank_sharply_alerts_but_the_backup_is_kept(host: Host, clock) -> None:
    assert host.run("backup") == 0
    clock()
    snapshot(host.snapshot, {**TABLES, "people": documents("people", 10)})

    assert host.run("backup") == backup.SHRUNK

    assert len(host.backups()) == 2
    status = json.loads((host.dir / "status-backup.json").read_text())
    assert status["result"] == "shrunk" and status["shrunkTables"] == ["people"]
    # A small table (5 organisations) may halve without alerting.
    assert (
        backup.shrunk_tables({"tables": {"organisations": {"documents": 5}}}, {"tables": {}}) == []
    )


def test_rolling_window_tables_may_empty_without_alerting(host: Host, clock) -> None:
    busy = {**TABLES, "listingRequestSubmits": documents("submits", 25)}
    busy["_components/betterAuth/session"] = documents("session", 40)
    snapshot(host.snapshot, busy)
    assert host.run("backup") == 0
    clock()
    snapshot(host.snapshot, TABLES)  # a quiet day: the 24-hour windows are empty

    assert host.run("backup") == 0
    assert json.loads((host.dir / "status-backup.json").read_text())["result"] == "ok"


def test_a_wrong_key_stops_before_anything_is_exported(host: Host) -> None:
    host.key.write_text("CONVEX_DEPLOY_KEY=dev:hushed-rhinoceros-215|abc\n")
    assert host.run("backup") == backup.CONFIG
    assert host.calls() == []


def test_too_little_disk_stops_before_the_export(host: Host) -> None:
    assert host.run("backup", CAMSOCS_BACKUP_MIN_FREE_MB=str(1 << 40)) == backup.DISK
    assert host.calls() == []


def test_an_unexpected_error_replaces_an_earlier_ok(
    host: Host, clock, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    assert host.run("backup") == 0
    clock()

    def broken_disk(path: object) -> object:
        raise OSError(5, f"Input/output error: {MARKER}")

    monkeypatch.setattr(backup.shutil, "disk_usage", broken_disk)
    assert host.run("backup") == backup.UNEXPECTED_BACKUP

    status = json.loads((host.dir / "status-backup.json").read_text())
    assert status["result"] == "failed" and status["exitCode"] == backup.UNEXPECTED_BACKUP
    assert status["error"] == "unexpected OSError (errno 5)"
    captured = capsys.readouterr()
    assert MARKER not in captured.out + captured.err
    assert "Traceback" not in captured.err


def test_usage(host: Host, capsys: pytest.CaptureFixture[str]) -> None:
    assert host.run("restore") == backup.USAGE
    assert host.run("backup", "extra") == backup.USAGE
    assert "usage" in capsys.readouterr().err


# --- restore test -------------------------------------------------------------------------


def _backed_up(host: Host) -> Path:
    assert host.run("backup") == 0
    return host.dir / host.backups()[-1]


def test_the_newest_backup_restores_into_a_throwaway_local_backend(
    host: Host, clock, capsys: pytest.CaptureFixture[str]
) -> None:
    newest = _backed_up(host)

    assert host.run("restore-test") == 0

    imported, exported = host.calls()[1:]
    assert imported["args"][0] == "import" and imported["args"][-1] == str(newest)
    assert "--replace-all" in imported["args"]
    assert exported["args"][0] == "export" and "--include-file-storage" in exported["args"]
    backend = json.loads((host.state / "backend.json").read_text())
    assert backend["interface"] == "127.0.0.1"
    with pytest.raises(ProcessLookupError):
        os.kill(backend["pid"], 0)  # stopped
    assert not list(host.tmp.glob("camsocs-restore-*"))  # the restored copy is gone
    status = json.loads((host.dir / "status-restore-test.json").read_text())
    assert status["result"] == "ok" and status["backup"] == newest.name
    assert status["documents"] == 38 and status["differences"] == []
    out = capsys.readouterr().out
    assert "38 documents and 1 files read back identical" in out
    assert MARKER not in out


def test_restored_data_that_differs_fails_and_names_the_table(
    host: Host, clock, capsys: pytest.CaptureFixture[str]
) -> None:
    _backed_up(host)
    assert host.run("restore-test", FAKE_TAMPER="1") == backup.MISMATCH
    status = json.loads((host.dir / "status-restore-test.json").read_text())
    assert status["differences"] == ["people: 30 documents, but their content differs"]
    assert MARKER not in capsys.readouterr().out


def test_a_backup_that_does_not_match_its_manifest_is_not_tested(host: Host, clock) -> None:
    newest = _backed_up(host)
    with newest.open("ab") as handle:
        handle.write(b"\0")
    assert host.run("restore-test") == backup.NO_BACKUP
    assert [c["args"][0] for c in host.calls()] == ["export"]


def test_without_a_backup_there_is_nothing_to_test(host: Host) -> None:
    assert host.run("restore-test") == backup.NO_BACKUP


def test_a_failed_import_or_backend_fails_the_test(host: Host, clock) -> None:
    _backed_up(host)
    assert host.run("restore-test", FAKE_IMPORT_EXIT="1") == backup.IMPORT_FAILED
    assert host.run("restore-test", FAKE_BACKEND_EXIT="3") == backup.BACKEND_FAILED
    assert not list(host.tmp.glob("camsocs-restore-*"))


def test_a_backend_that_cannot_run_replaces_an_earlier_ok(host: Host, clock) -> None:
    _backed_up(host)
    assert host.run("restore-test") == 0
    host.backend.chmod(0o644)

    assert host.run("restore-test") == backup.UNEXPECTED_RESTORE

    status = json.loads((host.dir / "status-restore-test.json").read_text())
    assert status["result"] == "failed"
    assert status["error"] == "unexpected PermissionError (errno 13)"
    assert not list(host.tmp.glob("camsocs-restore-*"))


def test_inspect_prints_names_and_counts_only(host: Host, capsys) -> None:
    assert host.run("inspect", str(host.snapshot)) == 0
    out = capsys.readouterr().out
    assert "people\t30" in out and "_storage (files)\t1" in out
    assert MARKER not in out


# --- the alert ----------------------------------------------------------------------------


@pytest.mark.parametrize(
    "group, code, expected",
    [
        ("backup", "22", "the export from Convex failed or timed out"),
        ("backup", "24", "a table shrank"),
        ("restore_test", "34", "the restored data differs from the backup"),
        ("backup", "29", "an unexpected error"),
        ("restore_test", "39", "an unexpected error"),
        ("restore_test", "99", "exit status 99 (exit-code)"),
    ],
)
def test_the_backups_alert_says_what_the_exit_means(group: str, code: str, expected: str) -> None:
    text = alert.build_message(
        group,
        environ={"MONITOR_SERVICE_RESULT": "exit-code", "MONITOR_EXIT_STATUS": code},
        status={"error": f"{MARKER} must not be shown"},
        host="srv1608974",
        today="2026-11-04",
    )
    assert expected in text and "srv1608974" in text
    assert "docs/ops-vps.md §10" in text
    assert MARKER not in text


def test_the_alert_accepts_the_restore_tests_group_name(capsys) -> None:
    environ = {"MONITOR_SERVICE_RESULT": "timeout", "MONITOR_EXIT_STATUS": "TERM"}
    assert alert.main(["--dry-run", "restore_test"], environ, opener=_no_network) == 0
    assert "the unit hit its time limit" in capsys.readouterr().out


def _no_network(*args, **kwargs):  # pragma: no cover - must not be called
    raise AssertionError("no request in a dry run")


# --- the installer's key check ------------------------------------------------------------

INSTALL = OPS / "install.sh"


def _check(tmp: Path, text: str) -> int:
    path = tmp / "backup.env"
    path.write_text(text)
    script_text = f'set -euo pipefail\nsource "{INSTALL}"\ncheck_backup_env "$1"\n'
    return subprocess.run(
        ["bash", "-c", script_text, "_", str(path)], capture_output=True, check=False, timeout=30
    ).returncode


@pytest.mark.parametrize(
    "text, ok",
    [
        (f"CONVEX_DEPLOY_KEY={KEY}\n", True),
        (f"# backup key (ENG-44)\n\nCONVEX_DEPLOY_KEY='{KEY}'\n", True),
        ("CONVEX_DEPLOY_KEY=dev:hushed-rhinoceros-215|abc\n", False),
        ("CONVEX_DEPLOY_KEY=prod:cheerful-bandicoot-511\n", False),
        (f"CONVEX_DEPLOY_KEY={KEY}\nCONVEX_DEPLOYMENT=prod:x\n", False),
        ("", False),
    ],
)
def test_the_installer_takes_only_productions_key_alone(
    tmp_path: Path, text: str, ok: bool
) -> None:
    assert (_check(tmp_path, text) == 0) is ok


def test_the_lock_keeps_the_backup_and_the_restore_test_apart(tmp_path: Path) -> None:
    with (
        backup.locked(tmp_path, 1),
        pytest.raises(backup.Failure) as raised,
        backup.locked(tmp_path, 0.2),
    ):
        pass
    assert raised.value.code == backup.LOCKED


def test_the_backup_avoids_the_hour_the_clock_changes_skip_or_repeat() -> None:
    timer = (OPS / "systemd" / "camsocs-backup.timer").read_text()
    calendar = next(line for line in timer.splitlines() if line.startswith("OnCalendar="))
    hour = int(calendar.split()[1].split(":")[0])
    assert calendar.endswith("Europe/London") and hour != 1


def test_the_units_hand_the_key_only_to_the_backup() -> None:
    units = OPS / "systemd"
    service = (units / "camsocs-backup.service").read_text()
    restore = (units / "camsocs-restore-test.service").read_text()
    assert "LoadCredential=convex-backup-env:/etc/camsocs/backup.env" in service
    settings = [line for line in restore.splitlines() if not line.startswith("#")]
    assert not any(line.startswith("LoadCredential") for line in settings)
    assert "IPAddressDeny=any" in settings
    for text in (service, restore):
        assert "DynamicUser=yes" in text and "User=camsocs-backup" in text
        assert "/opt/camsocs" in text.split("InaccessiblePaths=")[1].splitlines()[0]
    assert "OnFailure=camsocs-alert@backup.service" in service
    assert "OnFailure=camsocs-alert@restore_test.service" in restore


# --- the installer's backup step ----------------------------------------------------------


def _install_backup(
    tmp: Path, *, key: str | None, enable: str, new: str, installed: bool
) -> tuple[int, str, str]:
    """Runs install.sh's `install_backup` with the toolchain already in place
    (its stamp and the backend's sha256 match, so nothing is downloaded), root's
    `install -o` and systemctl replaced; returns its exit code, the systemctl
    calls and its output."""
    rev = tmp / "rev"
    (rev / "backup").mkdir(parents=True, exist_ok=True)
    (rev / "camsocs-backup.py").write_text("# reviewed\n")
    for name in ("pixi.toml", "pixi.lock", "package.json", "package-lock.json"):
        (rev / "backup" / name).write_text(f"# {name}\n")
    tools = tmp / "tools"
    node = tools / ".pixi" / "envs" / "default" / "bin" / "node"
    node.parent.mkdir(parents=True, exist_ok=True)
    node.write_text("#!/bin/sh\n")
    node.chmod(0o755)
    main_js = tools / "node_modules" / "convex" / "bin" / "main.js"
    main_js.parent.mkdir(parents=True, exist_ok=True)
    main_js.write_text("")
    stamp_command = (
        'cd "$1" && sha256sum pixi.toml pixi.lock package.json package-lock.json'
        " | sha256sum | cut -d' ' -f1"
    )
    stamp = subprocess.run(
        ["bash", "-c", stamp_command, "_", str(rev / "backup")],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    (tools / ".installed").write_text(stamp + "\n")
    local_backend = tools / "convex-local-backend"
    local_backend.write_text("#!/bin/sh\n")
    local_backend.chmod(0o755)
    calls = tmp / "calls.txt"
    calls.write_text("")
    etc = tmp / "etc"
    etc.mkdir(exist_ok=True)
    key_file = ""
    if key is not None:
        key_file = str(tmp / "incoming.env")
        Path(key_file).write_text(key)
    if installed:
        (etc / "backup.env").write_text(f"CONVEX_DEPLOY_KEY={KEY}\n")
    script_text = f"""
set -euo pipefail
source "{INSTALL}"
install() {{
  local mode="" dir=0 args=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -m) mode="$2"; shift 2 ;;
      -o | -g) shift 2 ;;
      -d) dir=1; shift ;;
      *) args+=("$1"); shift ;;
    esac
  done
  if [[ $dir -eq 1 ]]; then
    mkdir -p "${{args[@]}}"
  else
    cp "${{args[0]}}" "${{args[1]}}"
    [[ -z "$mode" ]] || chmod "$mode" "${{args[1]}}"
  fi
}}
systemctl() {{
  echo "systemctl $*" >>"{calls}"
  if [[ "$1" == is-enabled ]]; then echo disabled; fi
}}
REV_DIR="{rev}"
WORK="{tmp}/work"
BACKUP_TOOLS="{tools}"
BACKUP_ENV="{etc}/backup.env"
CONVEX_BACKEND_SHA256=pinned
printf 'pinned\\n' >"{tools}/convex-local-backend.sha256"
backup_env="{key_file}"
enable="{enable}"
NEW_BACKUP_TIMERS=({new})
install_backup
"""
    done = subprocess.run(
        ["bash", "-c", script_text], capture_output=True, text=True, check=False, timeout=60
    )
    enabled = " ".join(
        line.split()[-1] for line in calls.read_text().splitlines() if "enable --now" in line
    )
    return done.returncode, enabled, done.stdout + done.stderr


BOTH = "camsocs-backup.timer camsocs-restore-test.timer"


def test_the_backup_timers_stay_off_without_a_key(tmp_path: Path) -> None:
    code, enabled, out = _install_backup(
        tmp_path, key=None, enable="auto", new=BOTH, installed=False
    )
    assert code == 0 and enabled == ""
    assert "stay off until install.sh --backup-env" in out


def test_installing_the_key_turns_the_backup_on(tmp_path: Path) -> None:
    code, enabled, _ = _install_backup(
        tmp_path, key=f"CONVEX_DEPLOY_KEY={KEY}\n", enable="auto", new="", installed=False
    )
    assert code == 0 and enabled == BOTH
    installed = tmp_path / "etc" / "backup.env"
    assert installed.read_text() == f"CONVEX_DEPLOY_KEY={KEY}\n"
    assert stat.S_IMODE(installed.stat().st_mode) == 0o600


def test_an_upgrade_leaves_the_operators_backup_timers_alone(tmp_path: Path) -> None:
    code, enabled, _ = _install_backup(tmp_path, key=None, enable="auto", new="", installed=True)
    assert code == 0 and enabled == ""
    code, enabled, _ = _install_backup(tmp_path, key=None, enable="auto", new=BOTH, installed=True)
    assert code == 0 and enabled == BOTH
    code, enabled, _ = _install_backup(
        tmp_path, key=f"CONVEX_DEPLOY_KEY={KEY}\n", enable="no", new=BOTH, installed=True
    )
    assert code == 0 and enabled == ""


def test_a_key_that_is_not_productions_is_not_installed(tmp_path: Path) -> None:
    code, enabled, out = _install_backup(
        tmp_path, key="CONVEX_DEPLOY_KEY=dev:hushed-rhinoceros-215|abc\n", enable="auto", new=BOTH,
        installed=False,
    )  # fmt: skip
    assert code != 0 and enabled == ""
    assert not (tmp_path / "etc" / "backup.env").exists()
    assert "abc" not in out


def test_a_revision_without_the_backup_skips_it(tmp_path: Path) -> None:
    script_text = f'set -euo pipefail\nsource "{INSTALL}"\nREV_DIR="{tmp_path}"\ninstall_backup\n'
    done = subprocess.run(["bash", "-c", script_text], capture_output=True, text=True, check=False)
    assert done.returncode == 0 and "has no backup" in done.stdout
