"""Campus profiles (decision D8, spec §2-§3): Cambridge's profile is today's
constants, the active profile is process-global and defaults to Cambridge,
and the synthetic campus ``zz`` gets the engine plus its own stages, its own
paths and its own settings — without Cambridge changing at all."""

from __future__ import annotations

import importlib.util
import threading
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from pathlib import Path

import pytest

from camsocs_pipeline import campuses, monitor
from camsocs_pipeline.campuses import cam
from camsocs_pipeline.campuses.profile import CampusProfile, default_paths
from camsocs_pipeline.config import (
    ABOUT_URL,
    DEFAULT_REPORTS_DIR,
    DEFAULT_STAGING_DIR,
    DEFAULT_STATE_PATH,
    DOCUMENTED_USER_AGENT,
    PIPELINE_DIR,
    REPO_ROOT,
    ConfigError,
    Settings,
)
from camsocs_pipeline.events import ics, noise
from camsocs_pipeline.extract import when
from camsocs_pipeline.pipeline.context import PHASES, StageContext
from camsocs_pipeline.pipeline.load import ConvexLoader
from camsocs_pipeline.pipeline.report import RunReport
from camsocs_pipeline.pipeline.state import SyncState
from camsocs_pipeline.pipeline.sync import run_sync
from camsocs_pipeline.resolve import crosswalk, names
from camsocs_pipeline.seeds import term_dates
from camsocs_pipeline.sources import links
from camsocs_pipeline.stages import ENGINE, GROUPS, STAGES, groups, registry
from camsocs_pipeline.stages import resolve as resolve_stage
from camsocs_pipeline.stages import term_dates as term_dates_stage
from camsocs_pipeline.staging.store import StagingStore
from tests.campus_zz import FACTS, RAN, ZZ, ZZ_EVENTS, ZZ_SOCIETIES, registered

CAMBRIDGE = campuses.CAMBRIDGE
CAM_FACTS = FACTS["campuses"]["cam"]


@pytest.fixture
def zz_campus() -> Iterator[CampusProfile]:
    with registered() as profile:
        yield profile


@pytest.fixture(autouse=True)
def _cambridge_after() -> Iterator[None]:
    """Every test here leaves the process configured for Cambridge."""
    yield
    campuses.reset_for_tests()


# --- Cambridge is today's constants ------------------------------------------------------------


def test_cam_is_the_only_production_campus() -> None:
    assert dict(campuses.PROFILES) == {"cam": CAMBRIDGE}
    assert campuses.get_profile("cam") is CAMBRIDGE
    assert campuses.active() is CAMBRIDGE


def test_cam_paths_are_todays_constants() -> None:
    assert CAMBRIDGE.paths.staging == DEFAULT_STAGING_DIR
    assert CAMBRIDGE.paths.reports == DEFAULT_REPORTS_DIR
    assert CAMBRIDGE.paths.decisions is crosswalk.DECISIONS_PATH
    assert CAMBRIDGE.paths.decisions == PIPELINE_DIR / "resolve-decisions.json"


def test_cam_branding_is_todays_constants() -> None:
    branding = CAMBRIDGE.branding
    assert branding.about_url == ABOUT_URL
    assert branding.user_agent == DOCUMENTED_USER_AGENT
    assert branding.site_url == CAM_FACTS["site"]
    assert monitor.SITE_CHECKS is cam.SITE_CHECKS is branding.monitor_urls
    assert monitor.SITE_CHECKS == (
        ("site_home", "https://camsocs.uk/"),
        ("site_societies", "https://camsocs.uk/societies"),
    )


def test_cam_requests_inbox_is_the_alert_scripts() -> None:
    path = REPO_ROOT / "ops" / "vps" / "camsocs-alert.py"
    spec = importlib.util.spec_from_file_location("camsocs_alert_for_campus", path)
    assert spec is not None and spec.loader is not None
    alert = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(alert)
    assert CAMBRIDGE.branding.requests_inbox == alert.REQUESTS_INBOX


