"""Campuses: the pipeline's tenants (decision D8, docs/campuses/README.md).

A campus is one university with its own Convex deployment, Vercel project and
pipeline env file (``--campus ox --env ox-prod`` reads ``pipeline/.env.ox-prod``,
which states ``CAMSOCS_CAMPUS=ox``). Unset, the campus is ``cam``: production
needs no change. ``zz`` ("Testford") is synthetic and exists only in tests
(`register_for_tests`), never in `PROFILES`.

The active profile is process-global and read-only: the CLI root calls
`configure` once, before any stage or thread pool starts, and every reader
calls `active()` — worker threads do not inherit a ContextVar, so a
module global is what the stages' ThreadPoolExecutors see. Before
`configure`, `active()` is Cambridge, which is right for production.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from types import MappingProxyType

from camsocs_pipeline.campuses.cam import CAMBRIDGE
from camsocs_pipeline.campuses.profile import CampusProfile
from camsocs_pipeline.config import ConfigError

#: The campuses a production run may name. ``zz`` is never here.
PROFILES: Mapping[str, CampusProfile] = MappingProxyType({"cam": CAMBRIDGE})

#: Calendar-noise tokens naming another university's event (moved verbatim
#: from `events/noise.py` `_OTHER_UNIVERSITY`, in order; a campus drops its
#: own with `NameRules.self_tokens`). Regex alternatives, joined with ``|``.
OTHER_UNIVERSITY_TOKENS: tuple[str, ...] = (
    "oxford",
    "ou[a-z]{2,8}soc",
    "kcl",
    "ucl",
    "lse",
    "imperial",
    "warwick",
    "durham",
    "edinburgh",
    "bristol",
    "manchester",
    "nottingham",
    r"st\s+andrews",
    r"king's\s+college\s+london",
    r"anglia\s+ruskin",
    "aru",
)

_test_profiles: dict[str, CampusProfile] = {}
_active: CampusProfile | None = None


def known_ids() -> tuple[str, ...]:
    """Every campus id `get_profile` answers: production's, then test ones."""
    return (*PROFILES, *_test_profiles)


def get_profile(campus_id: str) -> CampusProfile:
    """The campus called `campus_id`; an unknown id is a `ConfigError`."""
    profile = PROFILES.get(campus_id) or _test_profiles.get(campus_id)
    if profile is None:
        raise ConfigError(
            f"Unknown campus {campus_id!r}. Known: {', '.join(known_ids())} (CAMSOCS_CAMPUS)."
        )
    return profile


def configure(profile: CampusProfile) -> None:
    """Make `profile` the process's campus. The CLI root calls this once,
    before any stage runs; it must be a registered profile."""
    global _active
    if get_profile(profile.id) is not profile:
        raise ConfigError(f"Campus {profile.id!r} is not the registered profile of that id.")
    _active = profile


def active() -> CampusProfile:
    """The configured campus, else Cambridge."""
    return _active if _active is not None else CAMBRIDGE


def _require_pytest(action: str) -> None:
    if not os.environ.get("PYTEST_CURRENT_TEST"):
        raise RuntimeError(f"campuses.{action} is for tests only")


def register_for_tests(profile: CampusProfile) -> None:
    """Make a synthetic campus (``zz``) known, inside a pytest test only."""
    _require_pytest("register_for_tests")
    if profile.id in PROFILES:
        raise ValueError(f"Campus {profile.id!r} is a production campus")
    _test_profiles[profile.id] = profile


def reset_for_tests() -> None:
    """Forget test campuses and the configured profile (back to Cambridge)."""
    global _active
    _require_pytest("reset_for_tests")
    _test_profiles.clear()
    _active = None


__all__ = [
    "CAMBRIDGE",
    "OTHER_UNIVERSITY_TOKENS",
    "PROFILES",
    "CampusProfile",
    "active",
    "configure",
    "get_profile",
    "known_ids",
    "register_for_tests",
    "reset_for_tests",
]
