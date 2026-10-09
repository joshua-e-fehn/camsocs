"""What the files route already stores, remembered locally: sha256 → storageId.

`POST /api/pipeline/files` de-duplicates by content on the server, but only
after the bytes arrived: every run would upload every logo and event image
again (base64, up to 2 MB each) for the server to throw the copy away. The
loader (`ConvexLoader.upload_file`) asks this cache first, keyed by the
deployment it posts to — storage ids belong to one deployment — and by the
SHA-256 of the exact bytes it would send, so a changed image is uploaded again
and an unchanged one never is.

The file is ``var/state/stored-files.json`` (gitignored, like the crosswalk).
Entries expire after `TTL`, so a file deleted on the server (by hand) heals
within a month; `forget` drops a deployment's entries after `purge-dev`,
which deletes every stored file. Nothing personal is stored: content hashes
and opaque storage ids only.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path

logger = logging.getLogger(__name__)

#: How long a remembered storage id is trusted without asking the server.
TTL = timedelta(days=30)


def stored_files_path(staging_dir: Path) -> Path:
    """``var/state/stored-files.json``, next to the crosswalk."""
    return staging_dir.parent / "state" / "stored-files.json"


@dataclass
class StoredFiles:
    """One deployment's remembered uploads (see the module docstring)."""

    path: Path
    deployment: str
    entries: dict[str, dict[str, str]] = field(default_factory=dict)
    #: Uploads this run skipped because the server already had the bytes.
    reused: int = 0
    _all: dict[str, dict[str, dict[str, str]]] = field(default_factory=dict, repr=False)

    @classmethod
    def load(cls, path: Path, deployment: str) -> StoredFiles:
        everything: dict[str, dict[str, dict[str, str]]] = {}
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                everything = loaded
        except FileNotFoundError:
            pass
        except (OSError, ValueError) as error:
            logger.warning("Ignoring an unreadable stored-files cache %s (%s)", path, error)
        entries = everything.get(deployment)
        return cls(
            path=path,
            deployment=deployment,
            entries=dict(entries) if isinstance(entries, dict) else {},
            _all=everything,
        )

    def get(self, sha256: str, *, now: datetime | None = None) -> str | None:
        entry = self.entries.get(sha256)
        if not isinstance(entry, dict) or not entry.get("storageId"):
            return None
        try:
            stored_at = datetime.fromisoformat(entry["storedAt"])
        except (KeyError, ValueError):
            return None
        if (now or datetime.now(UTC)) - stored_at > TTL:
            return None
        return entry["storageId"]

    def put(self, sha256: str, storage_id: str, *, now: datetime | None = None) -> None:
        self.entries[sha256] = {
            "storageId": storage_id,
            "storedAt": (now or datetime.now(UTC)).isoformat(),
        }

    def save(self) -> None:
        self._all[self.deployment] = self.entries
        _write(self.path, self._all)

    @staticmethod
    def forget(path: Path, deployment: str) -> None:
        """Drop a deployment's entries (after `purge-dev` deleted its files)."""
        stored = StoredFiles.load(path, deployment)
        if deployment in stored._all:
            del stored._all[deployment]
            _write(path, stored._all)


def _write(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(data, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


__all__ = ["TTL", "StoredFiles", "stored_files_path"]
