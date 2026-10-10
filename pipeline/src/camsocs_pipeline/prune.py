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
public pages. Until the cutoff, `enrich` reads its older copies to restate
what earlier runs read off a page and this run no longer does
(`restate_readings`).

**Mail goes after 30 days** (retention.md R4: message text is deleted 30 days
after it is read): the model's replies about list mail and its attachments
(`MAIL_PROMPTS`, which quote it) and the staged mail events
(`MAIL_STAGING`), the latest file included — the `inbox` stage posted them
when it read the mail, so no later load needs them.

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
#: How long anything quoting list mail is kept (retention.md R4).
MAIL_AGE = timedelta(days=30)
#: Replies that may quote list mail or its attachments (`stages/inbox.py`;
#: termcards share the image prompt, whose replies are re-asked weekly anyway),
#: and the calendar-noise verdicts and name redactions of mail-derived readings,
#: which the D6 and D1 steps cache apart (``<prompt>.mail``).
MAIL_PROMPTS = frozenset(
    {"email_events_v1", "image_events_v1", "event_noise_v2.mail", "redact_names_v2.mail"}
)
#: Staging that holds what was read from list mail.
MAIL_STAGING = frozenset({"mailing_list_email", "mailing_list_email.events"})

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
            # Whichever is sooner: the cache's age or the 30 days of R4.
            mail_cutoff = max(cutoff, (now or datetime.now(UTC)) - MAIL_AGE)
            for path in sorted(p for p in folder.rglob("*") if p.is_file()):
                prompt = path.relative_to(folder).parts[0]
                limit = mail_cutoff if prompt in MAIL_PROMPTS else cutoff
                if _mtime(path) < limit:
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
    mail_cutoff = max(cutoff, (now or datetime.now(UTC)) - MAIL_AGE)
    result = PruneResult()
    store = StagingStore(staging_dir)
    for directory in store.directories():
        mail = directory in MAIL_STAGING
        latest = set() if mail else set(store.latest_paths(directory))
        limit = mail_cutoff if mail else cutoff
        for path in sorted((staging_dir / directory).glob("*.jsonl")):
            if path in latest or _mtime(path) >= limit:
                result.kept += 1
                continue
            _delete([path], "staging", result, dry_run)
    return result


def _remove_empty_dirs(root: Path) -> None:
    for folder in sorted((p for p in root.rglob("*") if p.is_dir()), reverse=True):
        if not any(folder.iterdir()):
            folder.rmdir()


__all__ = ["PruneResult", "parse_age", "prune_cache", "prune_staging"]
