"""Shared fixtures.

Two safety properties hold for every test:

- **No network.** `respx` is active for the whole suite with
  `assert_all_mocked=True`, so any httpx request (including the OpenAI SDK's,
  which uses httpx) that a test did not mock raises instead of leaving the
  machine. Tests add routes to the `net` fixture.
- **No DNS.** The polite client resolves every host before it fetches
  (only public addresses, `sources/base.py`); here every name resolves to one
  public documentation-free address, unless a test passes its own resolver.
- **No `requests` either.** The PostHog SDK (run telemetry) posts with
  `requests`, which respx cannot see; its transport is refused outright, and
  telemetry tests inject a fake client instead.
- **No real configuration.** Every variable the pipeline reads is removed from
  the environment, and `settings()` builds `Settings` with `_env_file=None`, so
  `pipeline/.env` (real keys) is never read by a test.
- **No telemetry carried over.** A test that starts a run makes its telemetry
  the process's active one (LLM generations go there); it is cleared after
  every test.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
import respx

from camsocs_pipeline.config import Settings, get_settings

ENV_VARS = (
    "CONVEX_URL",
    "CONVEX_HTTP_URL",
    "PIPELINE_API_KEY",
    "LLM_BASE_URL",
    "LLM_API_KEY",
    "LLM_MODEL_BULK",
    "LLM_MODEL_STRONG",
    "LLM_CONCURRENCY",
    "CAMSOCS_USER_AGENT",
    "CAMSOCS_CACHE_DIR",
    "CAMSOCS_STAGING_DIR",
    "CAMSOCS_STATE_PATH",
    "CAMSOCS_MIN_HOST_INTERVAL",
    "CAMDRAM_API_KEY",
    "CAMSOCS_REPORTS_DIR",
    "CAMSOCS_ENV_FILE",
    "META_IG_USER_ID",
    "META_ACCESS_TOKEN",
    "META_GRAPH_VERSION",
    "POSTHOG_KEY",
    "POSTHOG_HOST",
    "POSTHOG_ENV",
    "POSTHOG_PERSONAL_API_KEY",
    "POSTHOG_PROJECT_ID",
    "POSTHOG_APP_HOST",
    "INDEXNOW_SITE_URL",
)

TEST_UA = "camsocs-test/0.1 (+https://example.org/camsocs)"


@pytest.fixture(autouse=True)
def _isolated_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    for name in ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture(autouse=True)
def _no_httpx2(monkeypatch: pytest.MonkeyPatch) -> None:
    """Defence in depth: the OpenAI SDK defaults to the `httpx2` fork, which
    respx does not intercept. The pipeline always hands it an `httpx.Client`;
    if anything ever bypasses that, it fails here instead of reaching the network."""
    try:
        import httpx2
    except ImportError:
        return

    def refuse(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError("Network access through httpx2 is disabled in tests")

    monkeypatch.setattr(httpx2.HTTPTransport, "handle_request", refuse)


@pytest.fixture(autouse=True)
def _no_requests(monkeypatch: pytest.MonkeyPatch) -> None:
    """The PostHog SDK sends through `requests`, which respx does not
    intercept. Telemetry tests use a fake client; if a real one is ever built
    and sends, it fails here instead of reaching the network."""
    import requests.adapters

    def refuse(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError("Network access through requests is disabled in tests")

    monkeypatch.setattr(requests.adapters.HTTPAdapter, "send", refuse)


@pytest.fixture(autouse=True)
def _no_active_telemetry(monkeypatch: pytest.MonkeyPatch) -> None:
    from camsocs_pipeline import telemetry

    monkeypatch.setattr(telemetry, "_active", None)


class ModelReached(BaseException):
    """Raised by `llm_tripwire`. A `BaseException`, so a stage's broad
    `except Exception` cannot swallow it."""


@pytest.fixture
def llm_tripwire(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Every way a stage could reach a model, wired to fail the test: asking
    the settings for the LLM configuration, building an `LLMClient` or an
    OpenAI client, asking either for a completion, or reporting a generation.
    Each raises `ModelReached` and is recorded in the returned list, which the
    test asserts is empty.

    `Settings.require_llm` is wired because every call site builds its client
    as ``LLMClient(settings.require_llm())``: test settings have no LLM
    configured, so without it the `ConfigError` raised there (an ordinary
    `Exception`, which a stage or a rules-only fallback catches) would hide
    the attempt before `LLMClient.__init__` is reached."""
    import openai
    import openai.resources.chat.completions as completions

    from camsocs_pipeline.config import Settings
    from camsocs_pipeline.extract.llm import LLMClient
    from camsocs_pipeline.telemetry import HarvestTelemetry

    reached: list[str] = []

    def wire(owner: object, name: str) -> None:
        label = f"{getattr(owner, '__name__', owner)}.{name}"

        def trip(*_args: Any, **_kwargs: Any) -> Any:
            reached.append(label)
            raise ModelReached(label)

        monkeypatch.setattr(owner, name, trip)

    wire(Settings, "require_llm")
    for name in ("__init__", "complete_json", "_complete"):
        wire(LLMClient, name)
    wire(openai.OpenAI, "__init__")
    wire(completions.Completions, "create")
    wire(HarvestTelemetry, "generation")
    return reached


#: What every host name resolves to in tests: a public address.
PUBLIC_TEST_ADDRESS = "93.184.215.14"


@pytest.fixture(autouse=True)
def _no_dns(monkeypatch: pytest.MonkeyPatch) -> None:
    from camsocs_pipeline.sources import base

    monkeypatch.setattr(base, "RESOLVE", lambda _host, _port: [PUBLIC_TEST_ADDRESS])


@pytest.fixture(autouse=True)
def net() -> Iterator[respx.MockRouter]:
    """The suite-wide network mock. Unmocked requests raise."""
    with respx.mock(assert_all_mocked=True, assert_all_called=False) as router:
        yield router


@pytest.fixture
def make_settings(tmp_path: Path):
    """Build isolated `Settings`; keyword overrides use field names."""

    def build(**overrides: Any) -> Settings:
        values: dict[str, Any] = {
            "cache_dir": tmp_path / "cache",
            "staging_dir": tmp_path / "staging",
            "state_path": tmp_path / "state.json",
            "reports_dir": tmp_path / "reports",
            "user_agent": TEST_UA,
        }
        # Settings refuse a host interval under 1 s; offline tests that must
        # not wait set one after validation.
        interval = overrides.pop("min_host_interval", None)
        values.update(overrides)
        settings = Settings(_env_file=None, **values)
        if interval is not None:
            settings = settings.model_copy(update={"min_host_interval": interval})
        return settings

    return build
