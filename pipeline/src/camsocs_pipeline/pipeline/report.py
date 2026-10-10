"""What one run did, stage by stage (Bundestracker sync.py StageReport/RunReport).

Collected rather than only logged so a run's summary is one object the CLI can
print, a test can assert on, and `runs.finish` can store — and so a stage that
failed is reported as failed rather than as absent.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

#: Mirrors `HARVEST_RUN_STATUSES` in webapp/lib/vocab.ts (status is derived
#: server-side; listed here so the two vocabularies are visibly the same).
RUN_STATUSES = ("running", "success", "partial", "failed")

#: Mirrors `HARVEST_STAGE_STATUSES` in webapp/lib/vocab.ts.
STAGE_STATUSES = ("ok", "failed", "not_run")
StageStatus = Literal["ok", "failed", "not_run"]


def mint_run_key(now: datetime | None = None) -> str:
    """A unique, sortable run key: `20261007T215500Z-3f9a1c`."""
    moment = (now or datetime.now(UTC)).astimezone(UTC)
    return f"{moment.strftime('%Y%m%dT%H%M%SZ')}-{secrets.token_hex(3)}"


@dataclass
class StageReport:
    name: str
    status: StageStatus = "ok"
    inserted: int = 0
    updated: int = 0
    unchanged: int = 0
    skipped: int = 0
    error: str | None = None
    notes: list[str] = field(default_factory=list)
    #: Named counts beyond the four above (`harvestStageResult.metrics`), e.g.
    #: the resolve stage's quarantine. Sent only when there are some.
    metrics: dict[str, int] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.status == "ok"

    def fail(self, error: str) -> None:
        self.status = "failed"
        self.error = error

    def to_payload(self) -> dict[str, Any]:
        """The `harvestStageResult` shape in webapp/convex/schema.ts. `metrics`
        is omitted when empty (never null, never an empty object to store)."""
        payload: dict[str, Any] = {
            "name": self.name,
            "status": self.status,
            "inserted": self.inserted,
            "updated": self.updated,
            "unchanged": self.unchanged,
            "skipped": self.skipped,
            "error": self.error,
            "notes": list(self.notes),
        }
        if self.metrics:
            payload["metrics"] = dict(self.metrics)
        return payload

    def __str__(self) -> str:
        if self.status == "failed":
            head = f"{self.name}: FAILED — {self.error}"
        elif self.status == "not_run":
            head = f"{self.name}: not run"
        elif self.inserted or self.updated or self.unchanged or self.skipped:
            head = (
                f"{self.name}: {self.inserted} new, {self.updated} updated, "
                f"{self.unchanged} unchanged, {self.skipped} skipped"
            )
        else:
            head = f"{self.name}: nothing to do"
        return head + "".join(f"\n    {note}" for note in self.notes)


@dataclass
class RunReport:
    run_key: str
    command: str
    dry_run: bool = False
    stages: list[StageReport] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    #: A failure outside any stage (health check, run-log write).
    error: str | None = None

    def stage(self, name: str) -> StageReport:
        report = StageReport(name)
        self.stages.append(report)
        return report

    @property
    def ok(self) -> bool:
        return self.error is None and all(stage.ok for stage in self.stages)

    def to_finish_payload(self) -> dict[str, Any]:
        """The `runs.finish` arguments (webapp/convex/runs.ts)."""
        return {
            "runKey": self.run_key,
            "stages": [stage.to_payload() for stage in self.stages],
            "warnings": list(self.warnings),
            "error": self.error,
        }

    def summary_payload(self) -> dict[str, Any]:
        """The run as JSON for a scheduler (`camsocs sync --summary-json`; the
        VPS runner's status file, docs/ops-vps.md): per-stage counts without
        the notes, one line per stage, and the coverage numbers the `report`
        stage measured (``None`` when it did not run)."""
        coverage = next(
            (dict(s.metrics) for s in self.stages if s.name == "report" and s.ok and s.metrics),
            None,
        )
        return {
            "runKey": self.run_key,
            "command": self.command,
            "dryRun": self.dry_run,
            "ok": self.ok,
            "error": self.error,
            "warnings": list(self.warnings),
            "stages": [
                {key: value for key, value in stage.to_payload().items() if key != "notes"}
                for stage in self.stages
            ],
            "summary": [str(stage).splitlines()[0] for stage in self.stages],
            "coverage": coverage,
        }

    def summary(self) -> str:
        mode = " (dry run — nothing written)" if self.dry_run else ""
        lines = [f"{self.command} {self.run_key}{mode}:"]
        lines.extend(f"  {stage}" for stage in self.stages)
        lines.extend(f"  warning: {warning}" for warning in self.warnings)
        if self.error:
            lines.append(f"  run error: {self.error}")
        return "\n".join(lines)
