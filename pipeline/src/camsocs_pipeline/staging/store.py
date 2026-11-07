"""Staging: observations on disk between the harvest stages and the loader.

Layout (gitignored — `var/` is never committed, and staged observations may
hold names and contact details from public pages)::

    var/staging/<source_type>/<run_key>.jsonl          one record per line
    var/staging/<source_type>/<run_key>--<part>.jsonl  the same, from one stage (`part`)
    var/staging/<source_type>.events/<run_key>.jsonl   an events stage's output
    var/staging/_resolved/<run_key>.jsonl              written by the resolve stage

The ``.events`` directories exist because one source can feed both a harvest
stage and an events stage (Camdram societies and the Camdram diary, CUCBC
clubs and the CUCBC calendar): two stages writing ``<source_type>/<run>.jsonl``
in one run would overwrite each other. Events stages run after resolve and
write keyed `EventObservation`s, so the resolver does not read them; the load
stage does.

Each line is one `Observation` or `EventObservation` (discriminated by
``kind``). Run keys sort chronologically (`report.mint_run_key`), so "latest"
is the greatest file name.

**Parts.** Several stages may observe the same source type (Camdram societies
and Camdram events; a JCR's site seen by the colleges stage and by website
enrichment). Each passes its stage name as ``part``, so in one run they write
different files, and `read_latest` returns the latest file *of each part* —
one stage's newer run never hides another stage's observations.

A file is written to ``<name>.jsonl.tmp`` and renamed when complete, so a
crashed stage leaves no half-file for the next stage to read. A stage that
produced nothing writes nothing (the previous file stays the latest).

**Shadowed readings.** ``var/staging/<source_type>/shadowed.json`` holds the
event readings an LLM stage dropped because another staged source has the
evening, each with that source's reading (`ShadowedReading`, ENG-47). It is
one file per directory, replaced by every run of its stage with the full
current set, and not a staging file: no reader of records sees it. The load
retires each one's own key to the event that took it over.

**Write guard (advisory).** While the runner has a stage running it sets
`StagingStore.active_stage` (`pipeline/sync.py`), and every write — a file,
a writer, the shadowed readings — is checked against that stage's declared
`writes` (`stages/__init__.py`): a directory named exactly (a source type,
a ``<type>.events`` directory, ``_resolved``) or covered by
``@all_observations`` (any source type or ``<type>.events`` directory, never
``_resolved`` or the talks pillar's ``talks``). A stage that writes its own
file beside them (the talks pillar's `TALKS`) checks it with `guard_write`.
A directory outside them is a `StagingGuardError` when
``CAMSOCS_STRICT_STAGING=1`` (the test suite sets it) and a logged warning
otherwise: production keeps running until a full run is warning-free.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Iterable, Iterator
from pathlib import Path
from types import TracebackType
from typing import Protocol, Self

from pydantic import TypeAdapter

from camsocs_pipeline.models.observation import (
    EventObservation,
    Observation,
    ShadowedReading,
    StagedRecord,
)
from camsocs_pipeline.models.vocab import SOURCE_TYPES

logger = logging.getLogger(__name__)

#: The resolve stage's output directory (not a source type).
RESOLVED = "_resolved"

#: The talks pillar's own staging directory (`talks/stage.py`, decision D7):
#: one file of the talks it posted per run, beside the observation
#: directories. Not a source type: no reader of observations sees it, and
#: this store neither reads nor writes it; the talks stage declares it
#: (``writes=(TALKS,)``) and checks it with `StagingStore.guard_write`.
TALKS = "talks"

#: Between the run key and the part in a staging file name.
PART_SEPARATOR = "--"

#: Suffix of an events stage's directory: ``camdram.events``.
EVENTS_SUFFIX = ".events"


def events_directory(source_type: str) -> str:
    """The staging directory an events stage writes for `source_type`."""
    return _check_directory(f"{source_type}{EVENTS_SUFFIX}")


def _is_directory_name(name: str) -> bool:
    if name == RESOLVED or name in SOURCE_TYPES:
        return True
    return name.endswith(EVENTS_SUFFIX) and name[: -len(EVENTS_SUFFIX)] in SOURCE_TYPES


def is_events_directory(name: str) -> bool:
    """Whether `name` is an events stage's directory (``<source_type>.events``)."""
    return name.endswith(EVENTS_SUFFIX)


