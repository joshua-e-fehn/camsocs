"""Runtime configuration, read from `pipeline/.env` and the environment.

**Which deployment.** `pipeline/.env` targets the dev deployment. A run for
another environment reads its own file: `camsocs --env prod …` reads
`pipeline/.env.prod`, or `CAMSOCS_ENV_FILE=<path>` names a file directly (a
relative path is relative to the repo root; `--env` wins when both are given;
`choose_env`). Such a file must exist — a
missing one is an error, never a silent fall-back to the shell — and the
deployment variables (`CONVEX_URL`, `CONVEX_HTTP_URL`, `PIPELINE_API_KEY`) must
then come from it alone: exported in the shell they would override the file
(process environment beats dotenv), the `CONVEX_DEPLOY_KEY` lesson
(AGENTS.md). A non-dev environment also keeps its own run state
(`.camsocs-state.<name>.json`) unless `CAMSOCS_STATE_PATH` says otherwise; the
web cache and the staging area are shared, so one harvest can be loaded into
both deployments.

Every setting the pipeline needs to reach the outside world lives here, so a
misconfigured host fails once with a readable message rather than at the first
HTTP call with a `None` in the URL. Pattern from Bundestracker config.py.

Secrets are `SecretStr`: their `repr`/`str` is masked, so logging a `Settings`
object, an exception carrying one, or `status` output never prints a key. Read
the value only at the point of use with `.get_secret_value()`.

Required values are not required *fields*: `--dry-run` and `status` must work
on a host with no credentials, so each write path calls a `require_*` method
instead, which raises `ConfigError` with what to set.
"""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

# python-dotenv is pydantic-settings' own dotenv reader (a required dependency).
from dotenv import dotenv_values
from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

#: `<repo>/pipeline/src/camsocs_pipeline/config.py` → `<repo>`.
REPO_ROOT = Path(__file__).resolve().parents[3]
PIPELINE_DIR = REPO_ROOT / "pipeline"

#: Read wherever the command runs from (pixi runs it in `pipeline/`, cron in $HOME).
#: The dev deployment's file; other environments use `pipeline/.env.<name>`.
ENV_FILE = PIPELINE_DIR / ".env"

#: The environment `pipeline/.env` belongs to.
DEFAULT_ENV = "dev"
#: Names a settings file directly, instead of `--env <name>`.
ENV_FILE_VARIABLE = "CAMSOCS_ENV_FILE"
#: Settings that pick the deployment a run writes to. For any env file other
#: than `pipeline/.env` they must not be exported in the shell.
TARGET_VARIABLES = ("CONVEX_URL", "CONVEX_HTTP_URL", "PIPELINE_API_KEY")
_ENV_NAME = re.compile(r"[a-z][a-z0-9-]{0,31}")

#: Raw response cache. Under the repo, gitignored (`var/`), never committed.
DEFAULT_CACHE_DIR = REPO_ROOT / "var" / "cache"

#: Staged observations between harvest and load (staging/store.py). Gitignored.
DEFAULT_STAGING_DIR = REPO_ROOT / "var" / "staging"

#: What a run remembers for the next one. Gitignored.
DEFAULT_STATE_PATH = REPO_ROOT / ".camsocs-state.json"

#: Reports for Joshua (the mailing-list worklist). Gitignored (`var/`): they
#: name organisations and list addresses, not people, but stay local anyway.
DEFAULT_REPORTS_DIR = REPO_ROOT / "var" / "reports"

#: Graph API version for Instagram Business Discovery (source-research §17;
#: v25.0 was the latest on 2026-10-07). Override with META_GRAPH_VERSION.
DEFAULT_META_GRAPH_VERSION = "v25.0"

#: A Convex deployment answers on two hosts. The generated client API is on
#: `convex.cloud`; anything on the `httpRouter` — which `/api/pipeline/*` is — is
#: on `convex.site`. Posting to the cloud host returns a 404 that looks exactly
#: like a missing route, so the conversion happens here once.
CONVEX_API_HOST_SUFFIX = ".convex.cloud"
CONVEX_SITE_HOST_SUFFIX = ".convex.site"

