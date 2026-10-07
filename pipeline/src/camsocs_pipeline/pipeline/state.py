"""What one run needs to remember for the next one (Bundestracker state.py).

A JSON file (`CAMSOCS_STATE_PATH`, default `<repo>/.camsocs-state.json`,
gitignored). A file rather than a Convex table on purpose: it is operational
state about *fetching*, and a run must be able to decide what to fetch before
it can reach a deployment. Losing it costs a wider fetch, not correctness —
every write downstream is an upsert on a natural key.

Deliberately small for now; stages add their own watermarks/quarantines here
as they are implemented.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from pathlib import Path

from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class SyncState(BaseModel):
    """Everything a run inherits from the one before it."""

    last_run_key: str | None = None
    last_run_at: str | None = None
    last_run_ok: bool | None = None
    #: Stage name → when it last finished without error (ISO 8601).
    stage_last_success: dict[str, str] = Field(default_factory=dict)

    def record_run(self, run_key: str, ok: bool, succeeded: list[str]) -> None:
        now = datetime.now(UTC).isoformat()
        self.last_run_key = run_key
        self.last_run_at = now
        self.last_run_ok = ok
        for name in succeeded:
            self.stage_last_success[name] = now


def load_state(path: Path) -> SyncState:
    """Read the state file, or start empty. A corrupt file is logged and
    ignored — refusing to run over a cache file would be worse."""
    if not path.exists():
        return SyncState()
    try:
        return SyncState.model_validate_json(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        logger.warning("Could not read %s (%s) — starting from an empty state", path, error)
        return SyncState()


def save_state(path: Path, state: SyncState) -> None:
    """Write atomically (temp file + rename), so a killed run never leaves
    truncated JSON behind."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(
        json.dumps(state.model_dump(mode="json"), indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)
