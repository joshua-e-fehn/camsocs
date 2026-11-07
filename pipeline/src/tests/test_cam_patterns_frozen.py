"""Cambridge's heuristics, frozen (multi-campus seam, lane L4, decision D8).

The correctness and privacy heuristics read the active campus's profile and
compile their patterns once per campus. For Cambridge every compiled pattern
must be string-equal (and flag-equal) to the literal the module used before
the campus seam: the literals are written out here, not imported, so a
change to a profile or a module that alters Cambridge's behaviour fails this
file. Nothing is configured: `campuses.active()` is Cambridge by default.
"""

from __future__ import annotations

import re
from datetime import date

from camsocs_pipeline import campuses
from camsocs_pipeline.campuses import CAMBRIDGE
from camsocs_pipeline.events import ics, noise
from camsocs_pipeline.extract import when
from camsocs_pipeline.resolve import names
from camsocs_pipeline.sources import links
from camsocs_pipeline.sources.websites import enrich
from camsocs_pipeline.talks.sites import filters

OTHER_UNIVERSITY = (
    r"\b(?:oxford|ou[a-z]{2,8}soc|kcl|ucl|lse|imperial|warwick|durham|edinburgh|bristol"
    r"|manchester|nottingham|st\s+andrews|king's\s+college\s+london|anglia\s+ruskin|aru)\b"
)
LOCATION = r"\bcambridge\b|\bCB\d{1,2}\b"
CRSID_LOCAL = r"^[a-z]{2,5}[0-9]{1,5}$"
HERE = (
    r"\bcambridge\b|\bCB\d{1,2}\b|\bonline\b|\bzoom\b|\bvirtual\b"
    r"|\bancient india\b|\bedinburgh building\b|\bbrooklands avenue\b"
)
PAGE_MENTION = r"\bcambridge\b|\bcantab"
UNIVERSITY_SEQUENCES = (
    ("university", "of", "cambridge"),
    ("uoc",),
    ("cambridge", "university"),
    ("cambridge", "uni"),
    ("cambridge",),
    ("cu",),
)


def _same(pattern: re.Pattern[str], literal: str, flags: int = re.IGNORECASE) -> None:
    assert pattern.pattern == literal
    assert pattern.flags & re.IGNORECASE == flags & re.IGNORECASE


def test_cambridge_is_the_campus_when_none_is_configured() -> None:
    assert campuses.active() is CAMBRIDGE


def test_the_other_university_regex() -> None:
    built = noise.other_university_pattern(CAMBRIDGE.names.self_tokens)
    _same(built, OTHER_UNIVERSITY)
    _same(noise._OTHER_UNIVERSITY, OTHER_UNIVERSITY)
    assert noise._other_university() is built


def test_the_ics_location_regex() -> None:
    built = ics.location_regex(CAMBRIDGE.names.location_pattern)
    _same(built, LOCATION)
    _same(ics._CAMBRIDGE, LOCATION)
    assert ics._campus_location() is built


def test_the_member_id_regex() -> None:
    built = links.member_local_regex(CAMBRIDGE.member_ids.pattern)
    _same(built, CRSID_LOCAL, flags=0)
    assert built.pattern == links._CRSID_LOCAL.pattern
    assert built.flags == links._CRSID_LOCAL.flags


def test_the_member_email_facts() -> None:
    rule = CAMBRIDGE.member_ids
    assert rule.domains == ("cam.ac.uk",)
    assert rule.excluded == ("lists.cam.ac.uk",)
    assert rule.forwarding_domains == {"srcf.net", "srcf.ucam.org", "cantab.ac.uk", "cantab.net"}
    assert rule.alumni_domains == {"cantab.ac.uk", "cantab.net", "oxon.org"}
    assert rule.strict_foreign_academic is False


def test_the_talks_venue_regex() -> None:
    built = filters.here_regex(CAMBRIDGE.names.location_pattern)
    _same(built, HERE)
    _same(filters._HERE, HERE)


def test_the_enrichment_page_mention_regex() -> None:
    profile = CAMBRIDGE
    pattern, town = enrich._campus_mention(
        profile.id, profile.names.location_pattern, profile.short_name.lower()
    )
    assert pattern is enrich._CAMBRIDGE
    _same(pattern, PAGE_MENTION)
    assert town == "cambridge"


def test_the_name_rules_and_university_domains() -> None:
    assert CAMBRIDGE.names.university_sequences == UNIVERSITY_SEQUENCES
    assert names._page_hosts(CAMBRIDGE) == (".cam.ac.uk", ".ox.ac.uk")
    assert CAMBRIDGE.university_domains == ("cam.ac.uk",)


def test_the_term_model() -> None:
    calendar = when.TermCalendar.default()
    assert calendar.rules is CAMBRIDGE.terms
    assert {term.week_start_weekday for term in calendar.terms} == {3}
    assert {term.term: term.code for term in calendar.terms} == {
        "michaelmas": "MT",
        "lent": "LT",
        "easter": "ET",
    }
    # Thursday 15 Oct 2026 starts the student week of Wednesday 21 Oct.
    assert when.week_anchor(date(2026, 10, 21)) == date(2026, 10, 15)
    assert (CAMBRIDGE.terms.prompt_place, CAMBRIDGE.terms.prompt_hint) == (
        "Cambridge",
        "A student week runs Thursday to Wednesday.",
    )