DEFAULT_LLM_CONCURRENCY = 8
DEFAULT_MIN_HOST_INTERVAL = 1.0
#: The User-Agent source-research "Global rules" documents: a token and the
#: About page, never an email address.
DOCUMENTED_USER_AGENT = "camsocs-bot/0.1 (+https://camsocs.vercel.app/about)"


class ConfigError(RuntimeError):
    """A required setting is missing or malformed."""


class Settings(BaseSettings):
    """Pipeline settings, sourced from environment variables and `pipeline/.env`."""

    model_config = SettingsConfigDict(
        env_file=ENV_FILE,
        env_file_encoding="utf-8",
        extra="ignore",
        validate_by_name=True,
        validate_by_alias=True,
    )

    convex_url: str = Field(default="", validation_alias="CONVEX_URL")
    convex_http_url: str = Field(default="", validation_alias="CONVEX_HTTP_URL")
    pipeline_api_key: SecretStr = Field(default=SecretStr(""), validation_alias="PIPELINE_API_KEY")

    llm_base_url: str = Field(default="", validation_alias="LLM_BASE_URL")
    llm_api_key: SecretStr = Field(default=SecretStr(""), validation_alias="LLM_API_KEY")
    llm_model_bulk: str = Field(default="", validation_alias="LLM_MODEL_BULK")
    llm_model_strong: str = Field(default="", validation_alias="LLM_MODEL_STRONG")
    llm_concurrency: int = Field(
        default=DEFAULT_LLM_CONCURRENCY, ge=1, le=64, validation_alias="LLM_CONCURRENCY"
    )

    user_agent: str = Field(default="", validation_alias="CAMSOCS_USER_AGENT")
    cache_dir: Path = Field(default=DEFAULT_CACHE_DIR, validation_alias="CAMSOCS_CACHE_DIR")
    staging_dir: Path = Field(default=DEFAULT_STAGING_DIR, validation_alias="CAMSOCS_STAGING_DIR")
    state_path: Path = Field(default=DEFAULT_STATE_PATH, validation_alias="CAMSOCS_STATE_PATH")
    reports_dir: Path = Field(default=DEFAULT_REPORTS_DIR, validation_alias="CAMSOCS_REPORTS_DIR")
    #: Seconds between two requests to one host: at least 1 (source-research
    #: "Global rules"). Tests that must not wait replace it after validation.
    min_host_interval: float = Field(
        default=DEFAULT_MIN_HOST_INTERVAL, ge=1.0, validation_alias="CAMSOCS_MIN_HOST_INTERVAL"
    )

    #: Optional. A Camdram API access token (source-research §5): sent as a
    #: Bearer header when set; without one the events stage paces itself
    #: more gently, since unauthenticated calls get "very low" rate limits.
    camdram_api_key: SecretStr = Field(default=SecretStr(""), validation_alias="CAMDRAM_API_KEY")

    #: Instagram Business Discovery (source-research §17). Both unset → the
    #: `instagram` stage skips itself ("not configured") and exits cleanly.
    meta_ig_user_id: str = Field(default="", validation_alias="META_IG_USER_ID")
    meta_access_token: SecretStr = Field(
        default=SecretStr(""), validation_alias="META_ACCESS_TOKEN"
    )
    meta_graph_version: str = Field(
        default=DEFAULT_META_GRAPH_VERSION, validation_alias="META_GRAPH_VERSION"
    )

    @field_validator("convex_url", "convex_http_url", "llm_base_url")
    @classmethod
    def _strip_trailing_slash(cls, value: str) -> str:
        # Every caller builds URLs as f"{base}/path".
        return value.strip().rstrip("/")

    @field_validator(
        "llm_model_bulk", "llm_model_strong", "user_agent", "meta_ig_user_id", "meta_graph_version"
    )
    @classmethod
    def _strip(cls, value: str) -> str:
        return value.strip()

    # -- Convex --------------------------------------------------------------

    def require_convex_http_url(self) -> str:
        """The Convex HTTP endpoint (`…convex.site`), or a readable error.

        Falls back to `CONVEX_URL` with the host rewritten; the explicit
        variable wins, for a deployment served from a custom domain.
        """
        if self.convex_http_url:
            return self.convex_http_url
        if not self.convex_url:
            raise ConfigError(
                "CONVEX_HTTP_URL is not set. Point it at the deployment's HTTP endpoint, "
                "e.g. https://<deployment>.convex.site (pipeline/.env)."
            )
        if self.convex_url.endswith(CONVEX_API_HOST_SUFFIX):
            return self.convex_url[: -len(CONVEX_API_HOST_SUFFIX)] + CONVEX_SITE_HOST_SUFFIX
        raise ConfigError(
            f"CONVEX_HTTP_URL is not set and CONVEX_URL does not end in "
            f"{CONVEX_API_HOST_SUFFIX}, so the site URL cannot be derived from it."
        )

    def require_pipeline_api_key(self) -> str:
        """The ingestion key, or a readable error. Checked before a run rather
        than at the first POST: the deployment denies on an unset key."""
        value = self.pipeline_api_key.get_secret_value()
        if not value:
            raise ConfigError(
                "PIPELINE_API_KEY is not set. It must equal the value on the Convex "
                'deployment (`bunx convex env set PIPELINE_API_KEY "…"`).'
            )
        return value

    # -- LLM -----------------------------------------------------------------

    def require_llm(self) -> LLMSettings:
        """Everything `extract.llm.LLMClient` needs, validated — including the
        model-id guard, so a refused model fails here, before any request."""
        # Imported here: extract.llm imports this module.
        from camsocs_pipeline.extract.llm import assert_model_allowed

        missing = [
            name
            for name, value in (
                ("LLM_BASE_URL", self.llm_base_url),
                ("LLM_API_KEY", self.llm_api_key.get_secret_value()),
                ("LLM_MODEL_BULK", self.llm_model_bulk),
                ("LLM_MODEL_STRONG", self.llm_model_strong),
            )
            if not value
        ]
        if missing:
            raise ConfigError(f"LLM is not configured: set {', '.join(missing)} (pipeline/.env).")
        return LLMSettings(
            base_url=self.llm_base_url,
            api_key=self.llm_api_key,
            model_bulk=assert_model_allowed(self.llm_model_bulk),
            model_strong=assert_model_allowed(self.llm_model_strong),
            concurrency=self.llm_concurrency,
        )

    # -- Meta ------------------------------------------------------------------

    @property
    def meta_configured(self) -> bool:
        """Whether Instagram Business Discovery can run (both values set)."""
        return bool(self.meta_ig_user_id and self.meta_access_token.get_secret_value())

    # -- crawling ------------------------------------------------------------

    def require_user_agent(self) -> str:
        """The crawler's User-Agent, or a readable error.

        Honest by rule: it names this crawler and a page about it, so a
        webmaster can recognise it and ask us to slow down. A browser-like
        string is refused — disguising the crawler would be a way around a
        site's robots.txt — and so is any email address: the User-Agent goes to
        every site we fetch, and it contains no personal email
        (source-research "Global rules"); the contact is the About page.
        """
        ua = self.user_agent
        if not ua:
            raise ConfigError(
                "CAMSOCS_USER_AGENT is not set. Use the documented crawler token, "
                f'"{DOCUMENTED_USER_AGENT}".'
            )
        if "mozilla/" in ua.lower():
            raise ConfigError(
                "CAMSOCS_USER_AGENT looks like a browser. The crawler must identify itself."
            )
        if "@" in ua or "mailto:" in ua.lower():
            raise ConfigError(
                "CAMSOCS_USER_AGENT contains an email address. It must not: link the About "
                f'page instead, "{DOCUMENTED_USER_AGENT}".'
            )
        return ua


