"""Configuration: require_* helpers, secret masking, and the honest User-Agent rule."""

from __future__ import annotations

import pytest

from camsocs_pipeline.config import ENV_FILE, REPO_ROOT, ConfigError, Settings


def test_paths_resolve_to_the_repo() -> None:
    assert (REPO_ROOT / "pipeline" / "pyproject.toml").exists()
    assert ENV_FILE == REPO_ROOT / "pipeline" / ".env"


def test_secrets_are_masked_in_repr(make_settings) -> None:
    settings = make_settings(pipeline_api_key="abc123secret", llm_api_key="llmsecret")
    assert "abc123secret" not in repr(settings)
    assert "llmsecret" not in repr(settings)
    assert settings.require_pipeline_api_key() == "abc123secret"


def test_the_site_url_is_derived_from_the_cloud_url(make_settings) -> None:
    settings = make_settings(convex_url="https://happy-otter-123.convex.cloud/")
    assert settings.require_convex_http_url() == "https://happy-otter-123.convex.site"


def test_an_explicit_http_url_wins(make_settings) -> None:
    settings = make_settings(
        convex_url="https://a-b-1.convex.cloud", convex_http_url="https://api.example.org/"
    )
    assert settings.require_convex_http_url() == "https://api.example.org"


def test_missing_values_raise_readable_errors(make_settings) -> None:
    settings = make_settings()
    with pytest.raises(ConfigError, match="CONVEX_HTTP_URL"):
        settings.require_convex_http_url()
    with pytest.raises(ConfigError, match="PIPELINE_API_KEY"):
        settings.require_pipeline_api_key()


def test_environment_variables_are_read(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CONVEX_HTTP_URL", "https://x-y-1.convex.site")
    monkeypatch.setenv("LLM_CONCURRENCY", "3")
    settings = Settings(_env_file=None)
    assert settings.convex_http_url == "https://x-y-1.convex.site"
    assert settings.llm_concurrency == 3


@pytest.mark.parametrize(
    "ua",
    ["", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"],
)
def test_the_user_agent_must_be_set_and_honest(make_settings, ua: str) -> None:
    with pytest.raises(ConfigError):
        make_settings(user_agent=ua).require_user_agent()


def test_an_honest_user_agent_is_accepted(make_settings) -> None:
    ua = "camsocs-bot/0.1 (+https://example.org/camsocs; ops@example.org)"
    assert make_settings(user_agent=ua).require_user_agent() == ua
