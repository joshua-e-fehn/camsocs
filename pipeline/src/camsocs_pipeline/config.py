"""Runtime configuration, read from `pipeline/.env` and the environment.

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

from functools import lru_cache
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

#: `<repo>/pipeline/src/camsocs_pipeline/config.py` → `<repo>`.
REPO_ROOT = Path(__file__).resolve().parents[3]
PIPELINE_DIR = REPO_ROOT / "pipeline"

#: Read wherever the command runs from (pixi runs it in `pipeline/`, cron in $HOME).
ENV_FILE = PIPELINE_DIR / ".env"

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
    min_host_interval: float = Field(
        default=DEFAULT_MIN_HOST_INTERVAL, ge=0.0, validation_alias="CAMSOCS_MIN_HOST_INTERVAL"
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

        Honest by rule: it names this crawler and a contact, so a webmaster can
        recognise it and ask us to slow down. A browser-like string is refused —
        disguising the crawler would be a way around a site's robots.txt.
        """
        ua = self.user_agent
        if not ua:
            raise ConfigError(
                "CAMSOCS_USER_AGENT is not set. Use an honest token plus a contact, e.g. "
                '"camsocs-bot/0.1 (+https://example.org/camsocs; you@example.org)".'
            )
        if "mozilla/" in ua.lower():
            raise ConfigError(
                "CAMSOCS_USER_AGENT looks like a browser. The crawler must identify itself."
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


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """The process-wide settings singleton. Tests build `Settings(_env_file=None, …)`
    directly, or call `get_settings.cache_clear()`."""
    return Settings()