class LLMSettings(BaseModel):
    """The validated LLM configuration handed to `LLMClient`.

    A plain model, not `BaseSettings`: it must never read the environment
    itself (a stray `API_KEY` or `BASE_URL` would silently win). Built only by
    `Settings.require_llm`, or directly in tests.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    base_url: str
    api_key: SecretStr
    model_bulk: str
    model_strong: str
    concurrency: int = DEFAULT_LLM_CONCURRENCY


@dataclass(frozen=True)
class EnvChoice:
    """The environment a run targets and the settings file it reads."""

    #: `dev`, the `<name>` of `--env <name>` / `.env.<name>`, or `custom`.
    name: str
    path: Path

    @property
    def is_default(self) -> bool:
        return self.path == ENV_FILE

    def describe(self) -> str:
        try:
            shown = self.path.relative_to(REPO_ROOT)
        except ValueError:
            shown = self.path
        return f"{self.name} ({shown})"


def env_file_for(name: str) -> Path:
    """`dev` → `pipeline/.env`; any other name → `pipeline/.env.<name>`."""
    if not _ENV_NAME.fullmatch(name):
        raise ConfigError(
            f"--env {name!r} is not an environment name (lowercase letters, digits, hyphens)."
        )
    return ENV_FILE if name == DEFAULT_ENV else PIPELINE_DIR / f".env.{name}"


def choose_env(env: str | None, environ: Mapping[str, str] | None = None) -> EnvChoice:
    """`--env <name>` if given, else `CAMSOCS_ENV_FILE`, else `pipeline/.env` (dev)."""
    environ = os.environ if environ is None else environ
    if env is not None:
        return EnvChoice(env, env_file_for(env))
    raw = environ.get(ENV_FILE_VARIABLE, "").strip()
    if not raw:
        return EnvChoice(DEFAULT_ENV, ENV_FILE)
    # Relative to the repo root, not the working directory: pixi runs the CLI
    # in pipeline/, cron in $HOME.
    path = Path(raw).expanduser()
    path = (path if path.is_absolute() else REPO_ROOT / path).resolve()
    if path == ENV_FILE.resolve():
        return EnvChoice(DEFAULT_ENV, ENV_FILE)
    name = path.name.removeprefix(".env.") if path.name.startswith(".env.") else "custom"
    return EnvChoice(name if _ENV_NAME.fullmatch(name) else "custom", path)


def load_settings(choice: EnvChoice, environ: Mapping[str, str] | None = None) -> Settings:
    """The settings of one environment, with the guards in the module docstring."""
    environ = os.environ if environ is None else environ
    if choice.is_default:
        return Settings(_env_file=choice.path)

    if not choice.path.is_file():
        raise ConfigError(
            f"{choice.path} does not exist. Create it with that deployment's "
            "CONVEX_HTTP_URL and PIPELINE_API_KEY (docs/deploy.md)."
        )
    shadowing = [name for name in TARGET_VARIABLES if environ.get(name)]
    if shadowing:
        raise ConfigError(
            f"{', '.join(shadowing)} {'is' if len(shadowing) == 1 else 'are'} set in the "
            f"shell and would override {choice.path.name}. Unset "
            f"{'it' if len(shadowing) == 1 else 'them'}: the deployment a run writes to "
            "comes from its env file only."
        )
    files = (ENV_FILE, choice.path) if ENV_FILE.is_file() else (choice.path,)
    settings = Settings(_env_file=files)

    own = dotenv_values(choice.path)
    resolved = {
        "CONVEX_URL": settings.convex_url,
        "CONVEX_HTTP_URL": settings.convex_http_url,
        "PIPELINE_API_KEY": settings.pipeline_api_key.get_secret_value(),
    }
    for name in TARGET_VARIABLES:
        stated = (own.get(name) or "").strip()
        if name != "PIPELINE_API_KEY":
            stated = stated.rstrip("/")
        if resolved[name] != stated:
            raise ConfigError(
                f"{name} would come from {ENV_FILE.name}, not {choice.path.name}. Set it in "
                f"{choice.path.name} (empty to leave it unset): the deployment a run writes "
                "to comes from its env file only."
            )

    if choice.name != DEFAULT_ENV and "state_path" not in settings.model_fields_set:
        settings = settings.model_copy(
            update={"state_path": REPO_ROOT / f".camsocs-state.{choice.name}.json"}
        )
    return settings


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """The process-wide settings singleton for the default choice (`--env`
    absent): `CAMSOCS_ENV_FILE`, else `pipeline/.env`. Tests build
    `Settings(_env_file=None, …)` directly, or call `get_settings.cache_clear()`."""
    return load_settings(choose_env(None))
