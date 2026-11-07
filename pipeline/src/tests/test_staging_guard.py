"""The advisory staging write guard (L6): strict in tests, a warning in production."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from pathlib import Path

import pytest

from camsocs_pipeline.models.observation import FetchInfo, IdentityHints, Observation
from camsocs_pipeline.pipeline.context import Stage, StageContext
from camsocs_pipeline.pipeline.sync import run_sync
from camsocs_pipeline.sources.observe import Harvest, run_harvest
from camsocs_pipeline.stages import STAGES
from camsocs_pipeline.staging.store import (
    RESOLVED,
    STRICT_ENV,
    StagingGuardError,
    StagingStore,
    declares_write,
)

RUN_KEY = "20261107T040000Z-abc123"


def observation(source_type: str = "su_directory") -> Observation:
    moment = datetime(2026, 11, 7, tzinfo=UTC)
    return Observation(
        source_type=source_type,
        source_key="probe",
        source_url="https://example.org/probe",
        retrieved_at=moment,
        fetch=FetchInfo(http_status=200, robots_verdict="allowed", robots_checked_at=moment),
        entity_type="organisation",
        identity=IdentityHints(name="Testford Chess Society"),
        fields=[],
    )


@pytest.mark.parametrize(
    ("writes", "directory", "allowed"),
    [
        (("su_directory", "su_profile"), "su_profile", True),
        (("su_directory",), "su_profile", False),
        (("camdram.events",), "camdram.events", True),
        (("camdram",), "camdram.events", False),
        (("camdram.events",), "camdram", False),
        (("@all_observations",), "society_website", True),
        (("@all_observations",), "ics_feed.events", True),
        (("@all_observations",), RESOLVED, False),
        ((RESOLVED,), RESOLVED, True),
        ((), "su_directory", False),
    ],
)
def test_declared_writes(writes: tuple[str, ...], directory: str, allowed: bool) -> None:
    assert declares_write(writes, directory) is allowed


def test_outside_a_run_nothing_is_checked(tmp_path: Path) -> None:
    store = StagingStore(tmp_path)
    assert store.write("su_directory", RUN_KEY, [observation()]) == 1


def test_strict_mode_refuses_an_undeclared_directory(tmp_path: Path) -> None:
    store = StagingStore(tmp_path)
    store.active_stage = Stage("proctors_register", writes=("proctors_register",))
    with pytest.raises(StagingGuardError, match="su_directory"):
        store.write("su_directory", RUN_KEY, [observation()])
    with pytest.raises(StagingGuardError):
        store.write_shadowed("su_directory", [])
    assert not (tmp_path / "su_directory").exists()
    assert store.write("proctors_register", RUN_KEY, [observation("proctors_register")]) == 1


def test_production_only_warns_once_per_stage_and_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.delenv(STRICT_ENV)
    store = StagingStore(tmp_path)
    store.active_stage = Stage("proctors_register", writes=("proctors_register",))
    with caplog.at_level(logging.WARNING, logger="camsocs_pipeline.staging.store"):
        assert store.write("su_directory", RUN_KEY, [observation()]) == 1
        assert store.write("su_directory", "20261107T050000Z-abc123", [observation()]) == 1
    warnings = [r for r in caplog.records if "staging guard" in r.getMessage()]
    assert len(warnings) == 1 and "proctors_register" in warnings[0].getMessage()


def test_the_runner_points_the_guard_at_each_stage_and_clears_it(make_settings) -> None:
    seen: list[object] = []
    stores: list[StagingStore] = []

    def writes_declared(ctx: StageContext) -> None:
        seen.append(ctx.staging.active_stage)
        stores.append(ctx.staging)
        ctx.staging.write("su_directory", ctx.run.run_key, [observation()], part="harvest_su")

    def writes_undeclared(ctx: StageContext) -> None:
        ctx.staging.write("camdram", ctx.run.run_key, [observation("camdram")], part="sneaky")

    declared = Stage("harvest_su", writes_declared, writes=("su_directory",))
    report = run_sync(
        settings=make_settings(),
        dry_run=True,
        registry=[declared, Stage("sneaky", writes_undeclared, writes=("cucbc",))],
    )

    assert seen == [declared]
    assert stores[0].active_stage is None, "cleared after the stage"
    ok, sneaky = report.stages
    assert ok.ok
    assert sneaky.status == "failed" and "StagingGuardError" in (sneaky.error or "")


def test_a_stand_in_without_writes_is_held_to_the_registry_entry_of_its_name(
    make_settings,
) -> None:
    def writes_resolved(ctx: StageContext) -> None:
        assert ctx.staging.active_stage is not None
        assert ctx.staging.active_stage.writes == (RESOLVED,)
        ctx.staging.write(RESOLVED, ctx.run.run_key, [observation()])

    report = run_sync(
        settings=make_settings(), dry_run=True, registry=[Stage("resolve", writes_resolved)]
    )
    assert report.ok, report.summary()


def test_run_harvest_counts_observations_staged(make_settings, monkeypatch) -> None:
    class NoClient:
        def __enter__(self):
            return self

        def __exit__(self, *_args: object) -> None:
            return None

    from camsocs_pipeline.pipeline.context import StageContext as Context
    from camsocs_pipeline.pipeline.load import ConvexLoader
    from camsocs_pipeline.pipeline.report import RunReport
    from camsocs_pipeline.pipeline.state import SyncState

    settings = make_settings()
    run = RunReport(RUN_KEY, "sync")
    ctx = Context(
        settings=settings,
        report=run.stage("su_directory"),
        run=run,
        loader=ConvexLoader("", "", dry_run=True),
        state=SyncState(),
        staging=StagingStore(settings.staging_dir),
        dry_run=False,
        limit=None,
    )

    def harvest(_client, _limit) -> Harvest:
        result = Harvest()
        result.add([observation(), observation("su_profile"), observation("su_profile")])
        return result

    monkeypatch.setattr(Context, "crawler", lambda _self: NoClient())
    run_harvest(ctx, "su_directory", harvest)
    assert ctx.report.metrics["observationsStaged"] == 3


def test_every_registry_write_names_a_staging_directory_or_the_wildcard() -> None:
    from camsocs_pipeline.staging.store import _is_directory_name

    for stage in STAGES:
        for directory in stage.writes:
            assert directory == "@all_observations" or _is_directory_name(directory), (
                stage.name,
                directory,
            )
