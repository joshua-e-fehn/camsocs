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

**Which campus** (decision D8, `camsocs_pipeline.campuses`). `CAMSOCS_CAMPUS`
(or the CLI's `--campus`) names the tenant a run belongs to; unset, it is
``cam``, so production needs no change. Each campus has its own deployment and
env file (``--campus ox --env ox-prod`` reads ``pipeline/.env.ox-prod``, which
must state ``CAMSOCS_CAMPUS=ox``): `--campus` disagreeing with the campus its
env file states is an error, never an override. The staging and reports
directories, the default env's run state and the User-Agent default to the
campus profile's (another campus's under ``var/campus/<id>/``, so a run of it
never overwrites Cambridge's state); Cambridge's are the constants below. A
blank `CAMSOCS_CAMPUS` (``CAMSOCS_CAMPUS=`` in a file or the shell) counts as
unset.

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

import logging
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import TYPE_CHECKING, Any

# python-dotenv is pydantic-settings' own dotenv reader (a required dependency).
from dotenv import dotenv_values
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    SecretStr,
    ValidationError,
    field_validator,
    model_validator,
)
from pydantic_settings import BaseSettings, SettingsConfigDict

if TYPE_CHECKING:
    from camsocs_pipeline.campuses.profile import CampusProfile

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

#: The campus a run belongs to (decision D8), and its value when unset.
CAMPUS_VARIABLE = "CAMSOCS_CAMPUS"
DEFAULT_CAMPUS = "cam"
_CAMPUS_ID = re.compile(r"[a-z]{2,8}")

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

#: PostHog EU Cloud ingestion (run telemetry, `telemetry.py`). The project
#: lives in the EU region; the SDK's own default is the US host.
DEFAULT_POSTHOG_HOST = "https://eu.i.posthog.com"
#: The `environment` property on every event when POSTHOG_ENV is unset. The
#: VPS sets `production` in pipeline/.env.prod (docs/ops-vps.md).
DEFAULT_POSTHOG_ENV = "development"
#: PostHog EU Cloud's app host, where the private API lives (the query API
#: the `monitor` command calls, ENG-10) — not the ingestion host above.
DEFAULT_POSTHOG_APP_HOST = "https://eu.posthog.com"

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
DOCUMENTED_USER_AGENT = "camsocs-bot/0.1 (+https://camsocs.uk/about)"
#: The page the documented User-Agent links (the About page the site shows).
ABOUT_URL = "https://camsocs.uk/about"