def test_cam_terms_are_todays_constants() -> None:
    terms = CAMBRIDGE.terms
    assert terms.dates is term_dates.TERM_DATES
    assert terms.source_url == term_dates.SOURCE_URL
    assert dict(terms.codes) == when._TERM_PREFIX
    assert terms.names == ("michaelmas", "lent", "easter")
    assert terms.week_start_weekday == when._THURSDAY == 3
    assert (terms.min_week, terms.max_week) == (when.MIN_TERM_WEEK, when.MAX_TERM_WEEK)


def test_cam_terms_match_the_shared_facts() -> None:
    facts = CAM_FACTS["terms"]
    terms = CAMBRIDGE.terms
    assert list(terms.names) == facts["order"]
    assert dict(terms.codes) == facts["codes"]
    assert terms.week_start_weekday == facts["weekStartPy"]
    assert (terms.min_week, terms.max_week) == (facts["minWeek"], facts["maxWeek"])


def test_cam_prompt_words_rebuild_todays_calendar_line() -> None:
    """The calendar line of an extraction prompt is memo-key material: the
    profile's words must rebuild it byte for byte (L4 renders it from them)."""
    calendar = when.TermCalendar.default()
    terms = CAMBRIDGE.terms
    seen = 0
    day = date(2026, 9, 1)
    while day < date(2027, 7, 1):
        term = calendar.term_for(day)
        if term is not None:
            week = term.week_of(day)
            where = f" It is in Week {week} of that term." if week is not None else ""
            line = f"{terms.prompt_place} {term.describe()}. {terms.prompt_hint}{where}"
            assert calendar.context(day).endswith(" " + line)
            seen += 1
        day += timedelta(days=3)
    assert seen > 20


def test_cam_member_ids_are_todays_constants() -> None:
    rule = CAMBRIDGE.member_ids
    facts = CAM_FACTS["memberEmail"]
    assert rule.pattern == links.CRSID_PATTERN
    assert f"^{rule.pattern}$" == facts["idPattern"]
    assert rule.forwarding_domains is links._CRSID_MAIL_DOMAINS
    assert rule.alumni_domains is links._ALUMNI_DOMAINS
    assert list(rule.domains) == facts["domains"]
    assert list(rule.excluded) == facts["excluded"]
    assert rule.strict_foreign_academic is facts["strictForeignAcademic"] is False
    assert list(CAMBRIDGE.university_domains) == CAM_FACTS["universityDomains"]


def test_cam_name_rules_are_todays_constants() -> None:
    rules = CAMBRIDGE.names
    assert rules.university_sequences is names._UNIVERSITY_SEQUENCES
    assert rules.location_pattern == ics._CAMBRIDGE.pattern == r"\bcambridge\b|\bCB\d{1,2}\b"
    assert rules.self_tokens == frozenset()


def test_other_university_tokens_rebuild_the_noise_regex() -> None:
    """Moved verbatim: joined, the tokens are `noise._OTHER_UNIVERSITY`."""
    tokens = campuses.OTHER_UNIVERSITY_TOKENS
    assert len(tokens) == len(set(tokens))
    rebuilt = r"\b(?:" + "|".join(t for t in tokens if t not in CAMBRIDGE.names.self_tokens)
    assert rebuilt + r")\b" == noise._OTHER_UNIVERSITY.pattern


def test_cam_stages_and_groups_are_the_registrys() -> None:
    assert CAMBRIDGE.stages == tuple(s for s in STAGES if s.campus == "cam")
    assert CAMBRIDGE.groups is GROUPS
    assert registry(CAMBRIDGE) is STAGES
    assert groups(CAMBRIDGE) is GROUPS


# --- the registry of profiles ------------------------------------------------------------------


def test_an_unknown_campus_is_a_config_error() -> None:
    with pytest.raises(ConfigError, match="Unknown campus 'ox'"):
        campuses.get_profile("ox")
    assert "zz" not in campuses.known_ids()