Record = Observation | EventObservation
_RECORD = TypeAdapter(StagedRecord)
_SHADOWED = TypeAdapter(list[ShadowedReading])

#: The shadowed readings beside a directory's staging files (not ``*.jsonl``).
SHADOWED_FILE = "shadowed.json"


def _check_directory(name: str) -> str:
    if not _is_directory_name(name):
        raise ValueError(
            f"{name!r} is not a source type (models.vocab.SOURCE_TYPES), "
            f"<source type>{EVENTS_SUFFIX} or {RESOLVED}"
        )
    return name


def _check_run_key(run_key: str) -> str:
    if not run_key or "/" in run_key or run_key.startswith(".") or PART_SEPARATOR in run_key:
        raise ValueError(f"Not a usable run key: {run_key!r}")
    return run_key


def _check_part(part: str | None) -> str | None:
    if part is not None and not part.isidentifier():
        raise ValueError(f"A staging part is a stage name: {part!r}")
    return part


def _part_of(path: Path) -> str:
    """The part a staging file belongs to ("" for a file without one)."""
    _run_key, _separator, part = path.stem.partition(PART_SEPARATOR)
    return part


#: Every observation directory at once (`stages/__init__.py` selectors).
ALL_OBSERVATIONS = "@all_observations"

#: Set to ``1`` to make a guard violation an error (tests/conftest.py).
STRICT_ENV = "CAMSOCS_STRICT_STAGING"


class StagingGuardError(RuntimeError):
    """A stage wrote a staging directory it does not declare (strict mode)."""


class GuardedStage(Protocol):
    """What the write guard reads of a registry `Stage`."""

    @property
    def name(self) -> str: ...

    @property
    def writes(self) -> tuple[str, ...]: ...


def declares_write(writes: Iterable[str], directory: str) -> bool:
    """Whether a stage declaring `writes` may write `directory`."""
    declared = set(writes)
    if directory in declared:
        return True
    # The wildcard covers every source type and ``<type>.events`` directory
    # (classify restates them all), never the resolver's output nor a
    # directory beside them (`TALKS`).
    return ALL_OBSERVATIONS in declared and directory != RESOLVED and _is_directory_name(directory)


