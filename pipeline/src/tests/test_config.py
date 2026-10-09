"""Configuration: require_* helpers, secret masking, and the honest User-Agent rule."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from camsocs_pipeline.config import (
    DEFAULT_ENV,
    DOCUMENTED_USER_AGENT,
    ENV_FILE,
    ENV_FILE_VARIABLE,
    REPO_ROOT,
    ConfigError,
    EnvChoice,
    Settings,
    choose_env,
    load_settings,
)


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
    [
        "",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "camsocs-bot/0.1 (+https://example.org/camsocs; ops@example.org)",
        "camsocs-bot/0.1 (mailto:ops at example.org)",
    ],
)
def test_the_user_agent_must_be_set_honest_and_without_an_email(make_settings, ua: str) -> None:
    with pytest.raises(ConfigError):
        make_settings(user_agent=ua).require_user_agent()


def test_the_documented_user_agent_is_accepted(make_settings) -> None:
    assert make_settings(user_agent=DOCUMENTED_USER_AGENT).require_user_agent() == (
        DOCUMENTED_USER_AGENT
    )


def test_the_error_suggests_no_email(make_settings) -> None:
    with pytest.raises(ConfigError) as error:
        make_settings(user_agent="").require_user_agent()
    assert "@" not in str(error.value)


def test_the_host_interval_is_at_least_one_second(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CAMSOCS_MIN_HOST_INTERVAL", "0")
    with pytest.raises(ValidationError):
        Settings(_env_file=None)


# --- environments (`--env`, CAMSOCS_ENV_FILE) --------------------------------------------------


def test_the_default_environment_is_dev_and_pipeline_env() -> None:
    choice = choose_env(None, environ={})
    assert choice == EnvChoice(DEFAULT_ENV, ENV_FILE)
    assert choice.is_default


def test_a_named_environment_reads_its_own_file() -> None:
    assert choose_env("prod", environ={}).path == REPO_ROOT / "pipeline" / ".env.prod"
    assert choose_env("dev", environ={}).path == ENV_FILE


@pytest.mark.parametrize("name", ["Prod", "../prod", "prod/x", "", "-prod"])
def test_environment_names_are_plain(name: str) -> None:
    with pytest.raises(ConfigError, match="not an environment name"):
        choose_env(name, environ={})


def test_env_file_variable_names_a_file_relative_to_the_repo() -> None:
    choice = choose_env(None, environ={ENV_FILE_VARIABLE: "pipeline/.env.prod"})
    assert choice == EnvChoice("prod", REPO_ROOT / "pipeline" / ".env.prod")
    custom = choose_env(None, environ={ENV_FILE_VARIABLE: "/tmp/somewhere.env"})
    assert custom.name == "custom"
    assert choose_env(None, environ={ENV_FILE_VARIABLE: "pipeline/.env"}).is_default


def test_the_flag_wins_over_the_variable() -> None:
    choice = choose_env("staging", environ={ENV_FILE_VARIABLE: "pipeline/.env.prod"})
    assert choice.name == "staging"


@pytest.fixture
def base_env(tmp_path, monkeypatch: pytest.MonkeyPatch):
    """A stand-in for pipeline/.env (the real one holds real keys and is never
    read by a test): the dev deployment plus shared LLM settings."""
    import camsocs_pipeline.config as config

    base = tmp_path / ".env"
    base.write_text(
        "CONVEX_HTTP_URL=https://hushed-rhinoceros-215.convex.site\n"
        "PIPELINE_API_KEY=dev-key\n"
        "LLM_MODEL_BULK=bulk-model\n"
    )
    monkeypatch.setattr(config, "ENV_FILE", base)
    return base


def test_a_missing_env_file_is_an_error_not_a_fallback(tmp_path, base_env) -> None:
    choice = EnvChoice("prod", tmp_path / ".env.prod")
    with pytest.raises(ConfigError, match="does not exist"):
        load_settings(choice, environ={})


def test_a_named_environment_layers_on_pipeline_env(tmp_path, base_env) -> None:
    env_file = tmp_path / ".env.prod"
    env_file.write_text(
        "CONVEX_HTTP_URL=https://calm-heron-42.convex.site/\nPIPELINE_API_KEY=prod-key\n"
    )
    settings = load_settings(EnvChoice("prod", env_file), environ={})
    assert settings.require_convex_http_url() == "https://calm-heron-42.convex.site"
    assert settings.require_pipeline_api_key() == "prod-key"
    # Shared settings come from pipeline/.env.
    assert settings.llm_model_bulk == "bulk-model"
    assert settings.state_path == REPO_ROOT / ".camsocs-state.prod.json"


def test_an_explicit_state_path_is_kept(tmp_path, base_env) -> None:
    env_file = tmp_path / ".env.prod"
    env_file.write_text(
        "CONVEX_HTTP_URL=https://calm-heron-42.convex.site\nPIPELINE_API_KEY=prod-key\n"
        f"CAMSOCS_STATE_PATH={tmp_path / 'state.json'}\n"
    )
    settings = load_settings(EnvChoice("prod", env_file), environ={})
    assert settings.state_path == tmp_path / "state.json"


@pytest.mark.parametrize(
    "content",
    [
        # Nothing about the deployment: dev's URL and key would be used.
        "LLM_MODEL_BULK=other\n",
        # A key but no URL: dev's URL would be used.
        "PIPELINE_API_KEY=prod-key\n",
        # CONVEX_URL alone: dev's CONVEX_HTTP_URL would win over it.
        "CONVEX_URL=https://calm-heron-42.convex.cloud\nPIPELINE_API_KEY=prod-key\n",
    ],
)
def test_deployment_variables_are_never_inherited_from_dev(tmp_path, base_env, content) -> None:
    env_file = tmp_path / ".env.prod"
    env_file.write_text(content)
    with pytest.raises(ConfigError, match="would come from"):
        load_settings(EnvChoice("prod", env_file), environ={})


def test_an_empty_value_unsets_an_inherited_variable(tmp_path, base_env) -> None:
    env_file = tmp_path / ".env.prod"
    env_file.write_text(
        "CONVEX_URL=https://calm-heron-42.convex.cloud\nCONVEX_HTTP_URL=\n"
        "PIPELINE_API_KEY=prod-key\n"
    )
    settings = load_settings(EnvChoice("prod", env_file), environ={})
    assert settings.require_convex_http_url() == "https://calm-heron-42.convex.site"


@pytest.mark.parametrize("variable", ["CONVEX_URL", "CONVEX_HTTP_URL", "PIPELINE_API_KEY"])
def test_a_shell_variable_may_not_override_a_named_env_file(
    tmp_path, base_env, monkeypatch: pytest.MonkeyPatch, variable: str
) -> None:
    env_file = tmp_path / ".env.prod"
    env_file.write_text(
        "CONVEX_HTTP_URL=https://calm-heron-42.convex.site\nPIPELINE_API_KEY=prod-key\n"
    )
    monkeypatch.setenv(variable, "https://hushed-rhinoceros-215.convex.site")
    with pytest.raises(ConfigError, match="would override"):
        load_settings(EnvChoice("prod", env_file))
