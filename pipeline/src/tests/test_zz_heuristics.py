"""The correctness and privacy heuristics under the synthetic campus ``zz``
("Testford University", decision D8, lane L4).

Each heuristic reads `campuses.active()`. Under ``zz`` it must follow
Testford's facts (webapp/lib/campus/campuses.fixtures.json), not Cambridge's;
under Cambridge (nothing configured) it must not change. Every address,
venue and title here is synthetic.
"""

from __future__ import annotations

import dataclasses
import json
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import date

import pytest

from camsocs_pipeline import campuses
from camsocs_pipeline.campuses import CAMBRIDGE, CampusProfile
from camsocs_pipeline.config import REPO_ROOT
from camsocs_pipeline.events.ics import _location_is_cambridge
from camsocs_pipeline.events.noise import EventText, judge, own_names
from camsocs_pipeline.extract.when import TermCalendar, week_anchor
from camsocs_pipeline.resolve.names import email_site, name_parts, site_identity
from camsocs_pipeline.sources.links import (
    WITHHELD,
    email_type,
    is_personal_crsid,
    name_tokens,
    withhold_personal_emails,
)
from camsocs_pipeline.sources.websites.enrich import _names_campus
from camsocs_pipeline.talks.sites.filters import is_elsewhere
from tests import campus_zz

FACTS = json.loads(
    (REPO_ROOT / "webapp" / "lib" / "campus" / "campuses.fixtures.json").read_text(encoding="utf-8")
)


@contextmanager
def configured(profile: CampusProfile) -> Iterator[CampusProfile]:
    """`profile` registered (for a test id) and made the process's campus."""
    with campus_zz.registered():
        if profile.id != "cam":
            campuses.register_for_tests(profile)
        campuses.configure(profile)
        yield profile


@pytest.fixture
def zz() -> Iterator[CampusProfile]:
    with configured(campus_zz.ZZ) as profile:
        yield profile


def event(title: str) -> EventText:
    names = ("Quokka Society",)
    return EventText(
        title=title,
        organisers=names,
        own_tokens=frozenset(name_tokens(*names)),
        own_names=own_names(names),
        source_type="ics_feed",
        event_source="google_calendar",
    )


def another_university(title: str) -> bool:
    return "another university" in judge(event(title)).borderline


# --- calendar noise (events/noise.py) ---------------------------------------------------------


def test_an_oxford_named_event_under_cambridge_is_another_universitys() -> None:
    assert another_university("Oxford Quokka Social")
    assert not another_university("Testford Quokka Social")


def test_a_testford_event_under_zz_is_not_another_universitys(zz) -> None:
    assert not another_university("Testford Quokka Social")
    assert another_university("Oxford Quokka Social")


def test_a_campus_drops_its_own_token_from_the_other_universities() -> None:
    """The hard gate before any non-cam load: a campus that is itself one of
    the listed universities names it in `self_tokens`."""
    names = dataclasses.replace(campus_zz.ZZ.names, self_tokens=frozenset({"oxford"}))
    with configured(dataclasses.replace(campus_zz.ZZ, names=names)):
        assert not another_university("Oxford Quokka Social")
        assert another_university("KCL Quokka Social")


# --- iCalendar locations (events/ics.py) ------------------------------------------------------


def test_the_ics_location_rule_is_the_campus_town(zz) -> None:
    assert _location_is_cambridge("Testford Town Hall")
    assert _location_is_cambridge("Online")
    assert _location_is_cambridge("")
    assert not _location_is_cambridge("Guildhall, Cambridge CB2 3QJ")


def test_the_ics_location_rule_under_cambridge() -> None:
    assert _location_is_cambridge("Guildhall, Cambridge CB2 3QJ")
    assert not _location_is_cambridge("Testford Town Hall")


# --- term weeks (extract/when.py) -------------------------------------------------------------


def test_zz_week_labels_start_on_sunday(zz) -> None:
    calendar = TermCalendar.default()
    assert calendar.rules is zz.terms
    (term,) = calendar.terms
    assert zz.terms.week_start_weekday == 6
    # Full Term from Sunday 11 Oct 2026: Week 1 starts that Sunday.
    assert term.week1_start == date(2026, 10, 11)
    assert term.week_start(0) == date(2026, 10, 4)
    assert term.week1_start.weekday() == 6
    assert term.date_of(2, "saturday") == date(2026, 10, 24)
    assert term.week_of(date(2026, 10, 17)) == 1
    assert term.week_of(date(2026, 10, 18)) == 2
    assert term.label(2) == "MT26 Wk 2"
    assert week_anchor(date(2026, 10, 14)) == date(2026, 10, 11)


def test_zz_calendar_line_names_testford(zz) -> None:
    context = TermCalendar.default().context(date(2026, 10, 14))
    assert " Testford Michaelmas Full Term 2026 runs Sunday 11 October 2026" in context
    assert context.endswith("A student week runs Sunday to Saturday. It is in Week 1 of that term.")
    assert "Cambridge" not in context


def test_cambridge_weeks_still_start_on_thursday() -> None:
    assert week_anchor(date(2026, 10, 14)) == date(2026, 10, 8)


# --- member addresses (sources/links.py) ------------------------------------------------------


@pytest.mark.parametrize("case", FACTS["emailCases"], ids=lambda case: case["email"])
def test_every_shared_email_case_matches_the_links_classification(case: dict) -> None:
    profile = CAMBRIDGE if case["campus"] == "cam" else campus_zz.ZZ
    with configured(profile):
        assert email_type(case["email"]) == case["type"]


