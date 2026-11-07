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


def test_the_user_agent_defaults_to_the_documented_one() -> None:
    assert Settings(_env_file=None).user_agent == DOCUMENTED_USER_AGENT
    assert "https://camsocs.uk/about" in DOCUMENTED_USER_AGENT


def test_a_user_agent_without_the_about_page_is_used_with_a_warning(
    make_settings, caplog: pytest.LogCaptureFixture
) -> None:
    old = "camsocs-bot/0.1 (+https://old-host.example.org/about)"
    with caplog.at_level("WARNING", logger="camsocs_pipeline.config"):
        assert make_settings(user_agent=old).require_user_agent() == old
        make_settings(user_agent=old).require_user_agent()
    assert sum("does not link https://camsocs.uk/about" in r.message for r in caplog.records) == 1
    caplog.clear()
    with caplog.at_level("WARNING", logger="camsocs_pipeline.config"):
        make_settings(user_agent=DOCUMENTED_USER_AGENT).require_user_agent()
    assert not caplog.records


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


# --- the campus (decision D8) -------------------------------------------------------------------


@pytest.fixture
def zz_campus():
    from tests.campus_zz import registered

    with registered() as profile:
        yield profile


def test_the_campus_defaults_to_cambridge(make_settings) -> None:
    from camsocs_pipeline.campuses import CAMBRIDGE

    settings = make_settings()
    assert settings.campus == "cam"
    assert settings.profile() is CAMBRIDGE


def test_the_campus_is_read_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CAMSOCS_CAMPUS", "cam")
    assert Settings(_env_file=None).campus == "cam"


@pytest.mark.parametrize("campus", ["ox", "zz", "CAM", "cam.ac.uk", ""])
def test_an_unknown_campus_is_refused(campus: str) -> None:
    with pytest.raises(ValidationError, match="unknown campus"):
        Settings(_env_file=None, campus=campus)


def test_an_unknown_campus_flag_is_a_config_error(base_env) -> None:
    with pytest.raises(ConfigError, match="Unknown campus"):
        load_settings(EnvChoice(DEFAULT_ENV, base_env), environ={}, campus="ox")


def test_the_campus_flag_wins_over_an_unset_file(base_env, zz_campus) -> None:
    settings = load_settings(EnvChoice(DEFAULT_ENV, base_env), environ={}, campus="zz")
    assert settings.campus == "zz"
    assert settings.staging_dir == zz_campus.paths.staging
    assert settings.reports_dir == zz_campus.paths.reports


def test_a_campus_flag_contradicting_the_env_file_is_refused(base_env, zz_campus) -> None:
    base_env.write_text(base_env.read_text() + "CAMSOCS_CAMPUS=cam\n")
    with pytest.raises(ConfigError, match="--campus zz disagrees with CAMSOCS_CAMPUS=cam"):
        load_settings(EnvChoice(DEFAULT_ENV, base_env), environ={}, campus="zz")


def test_a_named_env_file_of_another_campus_states_it(tmp_path, base_env, zz_campus) -> None:
    deployment = "CONVEX_HTTP_URL=https://calm-heron-42.convex.site\nPIPELINE_API_KEY=zz-key\n"
    env_file = tmp_path / ".env.zz-prod"
    env_file.write_text(deployment)
    with pytest.raises(ConfigError, match=r"\.env\.zz-prod must state CAMSOCS_CAMPUS=zz"):
        load_settings(EnvChoice("zz-prod", env_file), environ={}, campus="zz")

    env_file.write_text(deployment + "CAMSOCS_CAMPUS=zz\n")
    settings = load_settings(EnvChoice("zz-prod", env_file), environ={})
    assert settings.campus == "zz"
    assert settings.staging_dir == REPO_ROOT / "var" / "campus" / "zz" / "staging"
    assert settings.state_path == REPO_ROOT / ".camsocs-state.zz-prod.json"
    # The same campus named twice is fine; another one is not.
    assert load_settings(EnvChoice("zz-prod", env_file), environ={}, campus="zz").campus == "zz"
    with pytest.raises(ConfigError, match="--campus cam disagrees with CAMSOCS_CAMPUS=zz"):
        load_settings(EnvChoice("zz-prod", env_file), environ={}, campus="cam")


def test_a_shell_campus_may_not_override_the_env_file(
    tmp_path, base_env, zz_campus, monkeypatch: pytest.MonkeyPatch
) -> None:
    env_file = tmp_path / ".env.zz-prod"
    env_file.write_text(
        "CONVEX_HTTP_URL=https://calm-heron-42.convex.site\nPIPELINE_API_KEY=zz-key\n"
        "CAMSOCS_CAMPUS=zz\n"
    )
    monkeypatch.setenv("CAMSOCS_CAMPUS", "cam")
    with pytest.raises(ConfigError, match="would override"):
        load_settings(EnvChoice("zz-prod", env_file))


def test_a_campus_flag_contradicting_the_shell_is_refused(
    base_env, zz_campus, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CAMSOCS_CAMPUS", "cam")
    with pytest.raises(ConfigError, match="in the shell"):
        load_settings(EnvChoice(DEFAULT_ENV, base_env), campus="zz")


def test_a_cambridge_env_file_needs_no_campus(tmp_path, base_env) -> None:
    env_file = tmp_path / ".env.prod"
    env_file.write_text(
        "CONVEX_HTTP_URL=https://calm-heron-42.convex.site\nPIPELINE_API_KEY=prod-key\n"
    )
    settings = load_settings(EnvChoice("prod", env_file), environ={})
    assert settings.campus == "cam"
    assert "campus" not in settings.model_fields_set


def test_the_user_agent_rule_reads_the_campus_about_page(zz_campus, caplog) -> None:
    settings = Settings(_env_file=None, campus="zz", user_agent=DOCUMENTED_USER_AGENT)
    with caplog.at_level("WARNING"):
        assert settings.require_user_agent() == DOCUMENTED_USER_AGENT
    # Cambridge's documented User-Agent does not link zz's About page.
    assert zz_campus.branding.about_url in caplog.text
