"""What a campus is to the pipeline (decision D8, docs/campuses/README.md).

A campus is a tenant: one university with its own Convex deployment, Vercel
project and pipeline env file. Its profile holds the facts the engine stages
and heuristics read instead of Cambridge literals. Only the fields needed now
are here; the rest (prompts, colleges, policy hosts…) are deferred (spec §9).

Profiles are frozen and process-global (`campuses.configure`), so the stages'
thread pools read them safely. The Cambridge profile (`campuses/cam.py`) is
built from today's constants, imported from their modules, never copied.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from camsocs_pipeline.config import PIPELINE_DIR, REPO_ROOT
from camsocs_pipeline.models.wire import TermDate
from camsocs_pipeline.pipeline.context import Stage, StageGroup


@dataclass(frozen=True)
class TermCalendar:
    """The campus's terms and teaching weeks (`extract/when.py`)."""

    #: Term names in academic-year order, ``("michaelmas", "lent", "easter")``.
    names: tuple[str, ...]
    #: Term → label code, ``{"michaelmas": "MT", …}`` (`when._TERM_PREFIX`).
    codes: Mapping[str, str]
    #: Python ``weekday()`` a teaching week starts on: 3 = Thursday (`when._THURSDAY`).
    week_start_weekday: int
    min_week: int
    max_week: int
    #: The verified term dates (`seeds.term_dates.TERM_DATES` for cam).
    dates: tuple[TermDate, ...]
    source_url: str
    #: How the calendar line of an extraction prompt names the place and the
    #: week rule (when.py: "Cambridge <term>. A student week runs Thursday to
    #: Wednesday."). Memo-key material: byte-identical for cam.
    prompt_place: str
    prompt_hint: str


@dataclass(frozen=True)
class MemberIdRule:
    """Which addresses name one member of the campus (`sources/links.py`)."""

    #: A member id local part (the CRSid pattern); `None`: any name-shaped
    #: local part on a member domain is personal.
    pattern: str | None
    #: Member domains, including their subdomains (``("cam.ac.uk",)``).
    domains: tuple[str, ...]
    #: Subdomains that are not members' (``("lists.cam.ac.uk",)``).
    excluded: tuple[str, ...]
    #: Domains outside `domains` that issue addresses by member id.
    forwarding_domains: frozenset[str]
    alumni_domains: frozenset[str]
    #: Every unfamiliar ``*.ac.uk`` address is personal. False for cam
    #: (byte-identical); True for every new campus.
    strict_foreign_academic: bool


@dataclass(frozen=True)
class NameRules:
    """How organisation names and places mention the campus."""

    #: Word sequences naming the university, removed before names are compared
    #: (`resolve/names._UNIVERSITY_SEQUENCES`).
    university_sequences: tuple[tuple[str, ...], ...]
    #: A location in the campus's town (`events/ics._CAMBRIDGE`).
    location_pattern: str
    #: Tokens of `campuses.OTHER_UNIVERSITY_TOKENS` that are this campus
    #: itself (cam: none; an Oxford campus would drop ``oxford``).
    self_tokens: frozenset[str]


@dataclass(frozen=True)
class Branding:
    """How the campus's site and crawler present themselves."""

    product: str
    site_url: str
    #: The page the crawler's User-Agent links (`config.ABOUT_URL` for cam).
    about_url: str
    user_agent: str
    #: The monitor's site checks: a name and a page that must answer 200.
    monitor_urls: tuple[tuple[str, str], ...]
    #: Where the alert points an operator for new listing requests.
    requests_inbox: str


@dataclass(frozen=True)
class Paths:
    """Where the campus's local files live. Crosswalk, quarantine and stored
    files sit next to `staging` (`resolve/crosswalk.var_dir`), so they follow it."""

    staging: Path
    reports: Path
    #: Operator decisions for the resolver, committed.
    decisions: Path


def default_paths(campus_id: str) -> Paths:
    """A non-cam campus's local files: ``var/campus/<id>/…`` and
    ``pipeline/resolve-decisions.<id>.json``. The URL-keyed, sha256-checked
    web cache (`var/cache`) stays shared."""
    root = REPO_ROOT / "var" / "campus" / campus_id
    return Paths(
        staging=root / "staging",
        reports=root / "reports",
        decisions=PIPELINE_DIR / f"resolve-decisions.{campus_id}.json",
    )


@dataclass(frozen=True)
class CampusProfile:
    """One campus (decision D8)."""

    #: ``"cam"``; the PostHog `campus` property and the env's `CAMSOCS_CAMPUS`.
    id: str
    name: str
    short_name: str
    timezone: str
    branding: Branding
    terms: TermCalendar
    member_ids: MemberIdRule
    names: NameRules
    university_domains: tuple[str, ...]
    has_colleges: bool
    #: The campus's own stages (each with ``campus == id``); the engine stages
    #: every campus runs are `stages.ENGINE`.
    stages: tuple[Stage, ...]
    groups: Mapping[str, StageGroup]
    paths: Paths

    def __post_init__(self) -> None:
        foreign = [stage.name for stage in self.stages if stage.campus != self.id]
        if foreign:
            raise ValueError(f"Campus {self.id}: stages of another campus: {', '.join(foreign)}")


__all__ = [
    "Branding",
    "CampusProfile",
    "MemberIdRule",
    "NameRules",
    "Paths",
    "TermCalendar",
    "default_paths",
]