def test_zz_member_rules(zz) -> None:
    # No member-id pattern: a name-shaped local part on a member domain is a person's.
    assert is_personal_crsid("jane.doe@testford.ac.uk")
    assert not is_personal_crsid("chess@testford.ac.uk")
    # Strict about other universities: any unfamiliar *.ac.uk address is a person's.
    assert is_personal_crsid("abc12@cam.ac.uk")
    assert is_personal_crsid("chess@elsewhere.ac.uk")
    # No forwarding domains of its own: Cambridge's are ordinary domains here.
    assert not is_personal_crsid("ab123@srcf.net")
    assert email_type("jane.doe@testford-alumni.org") == "personal_crsid"
    assert email_type("jane.doe@cantab.net") == "role_own_domain"
    assert email_type("chess@lists.testford.ac.uk") == "lists_cam"
    assert email_type("chess@chem.testford.ac.uk") == "college_domain"
    assert email_type("chess@lists.cam.ac.uk") == "personal_crsid"


@pytest.mark.parametrize(
    ("email", "kind"),
    [
        # Testford has no domain kinds of its own (`emailDomainTypes: []`):
        # Cambridge's SU, CUSU and SRCF hosts are ordinary domains there.
        ("ab123@srcf.net", "role_own_domain"),
        ("chess@soc.srcf.ucam.org", "role_own_domain"),
        ("chess@cusu.testford.ac.uk", "college_domain"),
        ("info@cambridgesu.co.uk", "role_own_domain"),
        ("x@cusu.org", "role_own_domain"),
    ],
)
def test_zz_has_no_cambridge_domain_kinds(zz, email: str, kind: str) -> None:
    assert email_type(email) == kind


def test_cambridge_domain_kinds_are_untouched() -> None:
    assert email_type("chess@srcf.net") == "srcf"
    assert email_type("chess@cusu.cam.ac.uk") == "legacy_cusu"
    assert email_type("x@cusu.org") == "legacy_cusu"
    assert email_type("info@cambridgesu.co.uk") == "cambridgesu"


def test_free_text_withholds_by_the_campus_rule(zz) -> None:
    text = "Write to jane.doe@testford.ac.uk or chess@testford.ac.uk"
    assert withhold_personal_emails(text) == f"Write to {WITHHELD} or chess@testford.ac.uk"


def test_cambridge_member_rules_are_untouched() -> None:
    assert not is_personal_crsid("jane.doe@testford.ac.uk")
    assert email_type("chess@elsewhere.ac.uk") == "role_own_domain"
    assert email_type("chess@lists.cam.ac.uk") == "lists_cam"


def test_worker_threads_see_the_configured_campus(zz) -> None:
    """The profile is process-global: a stage's thread pool reads it too."""
    with ThreadPoolExecutor(max_workers=4) as pool:
        verdicts = list(pool.map(is_personal_crsid, ["jane.doe@testford.ac.uk"] * 8))
    assert verdicts == [True] * 8


# --- names and sites (resolve/names.py) -------------------------------------------------------


def test_zz_names_drop_testfords_qualifiers(zz) -> None:
    assert name_parts("Testford Chess Club").signature() == "chess"
    assert name_parts("University of Testford Chess Society").signature() == "chess"
    assert name_parts("Cambridge University Chess Club").signature() == "cambridge chess university"


def test_cambridge_names_are_untouched() -> None:
    assert name_parts("Cambridge University Chess Club").signature() == "chess"
    assert name_parts("Testford University Chess Club").signature() == "chess testford university"


def test_zz_sites_under_its_university_domain(zz) -> None:
    assert site_identity("https://www.chem.testford.ac.uk/chess/") == "chem.testford.ac.uk/chess"
    # The known universities' college sites stay page-level on every campus.
    assert site_identity("https://jcr.cam.ac.uk/chess") == "jcr.cam.ac.uk/chess"
    assert email_site("chem.testford.ac.uk") is None
    assert email_site("chess.example.org") == "chess.example.org"


def test_cambridge_sites_are_untouched() -> None:
    assert site_identity("https://www.chem.testford.ac.uk/chess/") == "chem.testford.ac.uk"
    assert site_identity("https://jcr.cam.ac.uk/chess") == "jcr.cam.ac.uk/chess"
    assert email_site("jcr.cam.ac.uk") is None
    assert email_site("chem.testford.ac.uk") == "chem.testford.ac.uk"


# --- talks venues and society sites -----------------------------------------------------------


def test_zz_talk_venues(zz) -> None:
    assert not is_elsewhere("Testford Town Hall, London Road")
    assert is_elsewhere("Guildhall, London")
    assert not is_elsewhere("Online via Zoom, London")


def test_cambridge_talk_venues_are_untouched() -> None:
    assert is_elsewhere("Testford Town Hall, London Road")
    assert not is_elsewhere("Guildhall, Cambridge, London Road")


def test_zz_society_sites_name_testford(zz) -> None:
    assert _names_campus("The Testford Quokka Society", "quokkas.example.org")
    assert _names_campus("Quokkas", "testfordquokkas.example.org")
    assert not _names_campus("The Cambridge Quokka Society (Cantab)", "quokkas.example.org")


def test_cambridge_society_sites_are_untouched() -> None:
    assert _names_campus("Quokkas, Cantab", "quokkas.example.org")
    assert _names_campus("Quokkas", "cambridgequokkas.example.org")
    assert not _names_campus("The Testford Quokka Society", "quokkas.example.org")
