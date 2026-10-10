"""Operations: `camsocs harvest` and its coverage report, and
`camsocs prune-cache` (retention R7)."""

from __future__ import annotations

import json
import os
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import httpx
import pytest
import respx
from click.testing import CliRunner

import camsocs_pipeline.pipeline.load as load
import camsocs_pipeline.pipeline.sync as sync_module
from camsocs_pipeline.cli import cli
from camsocs_pipeline.coverage_report import CoverageInputs, render_coverage_report
from camsocs_pipeline.models.wire import CoverageCounts, EventsCoveragePage
from camsocs_pipeline.pipeline.context import Stage
from camsocs_pipeline.pipeline.load import ConvexLoader
from camsocs_pipeline.pipeline.report import RunReport
from camsocs_pipeline.prune import parse_age, prune_cache, prune_staging
from camsocs_pipeline.stages import report as report_stage

SITE = "https://happy-otter-123.convex.site"
NOW = datetime(2026, 10, 9, 12, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def _no_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(load.time, "sleep", lambda _seconds: None)


def invoke(settings, *args: str):
    return CliRunner().invoke(cli, list(args), obj={"settings": settings})


def age(path: Path, days: float) -> None:
    moment = (NOW - timedelta(days=days)).timestamp()
    os.utime(path, (moment, moment))


# --- prune-cache ---------------------------------------------------------------------------


def test_ages_parse():
    assert parse_age("90d") == timedelta(days=90)
    assert parse_age("12w") == timedelta(weeks=12)
    assert parse_age(" 36H ") == timedelta(hours=36)
    for bad in ("90", "0d", "ninety days", "-1d"):
        with pytest.raises(ValueError):
            parse_age(bad)


def test_old_pages_go_as_a_group_and_recent_ones_stay(tmp_path: Path):
    cache = tmp_path / "cache"
    host = cache / "example.org"
    host.mkdir(parents=True)
    old = [host / "aaa.body", host / "aaa.json", host / "aaa.last-failure.json"]
    mixed = [host / "bbb.body", host / "bbb.json"]
    llm = cache / "llm" / "org_v1"
    llm.mkdir(parents=True)
    for path in [*old, *mixed, llm / "old.json", llm / "new.json"]:
        path.write_text("x")
    for path in old:
        age(path, 120)
    age(mixed[0], 120)
    age(mixed[1], 3)  # refreshed last week: the body stays with it
    age(llm / "old.json", 100)
    age(llm / "new.json", 1)
    gone_host = cache / "gone.example"
    gone_host.mkdir()
    (gone_host / "ccc.body").write_text("y")
    age(gone_host / "ccc.body", 400)

    dry = prune_cache(cache, timedelta(days=90), now=NOW, dry_run=True)
    assert dry.files == {"pages": 4, "llm": 1}
    assert all(path.exists() for path in old)

    result = prune_cache(cache, timedelta(days=90), now=NOW)
    assert result.files == {"pages": 4, "llm": 1}
    assert not any(path.exists() for path in old)
    assert all(path.exists() for path in mixed)
    assert (llm / "new.json").exists() and not (llm / "old.json").exists()
    assert not gone_host.exists()
    assert "deleted 5 files" in result.summary(dry_run=False)


def test_superseded_staging_files_go_but_the_latest_of_each_part_stays(tmp_path: Path):
    folder = tmp_path / "staging" / "society_website"
    folder.mkdir(parents=True)
    names = [
        "20260701T000000Z-aaaaaa--enrich.jsonl",
        "20260702T000000Z-bbbbbb--enrich.jsonl",
        "20260701T000000Z-aaaaaa--colleges.jsonl",
    ]
    for name in names:
        (folder / name).write_text("")
        age(folder / name, 100)
    result = prune_staging(tmp_path / "staging", timedelta(days=90), now=NOW)
    assert result.files == {"staging": 1}
    assert sorted(path.name for path in folder.iterdir()) == sorted(names[1:])


def test_the_command_reports_and_respects_dry_run(make_settings):
    settings = make_settings()
    page = settings.cache_dir / "example.org" / "aaa.body"
    page.parent.mkdir(parents=True)
    page.write_text("x")
    os.utime(page, (0, 0))
    dry = invoke(settings, "prune-cache", "--dry-run")
    assert dry.exit_code == 0, dry.output
    assert "would delete 1 files" in dry.output and page.exists()
    done = invoke(settings, "prune-cache", "--older-than", "30d")
    assert done.exit_code == 0, done.output
    assert "deleted 1 files" in done.output and not page.exists()
    bad = invoke(settings, "prune-cache", "--older-than", "soon")
    assert bad.exit_code != 0


# --- the coverage report -------------------------------------------------------------------


COUNTS = CoverageCounts(
    total=800,
    hidden=2,
    counterparts=160,
    by_level={"university": 260, "unknown": 540},
    by_status={"active": 700, "unknown": 100},
    by_level_status={"university": {"active": 260}, "unknown": {"active": 440, "unknown": 100}},
    by_org_type={"society": 200, "unknown": 600},
    headline={"email": 512, "website": 400, "instagram": 568, "description": 600},
    held={"name": 800, "website": 400, "categories": 440},
    missing={"logo": 736, "membership": 704, "website": 400},
)
EVENTS = EventsCoveragePage(
    by_source={"camdram": 207, "termcard": 22, "talks_cam": 5},
    by_visibility={"public": 234},
    cancelled=1,
    rows=235,
    is_done=True,
    continue_cursor="",
)


def test_the_report_has_counts_and_shares_per_field_events_and_the_missing_top():
    run = RunReport(run_key="20261009T040000Z-abcdef", command="sync")
    resolve = run.stage("resolve")
    resolve.inserted = 1982
    resolve.metrics.update(quarantineHeld=8, quarantineDropped=0, quarantineReview=18)
    run.stage("report")
    text = render_coverage_report(
        CoverageInputs(
            counts=COUNTS,
            rows=960,
            events=EVENTS,
            events_from=date(2026, 10, 9),
            generated_at=NOW,
            deployment=SITE,
        ),
        run,
    )
    assert text.startswith("# Coverage report — 2026-10-09")
    assert "`happy-otter-123.convex.site`" in text and "test-key" not in text
    assert "| Listed organisations | 800 |" in text
    assert "| website | 400 | 50% | 400 |" in text
    assert "| name | 800 | 100% |  |" in text
    assert "| logo | 0 | 0% | 736 |" in text  # held by none, the most missed
    assert "| camdram | 207 |" in text and "| **total** | 234 |" in text
    assert "cancelled 1" in text
    assert "8 held, 0 references dropped, 18 matches to review" in text
    assert "| resolve | ok | 1982 |" in text and "| report |" not in text
    missing = text.split("## Most often missing")[1]
    assert missing.index("| logo |") < missing.index("| membership |")


def test_the_stage_reads_the_deployment_and_writes_the_report(make_settings, net: respx.MockRouter):
    pages = iter(
        [
            {
                "counts": COUNTS.to_wire() | {"total": 500},
                "rows": 100,
                "isDone": False,
                "continueCursor": "c1",
            },
            {
                "counts": COUNTS.to_wire() | {"total": 300},
                "rows": 60,
                "isDone": True,
                "continueCursor": "",
            },
        ]
    )
    coverage = net.post(f"{SITE}/api/pipeline/coverage").mock(
        side_effect=lambda _request: httpx.Response(200, json=next(pages))
    )
    events = net.post(f"{SITE}/api/pipeline/coverage/events").respond(200, json=EVENTS.to_wire())
    settings = make_settings()
    loader = ConvexLoader(SITE, "test-key", max_retries=0)
    run = sync_module.RunReport(run_key="r", command="sync")
    from camsocs_pipeline.pipeline.context import StageContext
    from camsocs_pipeline.pipeline.state import SyncState
    from camsocs_pipeline.staging.store import StagingStore

    ctx = StageContext(
        settings=settings,
        report=run.stage("report"),
        run=run,
        loader=loader,
        state=SyncState(),
        staging=StagingStore(settings.staging_dir),
        dry_run=False,
        limit=None,
    )
    report_stage.run(ctx)
    assert coverage.call_count == 2
    assert json.loads(coverage.calls[1].request.content)["cursor"] == "c1"
    assert "from" in json.loads(events.calls[0].request.content)
    written = list(settings.reports_dir.glob("coverage-*.md"))
    assert len(written) == 1
    assert "| Listed organisations | 800 |" in written[0].read_text()
    assert ctx.report.metrics == {"listed": 800, "upcomingEvents": 234}


def test_a_dry_run_harvest_runs_every_stage_in_order_and_writes_no_report(
    make_settings, monkeypatch
):
    ran: list[str] = []

    def stage(name: str) -> Stage:
        return Stage(name, lambda ctx, name=name: ran.append(name))

    registry = [stage("term_dates"), stage("resolve"), stage("load"), Stage("report")]
    monkeypatch.setattr(sync_module, "STAGES", registry)
    settings = make_settings()
    result = invoke(settings, "harvest", "--dry-run")
    assert result.exit_code == 0, result.output
    assert ran == ["term_dates", "resolve", "load"]
    assert "dry run: no coverage report" in result.output
    assert not settings.reports_dir.exists() or not list(settings.reports_dir.glob("*.md"))


def test_what_quotes_list_mail_goes_after_thirty_days(tmp_path: Path):
    cache = tmp_path / "cache"
    mail_replies = cache / "llm" / "email_events_v1"
    pages = cache / "llm" / "org_v1"
    mail_replies.mkdir(parents=True)
    pages.mkdir(parents=True)
    for path in (mail_replies / "old.json", mail_replies / "new.json", pages / "mid.json"):
        path.write_text("x")
    age(mail_replies / "old.json", 40)
    age(mail_replies / "new.json", 5)
    age(pages / "mid.json", 40)
    result = prune_cache(cache, timedelta(days=90), now=NOW)
    assert result.files == {"llm": 1}
    assert not (mail_replies / "old.json").exists() and (pages / "mid.json").exists()

    staging = tmp_path / "staging"
    mail = staging / "mailing_list_email"
    mail.mkdir(parents=True)
    latest = mail / "20260901T000000Z-aaaaaa--inbox.jsonl"
    latest.write_text("{}\n")
    age(latest, 40)
    # The latest file of the mail's staging goes too: inbox posted it already.
    assert prune_staging(staging, timedelta(days=90), now=NOW).files == {"staging": 1}
