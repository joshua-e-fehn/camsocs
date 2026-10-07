"""The seed harvest stages: registered in order, staged per source type under
their own part, and silent in a dry run."""

from __future__ import annotations

from datetime import UTC, datetime

from camsocs_pipeline.claims import parser_field
from camsocs_pipeline.models.observation import IdentityHints, Observation
from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.pipeline.load import ConvexLoader
from camsocs_pipeline.pipeline.report import RunReport
from camsocs_pipeline.pipeline.state import SyncState
from camsocs_pipeline.pipeline.sync import STAGE_ORDER
from camsocs_pipeline.sources.observe import Harvest, missing_reason, run_harvest
from camsocs_pipeline.staging.store import StagingStore
from tests.seedkit import failed

SEED_STAGES = ["sport_clubs", "sport_guide_pdf", "camdram_societies", "cucbc_clubs", "colleges"]


def test_seed_stages_run_after_term_dates_and_before_load() -> None:
    positions = [STAGE_ORDER.index(name) for name in SEED_STAGES]
    assert positions == sorted(positions)
    assert STAGE_ORDER.index("term_dates") < positions[0]
    assert positions[-1] < STAGE_ORDER.index("load")


def context(make_settings, *, dry_run: bool = False, limit: int | None = None) -> StageContext:
    settings = make_settings()
    run = RunReport(run_key="20261007T120000Z-abcdef", command="sync", dry_run=dry_run)
    return StageContext(
        settings=settings,
        report=run.stage("sport_clubs"),
        run=run,
        loader=ConvexLoader("", "", dry_run=True),
        state=SyncState(),
        staging=StagingStore(settings.staging_dir),
        dry_run=dry_run,
        limit=limit,
    )


def observation(source_type: str, name: str) -> Observation:
    return Observation(
        source_type=source_type,
        source_key=name,
        source_url="https://www.sport.cam.ac.uk/x",
        retrieved_at=datetime(2026, 10, 7, 12, tzinfo=UTC),
        entity_type="organisation",
        identity=IdentityHints(name=name),
        fields=[parser_field("name", name, extractor="t", evidence="secondary")],
    )


def test_run_harvest_stages_each_source_type_under_the_stage_part(make_settings) -> None:
    ctx = context(make_settings, limit=3)
    seen_limits: list[int | None] = []

    def harvest(_client, limit):
        seen_limits.append(limit)
        out = Harvest(notes=["2 clubs"])
        out.add([observation("sport_az", "A"), observation("sport_club_page", "A page")])
        return out

    run_harvest(ctx, "sport_az", harvest)

    assert seen_limits == [3]
    assert ctx.report.inserted == 2
    path = ctx.staging.path("sport_az", ctx.run.run_key, "sport_clubs")
    assert path.exists()
    assert [r.identity.name for r in ctx.staging.read_latest("sport_club_page")] == ["A page"]
    assert "2 clubs" in ctx.report.notes


def test_a_dry_run_fetches_and_stages_nothing(make_settings) -> None:
    ctx = context(make_settings, dry_run=True)

    def harvest(_client, _limit):
        raise AssertionError("a dry run must not harvest")

    assert run_harvest(ctx, "sport_az", harvest) is None
    assert ctx.staging.directories() == []
    assert ctx.report.notes == ["dry run: nothing fetched or staged"]


def test_failed_fetches_map_to_missing_reasons() -> None:
    url = "https://x.example/"
    assert missing_reason(failed(url, "not_found", 404)) == "not_found"
    assert missing_reason(failed(url, "access_restricted", 403)) == "access_restricted"
    assert missing_reason(failed(url, "disallowed_by_robots", detail="disallowed")) == (
        "access_restricted"
    )
    assert (
        missing_reason(
            failed(url, "disallowed_by_robots", detail="robots.txt unreachable: ConnectError")
        )
        == "unreachable"
    )
    assert missing_reason(failed(url, "unreachable", detail="timeout")) == "unreachable"