class StagingWriter:
    """Appends records to one staging file; publishes it on a clean exit."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.count = 0
        self._temporary = path.with_name(path.name + ".tmp")
        path.parent.mkdir(parents=True, exist_ok=True)
        self._handle = self._temporary.open("w", encoding="utf-8")

    def write(self, record: Record) -> None:
        self._handle.write(record.model_dump_json(exclude_none=True) + "\n")
        self.count += 1

    def write_all(self, records: Iterable[Record]) -> None:
        for record in records:
            self.write(record)

    def __enter__(self) -> Self:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self._handle.close()
        if exc_type is not None or self.count == 0:
            self._temporary.unlink(missing_ok=True)
            return
        self._temporary.replace(self.path)
        logger.info("staged %d records → %s", self.count, self.path)


class StagingStore:
    """Reads and writes `var/staging` (or the configured `CAMSOCS_STAGING_DIR`)."""

    def __init__(self, root: Path) -> None:
        self.root = root
        #: The stage the runner is running, whose `writes` the guard checks;
        #: `None` (no check) outside a run.
        self.active_stage: GuardedStage | None = None
        self._warned: set[tuple[str, str]] = set()

    def _guard(self, directory: str) -> None:
        """The advisory write guard (module docstring)."""
        stage = self.active_stage
        if stage is None or declares_write(stage.writes, directory):
            return
        message = (
            f"stage {stage.name} wrote staging directory {directory}, which its "
            f"registry entry does not declare (writes={list(stage.writes)})"
        )
        if os.environ.get(STRICT_ENV) == "1":
            raise StagingGuardError(message)
        if (stage.name, directory) not in self._warned:
            self._warned.add((stage.name, directory))
            logger.warning("staging guard: %s", message)

    def guard_write(self, directory: str) -> None:
        """The write guard for a file a stage writes itself, beside the
        observation directories (the talks pillar's `TALKS`): the stage must
        declare `directory` in its `writes`."""
        self._guard(directory)

    def path(self, directory: str, run_key: str, part: str | None = None) -> Path:
        name = _check_run_key(run_key)
        if _check_part(part):
            name += PART_SEPARATOR + part
        return self.root / _check_directory(directory) / f"{name}.jsonl"

    def writer(self, directory: str, run_key: str, part: str | None = None) -> StagingWriter:
        """``with store.writer("su_directory", ctx.run.run_key, ctx.report.name) as out: …``"""
        path = self.path(directory, run_key, part)
        self._guard(directory)
        return StagingWriter(path)

    def write(
        self, directory: str, run_key: str, records: Iterable[Record], part: str | None = None
    ) -> int:
        with self.writer(directory, run_key, part) as out:
            out.write_all(records)
            return out.count

    def latest_path(self, directory: str) -> Path | None:
        folder = self.root / _check_directory(directory)
        if not folder.is_dir():
            return None
        files = sorted(folder.glob("*.jsonl"))
        return files[-1] if files else None

    def read(self, path: Path) -> Iterator[Record]:
        with path.open(encoding="utf-8") as handle:
            for number, line in enumerate(handle, start=1):
                if not line.strip():
                    continue
                try:
                    yield _RECORD.validate_json(line)
                except ValueError as error:
                    raise ValueError(f"{path}:{number}: {error}") from error

    def latest_paths(self, directory: str) -> list[Path]:
        """The latest file of each part in `directory`, oldest part first."""
        folder = self.root / _check_directory(directory)
        if not folder.is_dir():
            return []
        latest: dict[str, Path] = {}
        for path in sorted(folder.glob("*.jsonl")):
            latest[_part_of(path)] = path
        return sorted(latest.values())

    def read_latest(self, directory: str, *, exclude_parts: Iterable[str] = ()) -> list[Record]:
        """Every record of the latest file of each part in `directory`, but
        the parts named in `exclude_parts` (a stage reading everything but
        its own previous output)."""
        excluded = set(exclude_parts)
        return [
            record
            for path in self.latest_paths(directory)
            if _part_of(path) not in excluded
            for record in self.read(path)
        ]

    def read_latest_part(self, directory: str, part: str) -> list[Record]:
        """Every record of the latest file of one part (a stage's own last output)."""
        paths = [path for path in self.latest_paths(directory) if _part_of(path) == part]
        return [record for path in paths for record in self.read(path)]

    def read_part_history(self, directory: str, part: str) -> list[Record]:
        """Every record of every file of one part still kept, oldest first (a
        stage restating what its earlier runs read: `prune-cache` keeps
        superseded files for its cutoff)."""
        folder = self.root / _check_directory(directory)
        if not folder.is_dir():
            return []
        paths = [path for path in sorted(folder.glob("*.jsonl")) if _part_of(path) == part]
        return [record for path in paths for record in self.read(path)]

    def write_shadowed(self, directory: str, readings: Iterable[ShadowedReading]) -> int:
        """Replaces the directory's shadowed readings with `readings` (ENG-47);
        none removes the file. Written to a temporary file and renamed."""
        path = self.root / _check_directory(directory) / SHADOWED_FILE
        self._guard(directory)
        rows = list(readings)
        if not rows:
            path.unlink(missing_ok=True)
            return 0
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + ".tmp")
        temporary.write_bytes(_SHADOWED.dump_json(rows, exclude_none=True))
        temporary.replace(path)
        return len(rows)

    def read_shadowed(self, directory: str) -> list[ShadowedReading]:
        """The directory's shadowed readings, or none."""
        path = self.root / _check_directory(directory) / SHADOWED_FILE
        if not path.is_file():
            return []
        try:
            return _SHADOWED.validate_json(path.read_bytes())
        except ValueError as error:
            raise ValueError(f"{path}: {error}") from error

    def directories(self) -> list[str]:
        """Every staging directory that holds at least one file, sources first."""
        if not self.root.is_dir():
            return []
        names = sorted(
            child.name
            for child in self.root.iterdir()
            if child.is_dir() and _is_directory_name(child.name) and any(child.glob("*.jsonl"))
        )
        return [name for name in names if name != RESOLVED] + (
            [RESOLVED] if RESOLVED in names else []
        )

    def read_all_latest(self) -> dict[str, list[Record]]:
        return {name: self.read_latest(name) for name in self.directories()}


__all__ = [
    "ALL_OBSERVATIONS",
    "EVENTS_SUFFIX",
    "PART_SEPARATOR",
    "RESOLVED",
    "SHADOWED_FILE",
    "STRICT_ENV",
    "Record",
    "StagingGuardError",
    "StagingStore",
    "StagingWriter",
    "declares_write",
    "events_directory",
    "is_events_directory",
]
