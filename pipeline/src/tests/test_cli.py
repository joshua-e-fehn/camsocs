"""The CLI: exit codes, and that no command ever prints a secret."""

from __future__ import annotations

import json

import pytest
import respx
from click.testing import CliRunner

import camsocs_pipeline.pipeline.sync as sync_module
from camsocs_pipeline.cli import cli
from camsocs_pipeline.pipeline.context import Stage

SITE = "https://happy-otter-123.convex.site"
SECRET = "super-secret-pipeline-key-do-not-print"
LLM_SECRET = "super-secret-llm-key-do-not-print"


def invoke(settings, *args: str):
    return CliRunner().invoke(cli, list(args), obj={"settings": settings})


def test_status_shows_secrets_only_as_set(make_settings) -> None:
    settings = make_settings(
        convex_http_url=SITE,
        pipeline_api_key=SECRET,
        llm_api_key=LLM_SECRET,
        llm_model_bulk="bulk-1",
        llm_model_strong="claude-3-opus",
    )

    result = invoke(settings, "status")

    assert result.exit_code == 0, result.output
    assert SECRET not in result.output
    assert LLM_SECRET not in result.output
    assert "Pipeline key:" in result.output and "set" in result.output
    assert "REFUSED" in result.output, "a claude model is flagged, not hidden"
    assert SITE in result.output


def test_status_works_with_nothing_configured(make_settings) -> None:
    result = invoke(make_settings(user_agent=""), "status")
    assert result.exit_code == 0, result.output
    assert "(unset)" in result.output
    assert "(never)" in result.output


def test_sync_dry_run_exits_zero_without_credentials(make_settings) -> None:
    result = invoke(make_settings(), "sync", "--dry-run", "--stages", "term_dates")
    assert result.exit_code == 0, result.output
    assert "dry run" in result.output
    assert "term_dates" in result.output and "load" not in result.output


def test_sync_exits_non_zero_when_a_stage_fails(make_settings, monkeypatch) -> None:
    def boom(_ctx):
        raise RuntimeError("source down")

    monkeypatch.setattr(sync_module, "STAGES", [Stage("boom", boom)])
    result = invoke(make_settings(), "sync", "--dry-run")
    assert result.exit_code == 1
    assert "FAILED" in result.output


def test_sync_rejects_unknown_stages(make_settings) -> None:
    result = invoke(make_settings(), "sync", "--dry-run", "--stages", "fetch,nope")
    assert result.exit_code == 1
    assert "nope" in result.output


def test_sync_without_dry_run_needs_credentials(make_settings) -> None:
    result = invoke(make_settings(), "sync")
    assert result.exit_code == 1
    assert "CONVEX_HTTP_URL" in result.output


def test_health_ok(make_settings, net: respx.MockRouter) -> None:
    net.get(f"{SITE}/api/pipeline/health").respond(200, json={"ok": True})
    result = invoke(make_settings(convex_http_url=SITE, pipeline_api_key=SECRET), "health")
    assert result.exit_code == 0, result.output
    assert SECRET not in result.output


@pytest.mark.parametrize("status", [401])
def test_health_rejected_key(make_settings, net: respx.MockRouter, status: int) -> None:
    net.get(f"{SITE}/api/pipeline/health").respond(status, json={"error": "Unauthorized"})
    result = invoke(make_settings(convex_http_url=SITE, pipeline_api_key=SECRET), "health")
    assert result.exit_code == 1
    assert "PIPELINE_API_KEY" in result.output
    assert SECRET not in result.output


def test_status_names_the_environment(make_settings) -> None:
    result = invoke(make_settings(), "status")
    assert result.exit_code == 0, result.output
    assert "Environment:" in result.output and "dev (pipeline/.env)" in result.output


def test_purge_dev_refuses_another_environment(make_settings, tmp_path) -> None:
    from camsocs_pipeline.config import EnvChoice

    settings = make_settings(convex_http_url=SITE, pipeline_api_key=SECRET)
    result = CliRunner().invoke(
        cli,
        ["purge-dev", "--yes"],
        obj={"settings": settings, "env": EnvChoice("prod", tmp_path / ".env.prod")},
    )
    assert result.exit_code == 1
    assert "dev environment only" in result.output


def test_an_unknown_env_file_fails_before_anything_runs(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("CAMSOCS_ENV_FILE", str(tmp_path / ".env.nowhere"))
    result = CliRunner().invoke(cli, ["status"], obj={})
    assert result.exit_code == 1
    assert "does not exist" in result.output


# --- scheduled runs: groups, --env after the command, the JSON summary (D5) ---------------


def test_env_may_follow_the_command(tmp_path) -> None:
    # What `pixi run harvest -- --env NAME` and `pixi run harvest-events -- --env NAME`
    # produce. A missing pipeline/.env.<name> is an error, never a fall-back to dev.
    for args in (
        ["harvest", "--dry-run", "--env", "nowhere"],
        ["sync", "--group", "events", "--dry-run", "--env", "nowhere"],
    ):
        result = CliRunner().invoke(cli, args, obj={})
        assert result.exit_code == 1, result.output
        assert ".env.nowhere does not exist" in result.output


def test_two_different_envs_are_refused() -> None:
    result = CliRunner().invoke(cli, ["--env", "prod", "sync", "--env", "staging"], obj={})
    assert result.exit_code == 2
    assert "already given" in result.output


def test_a_group_without_its_inputs_fails_and_says_so_in_the_summary(
    make_settings, tmp_path
) -> None:
    summary = tmp_path / "out" / "run.json"
    result = invoke(
        make_settings(), "sync", "--group", "events", "--dry-run", "--summary-json", str(summary)
    )
    assert result.exit_code == 1
    assert "--group full" in result.output
    written = json.loads(summary.read_text())
    assert written["ok"] is False and written["group"] == "events"
    assert "holds no _resolved, society_website, su_profile yet" in written["error"]


def test_an_unknown_group_is_refused(make_settings) -> None:
    result = invoke(make_settings(), "sync", "--group", "daily", "--dry-run")
    assert result.exit_code == 1
    assert "Unknown group: daily" in result.output


def test_the_summary_json_records_the_run(make_settings, tmp_path) -> None:
    summary = tmp_path / "run.json"
    result = invoke(
        make_settings(),
        "sync",
        "--dry-run",
        "--stages",
        "term_dates",
        "--summary-json",
        str(summary),
    )
    assert result.exit_code == 0, result.output
    written = json.loads(summary.read_text())
    assert written["ok"] is True and written["dryRun"] is True
    assert written["environment"] == "dev" and written["group"] is None
    assert written["command"] == "sync"
    assert [stage["name"] for stage in written["stages"]] == ["term_dates"]
    assert written["summary"][0].startswith("term_dates:")
    assert written["coverage"] is None
    assert not list(tmp_path.glob(".*.tmp")), "written whole, through a temporary file"