logger = logging.getLogger(__name__)
#: User-Agents already warned about this process (`require_user_agent`).
_warned_user_agents: set[str] = set()


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

    #: The campus (`camsocs_pipeline.campuses`); its profile supplies the
    #: defaults of `staging_dir`, `reports_dir`, `state_path` and `user_agent`.
    campus: str = Field(default=DEFAULT_CAMPUS, validation_alias=CAMPUS_VARIABLE)
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

    user_agent: str = Field(default=DOCUMENTED_USER_AGENT, validation_alias="CAMSOCS_USER_AGENT")
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

    #: Optional run telemetry (`telemetry.py`): the PostHog project token.
    #: Unset → no client is built and nothing is sent. The `phc_` token is
    #: ingest-only and public by design, but SecretStr keeps it out of logs.
    posthog_key: SecretStr = Field(default=SecretStr(""), validation_alias="POSTHOG_KEY")
    posthog_host: str = Field(default=DEFAULT_POSTHOG_HOST, validation_alias="POSTHOG_HOST")
    posthog_env: str = Field(default=DEFAULT_POSTHOG_ENV, validation_alias="POSTHOG_ENV")
    #: Optional production checks (`monitor.py`, ENG-10): a personal API key
    #: scoped to the camsocs project with `query:read`, and the project's
    #: numeric id. Both unset → `monitor` says so and exits 0. Unlike the
    #: `phc_` token this key reads the project's data: it is a real secret.
    posthog_personal_api_key: SecretStr = Field(
        default=SecretStr(""), validation_alias="POSTHOG_PERSONAL_API_KEY"
    )
    posthog_project_id: str = Field(default="", validation_alias="POSTHOG_PROJECT_ID")
    posthog_app_host: str = Field(
        default=DEFAULT_POSTHOG_APP_HOST, validation_alias="POSTHOG_APP_HOST"
    )

    #: Optional IndexNow pings after a load (`indexnow.py`, SEO audit G15):
    #: the public site's origin, ``https://camsocs.uk`` in pipeline/.env.prod.
    #: Unset (dev, CI, tests) → nothing is sent: only the production
    #: deployment's data is what the site shows.
    indexnow_site_url: str = Field(default="", validation_alias="INDEXNOW_SITE_URL")

    @model_validator(mode="before")
    @classmethod
    def _blank_campus_is_unset(cls, data: Any) -> Any:
        """A blank `CAMSOCS_CAMPUS` is no campus stated, as `_check_campus`
        reads it: dropped, so the field keeps its default and stays out of
        the explicitly set fields."""
        if isinstance(data, dict):
            blank = [
                key
                for key in ("campus", CAMPUS_VARIABLE)
                if isinstance(data.get(key), str) and not data[key].strip()
            ]
            if blank:
                return {key: value for key, value in data.items() if key not in blank}
        return data

    @field_validator("campus")
    @classmethod
    def _known_campus(cls, value: str) -> str:
        from camsocs_pipeline import campuses

        value = value.strip()
        if not _CAMPUS_ID.fullmatch(value) or value not in campuses.known_ids():
            raise ValueError(f"unknown campus {value!r}; known: {', '.join(campuses.known_ids())}")
        return value

    @model_validator(mode="after")
    def _campus_defaults(self) -> Settings:
        """Paths and User-Agent not set explicitly come from the campus
        profile. Cambridge's equal the field defaults, so nothing changes."""
        profile = self.profile()
        defaults = {
            "staging_dir": profile.paths.staging,
            "reports_dir": profile.paths.reports,
            "state_path": profile.paths.state,
            "user_agent": profile.branding.user_agent,
        }
        for name, value in defaults.items():
            if name not in self.model_fields_set and getattr(self, name) != value:
                # Not through __setattr__: the field stays "not set explicitly".
                self.__dict__[name] = value
        return self

    def profile(self) -> CampusProfile:
        """The campus profile `campus` names."""
        from camsocs_pipeline import campuses

        return campuses.get_profile(self.campus)

    @field_validator(
        "convex_url", "convex_http_url", "llm_base_url", "posthog_host", "posthog_app_host"
    )
    @classmethod
    def _strip_trailing_slash(cls, value: str) -> str:
        # Every caller builds URLs as f"{base}/path".
        return value.strip().rstrip("/")

    @field_validator(
        "llm_model_bulk",
        "llm_model_strong",
        "user_agent",
        "meta_ig_user_id",
        "meta_graph_version",
        "posthog_env",
        "posthog_project_id",
        "indexnow_site_url",
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

    # -- PostHog ---------------------------------------------------------------

    @property
    def posthog_configured(self) -> bool:
        """Whether run telemetry is on (a project token is set)."""
        return bool(self.posthog_key.get_secret_value().strip())

    @property
    def posthog_query_configured(self) -> bool:
        """Whether `monitor` can query PostHog (a personal key and a project id)."""
        return bool(self.posthog_personal_api_key.get_secret_value().strip()) and bool(
            self.posthog_project_id
        )

    # -- crawling ------------------------------------------------------------

    def require_user_agent(self) -> str:
        """The crawler's User-Agent, or a readable error.

        Unset, it is `DOCUMENTED_USER_AGENT` (the campus profile's); set to
        anything that does not link `ABOUT_URL` (the profile's About page), it
        is used with a warning (once per process).

        Honest by rule: it names this crawler and a page about it, so a
        webmaster can recognise it and ask us to slow down. A browser-like
        string is refused — disguising the crawler would be a way around a
        site's robots.txt — and so is any email address: the User-Agent goes to
        every site we fetch, and it contains no personal email
        (source-research "Global rules"); the contact is the About page.
        """
        ua = self.user_agent
        branding = self.profile().branding
        documented, about = branding.user_agent, branding.about_url
        if not ua:
            raise ConfigError(
                f'CAMSOCS_USER_AGENT is not set. Use the documented crawler token, "{documented}".'
            )
        if "mozilla/" in ua.lower():
            raise ConfigError(
                "CAMSOCS_USER_AGENT looks like a browser. The crawler must identify itself."
            )
        if "@" in ua or "mailto:" in ua.lower():
            raise ConfigError(
                "CAMSOCS_USER_AGENT contains an email address. It must not: link the About "
                f'page instead, "{documented}".'
            )
        if about not in ua and ua not in _warned_user_agents:
            # Still honest (the old host redirects), but not the page the site shows.
            _warned_user_agents.add(ua)
            logger.warning(
                "CAMSOCS_USER_AGENT does not link %s, the About page the site names as the "
                'crawler\'s contact; the documented value is "%s".',
                about,
                documented,
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


def _build(env_file: Path | tuple[Path, ...], campus: str | None) -> Settings:
    """`Settings` from `env_file`, `--campus` winning; an unknown campus is a
    `ConfigError` (the CLI prints it), every other invalid value a `ValidationError`."""
    overrides = {} if campus is None else {"campus": campus}
    try:
        return Settings(_env_file=env_file, **overrides)
    except ValidationError as error:
        if any(
            entry["loc"] and entry["loc"][0] in ("campus", CAMPUS_VARIABLE)
            for entry in error.errors()
        ):
            from camsocs_pipeline import campuses

            raise ConfigError(
                f"Unknown campus: set {CAMPUS_VARIABLE} / --campus to one of "
                f"{', '.join(campuses.known_ids())}."
            ) from None
        raise


def _stated_campus(path: Path) -> str | None:
    """The `CAMSOCS_CAMPUS` an env file states, if it states one."""
    if not path.is_file():
        return None
    return (dotenv_values(path).get(CAMPUS_VARIABLE) or "").strip() or None


def _check_campus(
    choice: EnvChoice, settings: Settings, campus: str | None, environ: Mapping[str, str]
) -> None:
    """A run's campus agrees with its env file (decision D8): `--campus` and
    an exported `CAMSOCS_CAMPUS` may not contradict the file, and a named env
    file of another campus than Cambridge must state its campus."""
    stated = _stated_campus(choice.path)
    shell = (environ.get(CAMPUS_VARIABLE) or "").strip() or None
    if campus is not None and stated is not None and campus != stated:
        raise ConfigError(
            f"--campus {campus} disagrees with {CAMPUS_VARIABLE}={stated} in "
            f"{choice.path.name}: a campus's env file names its deployment."
        )
    if campus is not None and shell is not None and campus != shell:
        raise ConfigError(
            f"--campus {campus} disagrees with {CAMPUS_VARIABLE}={shell} in the shell."
        )
    if stated is not None and settings.campus != stated:
        raise ConfigError(
            f"{CAMPUS_VARIABLE} is set in the shell and would override {choice.path.name}'s "
            f"{CAMPUS_VARIABLE}={stated}. Unset it: a run's campus comes from its env file."
        )
    if not choice.is_default and settings.campus != DEFAULT_CAMPUS and stated is None:
        raise ConfigError(
            f"{choice.path.name} must state {CAMPUS_VARIABLE}={settings.campus}: each "
            "campus has its own deployment and env file (docs/campuses/README.md)."
        )


def load_settings(
    choice: EnvChoice, environ: Mapping[str, str] | None = None, *, campus: str | None = None
) -> Settings:
    """The settings of one environment, with the guards in the module
    docstring. `campus` is the CLI's `--campus`: it wins over the
    environment, and may not contradict the campus the env file states."""
    environ = os.environ if environ is None else environ
    if choice.is_default:
        settings = _build(choice.path, campus)
        _check_campus(choice, settings, campus, environ)
        return settings

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
    settings = _build(files, campus)
    _check_campus(choice, settings, campus, environ)

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
