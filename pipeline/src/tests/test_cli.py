"""The CLI: exit codes, and that no command ever prints a secret."""

from __future__ import annotations

import pytest
import respx
from click.testing import CliRunner

import camsocs_pipeline.pipeline.sync as sync_module
from camsocs_pipeline.cli import cli

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
    result = invoke(make_settings(), "sync", "--dry-run", "--stages", "discover,fetch")
    assert result.exit_code == 0, result.output
    assert "dry run" in result.output
    assert "discover" in result.output and "parse" not in result.output


def test_sync_exits_non_zero_when_a_stage_fails(make_settings, monkeypatch) -> None:
    def boom(_ctx):
        raise RuntimeError("source down")

    monkeypatch.setitem(sync_module.STAGES, "fetch", boom)
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
