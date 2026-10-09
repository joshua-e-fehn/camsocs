"""`camsocs prune-cache`: the pipeline host's half of the retention schedule
(docs/compliance/retention.md R7).

Raw pages, images and LLM replies under ``var/cache/`` are kept 90 days by
default; older ones are deleted. A page's files go together: its body, its
meta and its last-failure note share one key, and the group goes only when
all of them are older than the cutoff (a page re-fetched last week keeps its
body). LLM replies (``var/cache/llm/<prompt>/…``) are one file each.

Superseded staging files go too: ``var/staging/<dir>/<run>--<part>.jsonl``
older than the cutoff, **except the latest file of each part**, which the
next `load` still reads — staged observations hold names and addresses from
public pages, and nothing reads an older run's copy.

Nothing here touches Convex. ``--dry-run`` counts without deleting.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path

from camsocs_pipeline.staging.store import StagingStore

#: The LLM memo's folder inside the cache (`extract/memo.py`).
LLM_DIR = "llm"

_AGE = re.compile(r"^\s*(\d+)\s*([dhw])\s*$", re.IGNORECASE)


def parse_age(text: str) -> timedelta:
    """``90d`` / ``12w`` / ``36h`` → a timedelta; anything else raises ValueError."""
    match = _AGE.match(text)
    if not match:
        raise ValueError(f"Not an age like 90d, 12w or 36h: {text!r}")
    amount, unit = int(match.group(1)), match.group(2).lower()
    if amount <= 0:
        raise ValueError("The age must be positive")
    return {
        "d": timedelta(days=amount),
        "h": timedelta(hours=amount),
        "w": timedelta(weeks=amount),
    }[unit]


@dataclass
class PruneResult:
    #: Files deleted (or, in a dry run, that would be), by area.
    files: Counter[str] = field(default_factory=Counter)
    bytes: int = 0
    #: Files kept because they are recent enough (or the latest staged file).
    kept: int = 0

    def summary(self, dry_run: bool) -> str:
        verb = "would delete" if dry_run else "deleted"
        total = sum(self.files.values())
        detail = ", ".join(f"{area} {count}" for area, count in sorted(self.files.items()))
        size = f"{self.bytes / 1_048_576:.1f} MB"
        return (
            f"{verb} {total} files ({size})"
            + (f": {detail}" if detail else "")
            + (f"; kept {self.kept}")
        )


def _mtime(path: Path) -> datetime:
    return datetime.fromtimestamp(path.stat().st_mtime, UTC)


def _delete(paths: list[Path], area: str, result: PruneResult, dry_run: bool) -> None:
    for path in paths:
        result.bytes += path.stat().st_size
        result.files[area] += 1
        if not dry_run:
            path.unlink()


def prune_cache(
    cache_dir: Path, older_than: timedelta, *, now: datetime | None = None, dry_run: bool = False
) -> PruneResult:
    """Deletes cache files older than `older_than` (module docstring)."""
    cutoff = (now or datetime.now(UTC)) - older_than
    result = PruneResult()
    if not cache_dir.is_dir():
        return result
    for folder in sorted(child for child in cache_dir.iterdir() if child.is_dir()):
        if folder.name == LLM_DIR:
            for path in sorted(p for p in folder.rglob("*") if p.is_file()):
                if _mtime(path) < cutoff:
                    _delete([path], "llm", result, dry_run)
                else:
                    result.kept += 1
            continue
        groups: dict[str, list[Path]] = {}
        for path in folder.iterdir():
            if path.is_file():
                groups.setdefault(path.name.split(".", 1)[0], []).append(path)
        for paths in groups.values():
            if max(_mtime(path) for path in paths) < cutoff:
                _delete(sorted(paths), "pages", result, dry_run)
            else:
                result.kept += len(paths)
    if not dry_run:
        _remove_empty_dirs(cache_dir)
    return result


def prune_staging(
    staging_dir: Path, older_than: timedelta, *, now: datetime | None = None, dry_run: bool = False
) -> PruneResult:
    """Deletes superseded staging files older than `older_than`; the latest
    file of each part always stays."""
    cutoff = (now or datetime.now(UTC)) - older_than
    result = PruneResult()
    store = StagingStore(staging_dir)
    for directory in store.directories():
        latest = set(store.latest_paths(directory))
        for path in sorted((staging_dir / directory).glob("*.jsonl")):
            if path in latest or _mtime(path) >= cutoff:
                result.kept += 1
                continue
            _delete([path], "staging", result, dry_run)
    return result


def _remove_empty_dirs(root: Path) -> None:
    for folder in sorted((p for p in root.rglob("*") if p.is_dir()), reverse=True):
        if not any(folder.iterdir()):
            folder.rmdir()


__all__ = ["PruneResult", "parse_age", "prune_cache", "prune_staging"]