def test_test_campuses_need_pytest(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PYTEST_CURRENT_TEST")
    with pytest.raises(RuntimeError, match="tests only"):
        campuses.register_for_tests(ZZ)
    with pytest.raises(RuntimeError, match="tests only"):
        campuses.reset_for_tests()


def test_a_test_campus_cannot_replace_cambridge() -> None:
    with pytest.raises(ValueError, match="production campus"):
        campuses.register_for_tests(CAMBRIDGE)


def test_only_a_registered_profile_can_be_configured(zz_campus) -> None:
    campuses.configure(zz_campus)
    assert campuses.active() is ZZ
    campuses.reset_for_tests()
    assert campuses.active() is CAMBRIDGE
    with pytest.raises(ConfigError, match="Unknown campus 'zz'"):
        campuses.configure(ZZ)


def test_worker_threads_see_the_configured_campus(zz_campus) -> None:
    """The stages' ThreadPoolExecutors read the profile: a module global,
    not a ContextVar a worker thread would not inherit."""
    campuses.configure(zz_campus)
    with ThreadPoolExecutor(max_workers=4) as pool:
        seen = set(pool.map(lambda _: (campuses.active().id, threading.get_ident()), range(16)))
    assert {campus for campus, _thread in seen} == {"zz"}


# --- zz: the engine plus its own stages, its own paths -----------------------------------------


def test_zz_registry_is_the_engine_plus_its_stubs_in_phase_order(zz_campus) -> None:
    stages = registry(zz_campus)
    assert {s.name for s in stages} == {s.name for s in ENGINE} | {"zz_societies", "zz_events"}
    assert [s for s in stages if s.campus is not None] == [ZZ_SOCIETIES, ZZ_EVENTS]
    phases = [PHASES.index(s.phase) for s in stages]
    assert phases == sorted(phases)
    # Engine first within a phase: declared position after the phase.
    events = [s.name for s in stages if s.phase == "events"]
    assert events == ["calendar_feeds", "website_events", "zz_events"]
    assert stages[0].name == "term_dates" and stages[1] is ZZ_SOCIETIES
    assert not any(s.campus == "cam" for s in stages)
    assert groups(zz_campus) is zz_campus.groups


def test_a_campus_stage_may_not_shadow_an_engine_stage(zz_campus) -> None:
    from dataclasses import replace

    from camsocs_pipeline.pipeline.context import Stage

    clash = replace(zz_campus, stages=(Stage("load", phase="load", campus="zz"),))
    with pytest.raises(ValueError, match="engine stages"):
        registry(clash)


def test_a_profile_carries_only_its_own_stages() -> None:
    from dataclasses import replace

    with pytest.raises(ValueError, match="another campus"):
        replace(ZZ, stages=(*ZZ.stages, STAGES[1]))


def test_zz_paths_are_its_own() -> None:
    root = REPO_ROOT / "var" / "campus" / "zz"
    assert ZZ.paths == default_paths("zz")
    assert ZZ.paths.staging == root / "staging"
    assert ZZ.paths.reports == root / "reports"
    assert ZZ.paths.decisions == PIPELINE_DIR / "resolve-decisions.zz.json"
    # Crosswalk, quarantine and stored files follow staging into var/campus/zz/.
    assert crosswalk.crosswalk_path(ZZ.paths.staging) == root / "state" / "crosswalk.json"
    assert crosswalk.quarantine_path(ZZ.paths.staging) == root / "reports" / "quarantine.json"


def test_zz_groups_cover_what_their_stages_read(zz_campus) -> None:
    stages = registry(zz_campus)
    for group in zz_campus.groups.values():
        assert group.derived_needs(stages) <= set(group.needs), group.name


def test_zz_settings_default_to_its_paths_and_user_agent(zz_campus) -> None:
    settings = Settings(_env_file=None, campus="zz")
    assert settings.profile() is ZZ
    assert settings.staging_dir == ZZ.paths.staging
    assert settings.reports_dir == ZZ.paths.reports
    assert settings.user_agent == ZZ.branding.user_agent
    assert settings.require_user_agent() == ZZ.branding.user_agent
    assert settings.state_path == ZZ.paths.state
    assert {"staging_dir", "reports_dir", "state_path", "user_agent"}.isdisjoint(
        settings.model_fields_set
    )
    # Explicit values still win.
    explicit = Settings(_env_file=None, campus="zz", staging_dir=Path("/tmp/x"))
    assert explicit.staging_dir == Path("/tmp/x")


def test_cam_settings_are_unchanged() -> None:
    settings = Settings(_env_file=None)
    assert settings.campus == "cam"
    assert settings.profile() is CAMBRIDGE
    assert settings.staging_dir == DEFAULT_STAGING_DIR
    assert settings.reports_dir == DEFAULT_REPORTS_DIR
    assert settings.user_agent == DOCUMENTED_USER_AGENT
    assert settings.state_path == DEFAULT_STATE_PATH == CAMBRIDGE.paths.state
    assert "campus" not in settings.model_fields_set


def test_the_email_domain_kinds_are_the_profiles() -> None:
    assert CAMBRIDGE.email_domain_types is links.CAMBRIDGE_EMAIL_DOMAIN_TYPES
    assert [kind for kind, _ in CAMBRIDGE.email_domain_types] == [
        "legacy_cusu",
        "cambridgesu",
        "srcf",
    ]
    assert ZZ.email_domain_types == ()


# --- the runner and the stages read the run's profile ------------------------------------------


def test_a_zz_run_uses_its_registry_and_its_term_dates(zz_campus, make_settings) -> None:
    campuses.configure(zz_campus)
    posted: list = []

    class Loader(ConvexLoader):
        def upsert_term_dates(self, terms):  # type: ignore[override]
            posted.append(terms)
            return super().upsert_term_dates(terms)

    loader = Loader("", "", dry_run=True)
    report = run_sync(
        settings=make_settings(campus="zz"),
        stages=["term_dates", "zz_societies", "zz_events"],
        dry_run=True,
        loader=loader,
    )
    assert report.ok, report.summary()
    assert [s.name for s in report.stages] == ["term_dates", "zz_societies", "zz_events"]
    assert posted == [ZZ.terms.dates]
    assert RAN == [("zz_societies", "zz"), ("zz_events", "zz")]


def test_a_zz_run_cannot_name_a_cambridge_stage(zz_campus, make_settings) -> None:
    campuses.configure(zz_campus)
    with pytest.raises(ValueError, match="Unknown stage"):
        run_sync(settings=make_settings(campus="zz"), stages=["su_directory"], dry_run=True)


def test_settings_of_another_campus_are_refused(zz_campus, make_settings) -> None:
    with pytest.raises(ConfigError, match="configured for cam"):
        run_sync(settings=make_settings(campus="zz"), stages=["term_dates"], dry_run=True)


def _context(settings, profile=None) -> StageContext:
    run = RunReport(run_key="20261107T120000Z-abcdef", command="sync", dry_run=True)
    extra = {} if profile is None else {"profile": profile}
    return StageContext(
        settings=settings,
        report=run.stage("x"),
        run=run,
        loader=ConvexLoader("", "", dry_run=True),
        state=SyncState(),
        staging=StagingStore(settings.staging_dir),
        dry_run=True,
        limit=None,
        **extra,
    )


def test_a_stage_context_defaults_to_the_active_profile(zz_campus, make_settings) -> None:
    assert _context(make_settings()).profile is CAMBRIDGE
    campuses.configure(zz_campus)
    assert _context(make_settings()).profile is ZZ


def test_term_dates_posts_the_profiles_dates(make_settings, monkeypatch) -> None:
    posted: list = []
    ctx = _context(make_settings())
    monkeypatch.setattr(
        ctx.loader, "upsert_term_dates", lambda terms: posted.append(terms) or _batch()
    )
    term_dates_stage.run(ctx)
    assert posted == [term_dates.TERM_DATES] and posted[0] is term_dates.TERM_DATES
    assert ctx.report.notes == [f"{len(term_dates.TERM_DATES)} terms (2026-27, 2027-28)"]


def _batch():
    from camsocs_pipeline.pipeline.load import BatchResult

    return BatchResult()


class _DecisionsRead(Exception):
    pass


@pytest.mark.parametrize("profile", [CAMBRIDGE, ZZ], ids=["cam", "zz"])
def test_resolve_reads_the_profiles_decisions(profile, make_settings, monkeypatch) -> None:
    settings = make_settings()
    # One (empty) staged file, so the stage gets as far as the decisions.
    folder = settings.staging_dir / "manual"
    folder.mkdir(parents=True)
    (folder / "20261107T110000Z-abcdef.jsonl").write_text("")

    def read(path):
        raise _DecisionsRead(path)

    monkeypatch.setattr(resolve_stage.Decisions, "load", staticmethod(read))
    with pytest.raises(_DecisionsRead) as raised:
        resolve_stage.run(_context(settings, profile))
    assert raised.value.args[0] == profile.paths.decisions
