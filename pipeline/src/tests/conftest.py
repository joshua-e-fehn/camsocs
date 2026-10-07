"""Shared fixtures.

Two safety properties hold for every test:

- **No network.** `respx` is active for the whole suite with
  `assert_all_mocked=True`, so any httpx request (including the OpenAI SDK's,
  which uses httpx) that a test did not mock raises instead of leaving the
  machine. Tests add routes to the `net` fixture.
- **No real configuration.** Every variable the pipeline reads is removed from
  the environment, and `settings()` builds `Settings` with `_env_file=None`, so
  `pipeline/.env` (real keys) is never read by a test.
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
    "CAMSOCS_STATE_PATH",
    "CAMSOCS_MIN_HOST_INTERVAL",
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
            "state_path": tmp_path / "state.json",
            "user_agent": TEST_UA,
        }
        values.update(overrides)
        return Settings(_env_file=None, **values)

    return build
