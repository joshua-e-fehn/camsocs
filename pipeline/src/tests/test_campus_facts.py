"""Campus facts (decision D8, docs/campuses/README.md): the cross-language
fixture webapp/lib/campus/campuses.fixtures.json. Its Cambridge facts must
equal today's Python constants, so the campus profiles built from it later
(pipeline `campuses/`, webapp `lib/campus/`) can never drift from what the
pipeline does now. The zz campus ("Testford") is synthetic and is only
checked for shape here; its behaviour is tested once the heuristics read it."""

from __future__ import annotations

import json
import re

import pytest

from camsocs_pipeline.config import ABOUT_URL, REPO_ROOT
from camsocs_pipeline.extract import when
from camsocs_pipeline.models.vocab import EMAIL_TYPES, EVENT_SOURCES, TERMS
from camsocs_pipeline.sources import links

FACTS = json.loads(
    (REPO_ROOT / "webapp" / "lib" / "campus" / "campuses.fixtures.json").read_text(encoding="utf-8")
)
CAMPUSES: dict[str, dict] = FACTS["campuses"]
CAM = CAMPUSES["cam"]


def test_schema_and_campus_ids() -> None:
    assert FACTS["schema"] == "camsocs.campus-facts/1"
    assert set(CAMPUSES) == {"cam", "zz"}
    for campus in CAMPUSES:
        # The PostHog `campus` property's shape (spec §6).
        assert re.fullmatch(r"[a-z]{2,8}", campus)


# --- Cambridge equals today's constants ---------------------------------------------------------


def test_cam_member_id_pattern_is_the_crsid_pattern() -> None:
    assert CAM["memberEmail"]["idPattern"] == f"^{links.CRSID_PATTERN}$"


def test_cam_forwarding_domains_are_the_crsid_mail_domains() -> None:
    forwarding = CAM["memberEmail"]["forwarding"]
    assert len(forwarding) == len(set(forwarding))
    assert frozenset(forwarding) == links._CRSID_MAIL_DOMAINS


def test_cam_alumni_domains() -> None:
    alumni = CAM["memberEmail"]["alumni"]
    assert len(alumni) == len(set(alumni))
    assert frozenset(alumni) == links._ALUMNI_DOMAINS


def test_cam_member_domains_follow_is_crsid_address() -> None:
    member = CAM["memberEmail"]
    assert member["domains"] == ["cam.ac.uk"]
    assert member["includeSubdomains"] is True
    assert member["excluded"] == ["lists.cam.ac.uk"]
    assert member["strictForeignAcademic"] is False
    # The rule the facts describe is the rule `is_crsid_address` applies.
    assert links.is_crsid_address("ab123", "cam.ac.uk")
    assert links.is_crsid_address("ab123", "hermes.cam.ac.uk")
    assert not links.is_crsid_address("ab123", "lists.cam.ac.uk")


def test_cam_term_codes_and_order() -> None:
    terms = CAM["terms"]
    assert terms["codes"] == when._TERM_PREFIX
    assert tuple(terms["order"]) == TERMS
    assert list(terms["codes"]) == terms["order"]


def test_cam_week_start_is_thursday() -> None:
    terms = CAM["terms"]
    assert terms["weekStartPy"] == when._THURSDAY
    assert terms["minWeek"] == when.MIN_TERM_WEEK
    assert terms["maxWeek"] == when.MAX_TERM_WEEK


def test_cam_site_and_official_sources() -> None:
    assert f"{CAM['site']}/about" == ABOUT_URL
    assert CAM["universityDomains"] == ["cam.ac.uk"]
    assert set(CAM["officialEventSources"]) <= set(EVENT_SOURCES)


# --- every campus -------------------------------------------------------------------------------


@pytest.mark.parametrize("campus", sorted(CAMPUSES))
def test_term_facts_are_consistent(campus: str) -> None:
    terms = CAMPUSES[campus]["terms"]
    # Python's weekday() starts on Monday = 0, JS getUTCDay() on Sunday = 0.
    assert 0 <= terms["weekStartPy"] <= 6
    assert terms["weekStartJs"] == (terms["weekStartPy"] + 1) % 7
    assert list(terms["codes"]) == terms["order"]
    assert len(set(terms["codes"].values())) == len(terms["order"])
    assert 0 <= terms["minWeek"] < terms["maxWeek"]
    assert terms["labelFormat"] == "{code}{yy} Wk {week}"


@pytest.mark.parametrize("campus", sorted(CAMPUSES))
def test_member_email_facts_are_well_formed(campus: str) -> None:
    member = CAMPUSES[campus]["memberEmail"]
    if member["idPattern"] is not None:
        re.compile(member["idPattern"])
    for excluded in member["excluded"]:
        assert any(excluded.endswith(f".{domain}") for domain in member["domains"])
    assert set(member["domains"]) <= set(CAMPUSES[campus]["universityDomains"])


def test_zz_is_synthetic_and_shares_nothing_with_cam() -> None:
    zz = CAMPUSES["zz"]
    assert zz["synthetic"] is True
    assert "synthetic" not in CAM
    assert zz["site"].endswith(".localhost")
    assert not set(zz["universityDomains"]) & set(CAM["universityDomains"])
    assert zz["memberEmail"]["idPattern"] is None
    assert zz["memberEmail"]["strictForeignAcademic"] is True


# --- email cases --------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "case", FACTS["emailCases"], ids=lambda case: f"{case['campus']}:{case['email']}"
)
def test_email_case_types_exist(case: dict) -> None:
    assert case["campus"] in CAMPUSES
    assert case["type"] in EMAIL_TYPES


CAM_CASES = [case for case in FACTS["emailCases"] if case["campus"] == "cam"]


def test_enough_cam_cases() -> None:
    assert len(CAM_CASES) >= 6
    assert {case["email"] for case in CAM_CASES}.isdisjoint(
        {case["email"] for case in FACTS["emailCases"] if case["campus"] != "cam"}
    )


@pytest.mark.parametrize("case", CAM_CASES, ids=lambda case: case["email"])
def test_cam_cases_are_todays_behaviour(case: dict) -> None:
    # `email_type` mirrors the server's `classifyEmail` rule for rule
    # (test_links.py checks both against email-types.fixtures.json).
    assert links.email_type(case["email"]) == case["type"]
