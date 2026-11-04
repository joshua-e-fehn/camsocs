#!/usr/bin/env python3
"""Back up Convex production every night, and prove once a week that a backup
restores (ENG-44; docs/ops-vps.md §10).

    camsocs-backup.py backup               # camsocs-backup.service, nightly
    camsocs-backup.py restore-test [ZIP]   # camsocs-restore-test.service, weekly
    camsocs-backup.py inspect ZIP          # tables and counts of a snapshot

Installed root-owned in ``/usr/local/lib/camsocs-ops/`` from a reviewed commit
(``install.sh``); its units run it as a user of their own (``DynamicUser``,
``camsocs-backup``), never as the harvest's ``camsocs`` and never from the
checkout the harvest writes, because the backup unit holds production's
Convex deploy key.

- **backup.** ``convex export --env-file <key file> [--include-file-storage]``
  (the Convex CLI pinned in ``ops/vps/backup/``, its runtime too) writes a
  snapshot ZIP of every table, the Better Auth component's and file storage,
  as ``<dir>/convex-prod-<UTC stamp>.zip``. The ZIP is read back whole before
  it counts: every member's CRC, every document line parsed as a JSON object
  with an ``_id``. Its manifest, ``<name>.manifest.json``, holds the file's
  size and sha256 and, per table, the number of documents and a digest of
  them (order- and formatting-independent), per storage folder the number of
  files and a digest — names and numbers, never a document. A table that
  shrank to under half of what the previous backup held (from at least
  ``SHRINK_MIN_PREVIOUS`` documents) is kept but reported (exit 24, which
  alerts), so a mass deletion is noticed while the backups from before it
  still exist. Then only the newest ``CAMSOCS_BACKUP_KEEP`` (14) backups are
  kept. Everything is ``0600`` in a ``0700`` directory.
- **restore-test.** The newest backup (or ``ZIP``), checked against its
  manifest's sha256, is imported into a **throwaway local Convex backend**
  (the pinned ``convex-local-backend`` binary, SQLite in a temporary
  directory, bound to 127.0.0.1 with an admin key made for this run only),
  then exported again and compared with the manifest table by table: the
  same documents (count and digest) and the same stored files. Never a cloud
  deployment: the key file is not given to this command (its unit has no
  credential), and the only deployment it names is the one it started. The
  backend and its data are deleted afterwards.
- **inspect.** Prints a snapshot's tables with their counts (no documents).

The CLI's own output (which on an error can quote a document) goes to
``<dir>/last-<command>.log`` (``0600``), never to the journal; the journal and
the status files get names and numbers only. Exit codes (the alert maps them,
``camsocs-alert.py``): 0 ok; 20 a setting or tool is missing or wrong (no key,
a key for another deployment); 21 not enough free disk; 22 the export failed
or timed out; 23 the export is not a readable snapshot; 24 backed up, but a
table shrank sharply; 30 no backup to test, or it does not match its
manifest; 31 the local backend did not start; 32 the import failed; 33 the
export from the local backend failed; 34 the restored data differs from the
backup; 64 usage; 75 the other command held the lock for too long.

Standard library only (the host's python3).
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
import zlib
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager, suppress
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, BinaryIO

OK = 0
CONFIG = 20
DISK = 21
EXPORT_FAILED = 22
BAD_SNAPSHOT = 23
SHRUNK = 24
NO_BACKUP = 30
BACKEND_FAILED = 31
IMPORT_FAILED = 32
REEXPORT_FAILED = 33
MISMATCH = 34
USAGE = 64
LOCKED = 75

DEFAULT_DIR = "/var/lib/camsocs-backup"
DEFAULT_TOOLS = "/usr/local/lib/camsocs-ops/backup"
#: Production (docs/deploy.md §1). A key for any other deployment is refused.
DEFAULT_DEPLOYMENT = "cheerful-bandicoot-511"
CREDENTIAL_NAME = "convex-backup-env"
KEY_NAME = "CONVEX_DEPLOY_KEY"
PREFIX = "convex-prod-"
_BACKUP_NAME = re.compile(rf"{PREFIX}\d{{8}}T\d{{6}}Z\.zip")

#: A table "shrank" when it held at least this many documents in the previous
#: backup and now holds less than this share of them.
SHRINK_MIN_PREVIOUS = 20
SHRINK_RATIO = 0.5
#: How long one command waits for the other's lock (seconds).
LOCK_WAIT = 2 * 3600
#: The restore test's own backend: its name, and how long it may take to start.
RESTORE_INSTANCE = "camsocs-restore-test"
BACKEND_START_SECONDS = 180
#: Tables shown at most in a journal line.
MAX_NAMES = 12


class Failure(Exception):
    """Ends the command with an exit code; the message is names and numbers only."""

    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class Settings:
    directory: Path
    tools: Path
    deployment: str
    keep: int
    file_storage: bool
    min_free_bytes: int
    export_timeout: float
    restore_timeout: float
    key_file: Path | None
    convex: tuple[str, ...]
    backend: Path
    work: Path | None

    @classmethod
    def from_env(cls, environ: Mapping[str, str]) -> Settings:
        tools = Path(environ.get("CAMSOCS_BACKUP_TOOLS") or DEFAULT_TOOLS)
        credentials = environ.get("CREDENTIALS_DIRECTORY")
        key_file = environ.get("CAMSOCS_BACKUP_ENV") or (
            str(Path(credentials) / CREDENTIAL_NAME) if credentials else ""
        )
        # The CLI as the pinned toolchain runs it: its node, its bin script.
        convex = environ.get("CAMSOCS_CONVEX")
        command = (
            (convex,)
            if convex
            else (
                str(tools / ".pixi" / "envs" / "default" / "bin" / "node"),
                str(tools / "node_modules" / "convex" / "bin" / "main.js"),
            )
        )
        try:
            keep = int(environ.get("CAMSOCS_BACKUP_KEEP") or 14)
            min_free_mb = int(environ.get("CAMSOCS_BACKUP_MIN_FREE_MB") or 2048)
            export_timeout = float(environ.get("CAMSOCS_BACKUP_TIMEOUT") or 2 * 3600)
            restore_timeout = float(environ.get("CAMSOCS_RESTORE_TIMEOUT") or 3600)
        except ValueError as error:
            raise Failure(
                CONFIG, "a numeric CAMSOCS_BACKUP_* / CAMSOCS_RESTORE_* setting is not a number"
            ) from error
        if keep < 1:
            raise Failure(CONFIG, "CAMSOCS_BACKUP_KEEP must be at least 1")
        work = environ.get("CAMSOCS_RESTORE_WORK")
        return cls(
            directory=Path(environ.get("CAMSOCS_BACKUP_DIR") or DEFAULT_DIR),
            tools=tools,
            deployment=environ.get("CAMSOCS_BACKUP_DEPLOYMENT") or DEFAULT_DEPLOYMENT,
            keep=keep,
            file_storage=(environ.get("CAMSOCS_BACKUP_FILE_STORAGE") or "1")
            not in {"0", "no", "false"},
            min_free_bytes=min_free_mb * 1024 * 1024,
            export_timeout=export_timeout,
            restore_timeout=restore_timeout,
            key_file=Path(key_file) if key_file else None,
            convex=command,
            backend=Path(environ.get("CAMSOCS_LOCAL_BACKEND") or tools / "convex-local-backend"),
            work=Path(work) if work else None,
        )


def say(message: str) -> None:
    print(f"camsocs-backup: {message}", flush=True)


def now_utc() -> datetime:
    return datetime.now(UTC).replace(microsecond=0)


def iso(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def write_private(path: Path, text: str) -> None:
    """``text`` to ``path`` (0600), whole or not at all."""
    temporary = path.with_name(f".{path.name}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def write_json(path: Path, data: Mapping[str, Any]) -> None:
    write_private(path, json.dumps(data, indent=2, sort_keys=True) + "\n")


@contextmanager
def locked(directory: Path, wait: float) -> Iterator[None]:
    """One command at a time per backup directory (a restore test never reads
    a backup that is still being written, nor the backup prunes the one under
    test)."""
    descriptor = os.open(directory / ".lock", os.O_RDWR | os.O_CREAT, 0o600)
    try:
        deadline = time.monotonic() + wait
        while True:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise Failure(
                        LOCKED, f"another backup command held the lock for {wait:.0f}s"
                    ) from None
                time.sleep(min(5.0, max(0.05, deadline - time.monotonic())))
        yield
    finally:
        os.close(descriptor)


# --- the key ------------------------------------------------------------------------------


def check_key_file(path: Path | None, deployment: str) -> Path:
    """The key file must hold exactly one setting: ``CONVEX_DEPLOY_KEY`` for
    ``deployment``'s production key (``prod:<deployment>|…``). Anything else —
    a dev or preview key, ``CONVEX_DEPLOYMENT``, a self-hosted URL — would make
    the CLI export another deployment, so it is refused. The value is never
    printed."""
    if path is None:
        raise Failure(CONFIG, "no key file: the unit's credential convex-backup-env is missing")
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        raise Failure(CONFIG, f"cannot read the key file ({error.strerror})") from None
    names: list[str] = []
    value = ""
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        name, _, raw = stripped.removeprefix("export ").partition("=")
        names.append(name.strip())
        if name.strip() == KEY_NAME:
            value = raw.strip().strip("'\"")
    if names != [KEY_NAME]:
        shown = ", ".join(sorted({n for n in names if re.fullmatch(r"[A-Z_][A-Z0-9_]{0,63}", n)}))
        raise Failure(
            CONFIG,
            f"the key file must set {KEY_NAME} and nothing else (it sets: {shown or 'nothing'})",
        )
    if not value.startswith(f"prod:{deployment}|"):
        raise Failure(CONFIG, f"{KEY_NAME} is not a production deploy key of {deployment}")
    return path


# --- snapshots ----------------------------------------------------------------------------


def _canonical_line_digest(line: bytes, where: str) -> tuple[bytes, Any]:
    try:
        document = json.loads(line)
    except ValueError:
        raise Failure(BAD_SNAPSHOT, f"{where}: a line is not JSON") from None
    if not isinstance(document, dict) or not isinstance(document.get("_id"), str):
        raise Failure(BAD_SNAPSHOT, f"{where}: a line is not a document with an _id")
    canonical = json.dumps(document, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).digest(), document["_id"]


def _digest(parts: list[bytes]) -> str:
    return hashlib.sha256(b"".join(sorted(parts))).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _lines(handle: BinaryIO) -> Iterator[bytes]:
    for raw in handle:
        line = raw.strip()
        if line:
            yield line


def inspect(path: Path) -> dict[str, Any]:
    """What a snapshot ZIP holds, as names and numbers: every table (a folder
    with ``documents.jsonl``: ``people``, ``_components/betterAuth/user``,
    ``_storage``) with its document count and digest, every storage folder
    with its file count and digest. Reads the whole file: a member with a bad
    CRC, a line that is not a document or a ZIP that is not one raises
    :class:`Failure` (``BAD_SNAPSHOT``).

    The digest of a table is the sha256 of the sorted sha256s of its documents
    in canonical JSON (sorted keys, no spaces), so it does not depend on the
    order or the formatting the exporter chose; a storage folder's is the same
    over ``<file name>:<sha256 of the bytes>``.
    """
    tables: dict[str, dict[str, Any]] = {}
    storage: dict[str, list[bytes]] = {}
    try:
        archive = zipfile.ZipFile(path)
    except (OSError, zipfile.BadZipFile):
        raise Failure(BAD_SNAPSHOT, f"{path.name} is not a ZIP file") from None
    with archive:
        try:
            for info in archive.infolist():
                if info.is_dir():
                    continue
                member = info.filename
                folder, _, base = member.rpartition("/")
                if base == "documents.jsonl" and folder.rsplit("/", 1)[-1] != "_tables":
                    hashes: list[bytes] = []
                    ids: set[str] = set()
                    with archive.open(info) as handle:
                        for line in _lines(handle):
                            line_hash, document_id = _canonical_line_digest(line, folder)
                            hashes.append(line_hash)
                            ids.add(document_id)
                    if len(ids) != len(hashes):
                        raise Failure(BAD_SNAPSHOT, f"{folder}: an _id appears twice")
                    tables[folder] = {"documents": len(hashes), "digest": _digest(hashes)}
                elif folder.rsplit("/", 1)[-1] == "_storage" and base != "generated_schema.jsonl":
                    blob = hashlib.sha256()
                    with archive.open(info) as handle:
                        for chunk in iter(lambda h=handle: h.read(1 << 20), b""):
                            blob.update(chunk)
                    storage.setdefault(folder, []).append(f"{base}:{blob.hexdigest()}".encode())
        except zipfile.BadZipFile:
            raise Failure(BAD_SNAPSHOT, f"{path.name}: a member is damaged (CRC)") from None
        except (OSError, EOFError, zlib.error):
            raise Failure(BAD_SNAPSHOT, f"{path.name}: a member cannot be read") from None
    if not tables:
        raise Failure(BAD_SNAPSHOT, f"{path.name} holds no table")
    return {
        "tables": dict(sorted(tables.items())),
        "storage": {
            folder: {"files": len(files), "digest": _digest(files)}
            for folder, files in sorted(storage.items())
        },
        "documents": sum(table["documents"] for table in tables.values()),
        "files": sum(len(files) for files in storage.values()),
    }


def shrunk_tables(previous: Mapping[str, Any], current: Mapping[str, Any]) -> list[str]:
    """Tables that held at least ``SHRINK_MIN_PREVIOUS`` documents in the
    previous backup and now hold less than ``SHRINK_RATIO`` of that (or are
    gone)."""
    before = previous.get("tables") or {}
    after = current.get("tables") or {}
    names = []
    for name, table in before.items():
        count = table.get("documents") if isinstance(table, dict) else None
        if not isinstance(count, int) or count < SHRINK_MIN_PREVIOUS:
            continue
        now = (after.get(name) or {}).get("documents", 0)
        if now < count * SHRINK_RATIO:
            names.append(name)
    return sorted(names)


def compare(expected: Mapping[str, Any], actual: Mapping[str, Any]) -> list[str]:
    """Where a restored snapshot differs from the backup's manifest: one line
    per table or storage folder, names and counts only. A table the backup
    holds empty may be missing from the restored export, and the reverse."""
    empty = {"documents": 0, "digest": _digest([])}
    differences = []
    want, have = expected.get("tables") or {}, actual.get("tables") or {}
    for name in sorted(set(want) | set(have)):
        a, b = want.get(name, empty), have.get(name, empty)
        if a["documents"] != b["documents"]:
            differences.append(
                f"{name}: {a['documents']} documents backed up, {b['documents']} restored"
            )
        elif a["digest"] != b["digest"]:
            differences.append(f"{name}: {a['documents']} documents, but their content differs")
    no_files = {"files": 0, "digest": _digest([])}
    want, have = expected.get("storage") or {}, actual.get("storage") or {}
    for name in sorted(set(want) | set(have)):
        a, b = want.get(name, no_files), have.get(name, no_files)
        if a["files"] != b["files"]:
            differences.append(f"{name}: {a['files']} files backed up, {b['files']} restored")
        elif a["digest"] != b["digest"]:
            differences.append(f"{name}: {a['files']} files, but their bytes differ")
    return differences


def backups(directory: Path) -> list[Path]:
    """The finished backups, oldest first (the name carries the UTC time)."""
    return sorted(p for p in directory.glob(f"{PREFIX}*.zip") if _BACKUP_NAME.fullmatch(p.name))


def manifest_path(backup: Path) -> Path:
    return backup.with_name(backup.name.removesuffix(".zip") + ".manifest.json")


def read_manifest(backup: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(manifest_path(backup).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _names(names: Sequence[str]) -> str:
    shown = ", ".join(names[:MAX_NAMES])
    return shown + (f" and {len(names) - MAX_NAMES} more" if len(names) > MAX_NAMES else "")


def _size(count: int) -> str:
    return f"{count / 1_000_000:.1f} MB"


# --- the CLI ------------------------------------------------------------------------------


def run_cli(settings: Settings, arguments: Sequence[str], log: Path, timeout: float) -> int:
    """The Convex CLI with ``arguments``; its output to ``log`` (0600) only.
    No ``CONVEX_*`` variable reaches it: the deployment comes from the
    ``--env-file`` each call names, and nowhere else."""
    environ = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith("CONVEX_") and key not in {"CREDENTIALS_DIRECTORY"}
    }
    environ["FORCE_COLOR"] = "0"
    node_bin = settings.tools / ".pixi" / "envs" / "default" / "bin"
    environ["PATH"] = f"{node_bin}:{environ.get('PATH', '/usr/bin:/bin')}"
    descriptor = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(descriptor, "ab") as output:
        output.write(f"\n--- {iso(now_utc())} convex {arguments[0]}\n".encode())
        output.flush()
        try:
            done = subprocess.run(
                [*settings.convex, *arguments],
                cwd=settings.tools if settings.tools.is_dir() else None,
                env=environ,
                stdin=subprocess.DEVNULL,
                stdout=output,
                stderr=subprocess.STDOUT,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired:
            output.write(f"--- timed out after {timeout:.0f}s\n".encode())
            return 124
        except OSError as error:
            output.write(f"--- could not start: {error.strerror}\n".encode())
            return 127
    return done.returncode


# --- backup -------------------------------------------------------------------------------


def backup(settings: Settings) -> int:
    started = now_utc()
    directory = settings.directory
    key_file = check_key_file(settings.key_file, settings.deployment)
    with locked(directory, LOCK_WAIT):
        existing = backups(directory)
        for stale in directory.glob(f".{PREFIX}*.partial.zip"):
            stale.unlink(missing_ok=True)
        last_size = existing[-1].stat().st_size if existing else 0
        free = shutil.disk_usage(directory).free
        needed = max(settings.min_free_bytes, 2 * last_size)
        if free < needed:
            raise Failure(DISK, f"only {_size(free)} free in {directory} (needs {_size(needed)})")

        name = f"{PREFIX}{started.strftime('%Y%m%dT%H%M%SZ')}.zip"
        final = directory / name
        partial = directory / f".{name.removesuffix('.zip')}.partial.zip"
        arguments = ["export", "--env-file", str(key_file), "--path", str(partial)]
        if settings.file_storage:
            arguments.append("--include-file-storage")
        with_files = " with file storage" if settings.file_storage else ""
        say(f"exporting {settings.deployment}{with_files}")
        log = directory / "last-backup.log"
        log.unlink(missing_ok=True)
        code = run_cli(settings, arguments, log, settings.export_timeout)
        if code != 0 or not partial.is_file():
            partial.unlink(missing_ok=True)
            reason = "timed out" if code == 124 else f"exit {code}"
            raise Failure(
                EXPORT_FAILED, f"the export failed ({reason}; the CLI's output is in {log})"
            )
        os.chmod(partial, 0o600)
        try:
            contents = inspect(partial)
        except Failure:
            partial.unlink(missing_ok=True)
            raise
        if contents["documents"] == 0:
            partial.unlink(missing_ok=True)
            raise Failure(BAD_SNAPSHOT, "the export holds no document at all")
        previous = read_manifest(existing[-1]) if existing else None
        shrunk = shrunk_tables(previous, contents) if previous else []

        manifest = {
            "format": 1,
            "file": name,
            "deployment": settings.deployment,
            "createdAt": iso(started),
            "finishedAt": iso(now_utc()),
            "fileStorage": settings.file_storage,
            "sizeBytes": partial.stat().st_size,
            "sha256": _sha256_file(partial),
            **contents,
            "shrunkTables": shrunk,
        }
        os.replace(partial, final)
        write_json(manifest_path(final), manifest)

        kept = backups(directory)
        removed = kept[: max(0, len(kept) - settings.keep)]
        for old in removed:
            old.unlink(missing_ok=True)
            manifest_path(old).unlink(missing_ok=True)
        for orphan in directory.glob(f"{PREFIX}*.manifest.json"):
            if not orphan.with_name(orphan.name.removesuffix(".manifest.json") + ".zip").exists():
                orphan.unlink(missing_ok=True)

        say(
            f"{name}: {_size(manifest['sizeBytes'])}, {len(contents['tables'])} tables, "
            f"{contents['documents']} documents, {contents['files']} files; "
            f"{len(kept) - len(removed)} backups kept, {len(removed)} removed"
        )
        code = OK
        if shrunk:
            say(f"tables that shrank to under half since the previous backup: {_names(shrunk)}")
            code = SHRUNK
        write_json(
            directory / "status-backup.json",
            {
                "kind": "backup",
                "startedAt": iso(started),
                "finishedAt": iso(now_utc()),
                "exitCode": code,
                "result": "ok" if code == OK else "shrunk",
                "backup": name,
                "sizeBytes": manifest["sizeBytes"],
                "tables": len(contents["tables"]),
                "documents": contents["documents"],
                "files": contents["files"],
                "shrunkTables": shrunk,
                "kept": len(kept) - len(removed),
            },
        )
        return code


# --- restore test -------------------------------------------------------------------------


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def _wait_for_backend(url: str, process: subprocess.Popen[bytes], deadline: float) -> None:
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise Failure(
                BACKEND_FAILED, f"the local backend exited at start (exit {process.returncode})"
            )
        try:
            with urllib.request.urlopen(f"{url}/instance_name", timeout=2) as response:
                if response.read().decode("utf-8", "replace").strip() == RESTORE_INSTANCE:
                    return
        except (urllib.error.URLError, OSError):
            pass
        time.sleep(0.5)
    raise Failure(
        BACKEND_FAILED, f"the local backend did not answer within {BACKEND_START_SECONDS}s"
    )


def _stop(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    process.send_signal(signal.SIGTERM)
    try:
        process.wait(timeout=30)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=30)


def choose_backup(settings: Settings, given: str | None) -> tuple[Path, dict[str, Any]]:
    if given:
        candidate = Path(given)
        if not candidate.is_file():
            raise Failure(NO_BACKUP, f"{candidate} does not exist")
    else:
        found = backups(settings.directory)
        if not found:
            raise Failure(NO_BACKUP, f"no backup in {settings.directory} yet")
        candidate = found[-1]
    manifest = read_manifest(candidate)
    if manifest is None or not isinstance(manifest.get("tables"), dict):
        raise Failure(NO_BACKUP, f"{candidate.name} has no readable manifest")
    if _sha256_file(candidate) != manifest.get("sha256"):
        raise Failure(NO_BACKUP, f"{candidate.name} does not match the sha256 in its manifest")
    return candidate, manifest


def restore_test(settings: Settings, given: str | None) -> int:
    started = now_utc()
    directory = settings.directory
    with locked(directory, LOCK_WAIT):
        snapshot, manifest = choose_backup(settings, given)
        if not settings.backend.is_file():
            raise Failure(
                CONFIG, f"no local backend at {settings.backend} (install.sh installs it)"
            )
        log = directory / "last-restore-test.log"
        log.unlink(missing_ok=True)
        work = Path(tempfile.mkdtemp(prefix="camsocs-restore-", dir=settings.work))
        process: subprocess.Popen[bytes] | None = None
        try:
            secret = secrets.token_hex(32)
            keygen = subprocess.run(
                [str(settings.backend), "keygen", "admin-key",
                 "--instance-name", RESTORE_INSTANCE, "--instance-secret", secret],
                capture_output=True, text=True, timeout=60, check=False,
            )  # fmt: skip
            admin_key = keygen.stdout.strip()
            if keygen.returncode != 0 or not admin_key:
                raise Failure(
                    BACKEND_FAILED,
                    f"the local backend could not make an admin key (exit {keygen.returncode})",
                )
            port, site_port = _free_port(), _free_port()
            url = f"http://127.0.0.1:{port}"
            say(f"restoring {snapshot.name} into a throwaway local backend at {url}")
            backend_log = os.open(work / "backend.log", os.O_WRONLY | os.O_CREAT, 0o600)
            try:
                process = subprocess.Popen(
                    [str(settings.backend),
                     "--interface", "127.0.0.1", "--port", str(port),
                     "--site-proxy-port", str(site_port),
                     "--instance-name", RESTORE_INSTANCE, "--instance-secret", secret,
                     "--local-storage", str(work / "storage"),
                     "--disable-beacon",
                     str(work / "restore.sqlite3")],
                    cwd=work, stdin=subprocess.DEVNULL, stdout=backend_log,
                    stderr=subprocess.STDOUT, start_new_session=True,
                )  # fmt: skip
            finally:
                os.close(backend_log)
            _wait_for_backend(url, process, time.monotonic() + BACKEND_START_SECONDS)

            # The only deployment this command ever names: the one it started.
            env_file = work / "restore.env"
            write_private(
                env_file,
                f"CONVEX_SELF_HOSTED_URL={url}\nCONVEX_SELF_HOSTED_ADMIN_KEY={admin_key}\n",
            )
            code = run_cli(
                settings,
                ["import", "--env-file", str(env_file), "--replace-all", "-y", str(snapshot)],
                log,
                settings.restore_timeout,
            )
            if code != 0:
                raise Failure(
                    IMPORT_FAILED, f"the import failed (exit {code}; the CLI's output is in {log})"
                )
            roundtrip = work / "roundtrip.zip"
            arguments = ["export", "--env-file", str(env_file), "--path", str(roundtrip)]
            if manifest.get("fileStorage"):
                arguments.append("--include-file-storage")
            code = run_cli(settings, arguments, log, settings.restore_timeout)
            if code != 0 or not roundtrip.is_file():
                raise Failure(
                    REEXPORT_FAILED,
                    f"the export from the local backend failed (exit {code}; output in {log})",
                )
            try:
                restored = inspect(roundtrip)
            except Failure as failure:
                raise Failure(
                    REEXPORT_FAILED, f"the re-export is not readable: {failure}"
                ) from None
            differences = compare(manifest, restored)
        finally:
            if process is not None:
                _stop(process)
            shutil.rmtree(work, ignore_errors=True)

        result = {
            "kind": "restore-test",
            "startedAt": iso(started),
            "finishedAt": iso(now_utc()),
            "backup": snapshot.name,
            "backupCreatedAt": manifest.get("createdAt"),
            "tables": len(manifest["tables"]),
            "documents": manifest.get("documents"),
            "files": manifest.get("files"),
            "differences": differences,
        }
        if differences:
            result |= {"exitCode": MISMATCH, "result": "mismatch"}
            write_json(directory / "status-restore-test.json", result)
            for line in differences[:MAX_NAMES]:
                say(f"differs: {line}")
            raise Failure(
                MISMATCH, f"{len(differences)} tables or folders differ after the restore"
            )
        result |= {"exitCode": OK, "result": "ok"}
        write_json(directory / "status-restore-test.json", result)
        say(
            f"{snapshot.name} restores: {len(manifest['tables'])} tables, "
            f"{manifest.get('documents')} documents and {manifest.get('files')} files "
            "read back identical"
        )
        return OK


# --- entry point --------------------------------------------------------------------------

USAGE_TEXT = "usage: camsocs-backup.py backup | restore-test [ZIP] | inspect ZIP"


def record_failure(directory: Path, command: str, started: datetime, failure: Failure) -> None:
    """The status file of a run that failed before it could write its own
    (the message is names and numbers only), so a stale ``"ok"`` never
    outlives a failing backup. A restore test that found differences has
    written its status already."""
    status = directory / f"status-{command}.json"
    if failure.code == MISMATCH or not directory.is_dir():
        return
    with suppress(OSError):
        write_json(
            status,
            {
                "kind": command,
                "startedAt": iso(started),
                "finishedAt": iso(now_utc()),
                "exitCode": failure.code,
                "result": "failed",
                "error": str(failure),
            },
        )


def main(argv: list[str] | None = None, environ: Mapping[str, str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    environ = os.environ if environ is None else environ
    command, arguments = (argv[0], argv[1:]) if argv else ("", [])
    started = now_utc()
    directory: Path | None = None
    try:
        if command == "inspect" and len(arguments) == 1:
            contents = inspect(Path(arguments[0]))
            for name, table in contents["tables"].items():
                print(f"{name}\t{table['documents']}")
            for name, folder in contents["storage"].items():
                print(f"{name} (files)\t{folder['files']}")
            return OK
        if not (command == "backup" and not arguments) and not (
            command == "restore-test" and len(arguments) <= 1
        ):
            print(USAGE_TEXT, file=sys.stderr)
            return USAGE
        settings = Settings.from_env(environ)
        directory = settings.directory
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        if command == "backup":
            return backup(settings)
        return restore_test(settings, arguments[0] if arguments else None)
    except Failure as failure:
        say(f"failed: {failure}")
        if directory is not None:
            record_failure(directory, command, started, failure)
        return failure.code


if __name__ == "__main__":
    sys.exit(main())
