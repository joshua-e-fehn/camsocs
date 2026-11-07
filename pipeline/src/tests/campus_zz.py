"""The synthetic campus ``zz`` ("Testford University"), for tests only.

Built from the zz facts of the shared fixture webapp/lib/campus/campuses.fixtures.json
(decision D8), plus two stub stages of its own: a harvest stage and an events
stage, each with ``campus="zz"``. Nothing here names a real source, and the
profile is never in `campuses.PROFILES`: a test makes it known with the
`zz_campus` fixture (`campuses.register_for_tests`), which forgets it again,
and the configured campus with it, after the test.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from contextlib import contextmanager
from types import MappingProxyType

from camsocs_pipeline import campuses
from camsocs_pipeline.campuses.profile import (
    Branding,
    CampusProfile,
    MemberIdRule,
    NameRules,
    TermCalendar,
    default_paths,
)
from camsocs_pipeline.config import REPO_ROOT
from camsocs_pipeline.models.wire import TermDate
from camsocs_pipeline.pipeline.context import Stage, StageContext, StageGroup

FACTS = json.loads(
    (REPO_ROOT / "webapp" / "lib" / "campus" / "campuses.fixtures.json").read_text(encoding="utf-8")
)
ZZ_FACTS: dict = FACTS["campuses"]["zz"]

#: Stages the stubs ran, with the campus each one saw (`ctx.profile.id`).
RAN: list[tuple[str, str]] = []


def run(ctx: StageContext) -> None:
    """The stub stages' body (`Stage.module` points here for one of them)."""
    RAN.append((ctx.report.name, ctx.profile.id))
    ctx.report.notes.append(f"zz stub ran for {ctx.profile.id}")


ZZ_SOCIETIES = Stage(
    "zz_societies",
    module="tests.campus_zz",
    description="synthetic Testford society list",
    phase="harvest",
    pillar="societies",
    campus="zz",
    writes=("manual",),
)
ZZ_EVENTS = Stage(
    "zz_events",
    fn=run,
    description="synthetic Testford events",
    phase="events",
    pillar="events",
    campus="zz",
    reads=("@org_lookup", "manual"),
    writes=("manual.events",),
)

_TERMS = ZZ_FACTS["terms"]
_MEMBER = ZZ_FACTS["memberEmail"]
_SITE = ZZ_FACTS["site"]

#: One synthetic term, in the only term name zz shares with the global
#: vocabulary (`TERMS` stays a closed union until a second campus is built).
ZZ_TERM_DATES: tuple[TermDate, ...] = (
    TermDate(
        academic_year="2026-27",
        term="michaelmas",
        full_term_start="2026-10-11",
        full_term_end="2026-12-05",
        source_url=f"{_SITE}/terms",
    ),
)

ZZ = CampusProfile(
    id="zz",
    name=ZZ_FACTS["name"],
    short_name="Testford",
    timezone="Europe/London",
    branding=Branding(
        product="ZZsocs",
        site_url=_SITE,
        about_url=f"{_SITE}/about",
        user_agent=f"camsocs-bot/0.1 (+{_SITE}/about)",
        monitor_urls=(("site_home", f"{_SITE}/"),),
        requests_inbox=f"{_SITE}/dashboard/requests",
    ),
    terms=TermCalendar(
        names=tuple(_TERMS["order"]),
        codes=MappingProxyType(dict(_TERMS["codes"])),
        week_start_weekday=_TERMS["weekStartPy"],
        min_week=_TERMS["minWeek"],
        max_week=_TERMS["maxWeek"],
        dates=ZZ_TERM_DATES,
        source_url=f"{_SITE}/terms",
        prompt_place="Testford",
        prompt_hint="A student week runs Sunday to Saturday.",
    ),
    member_ids=MemberIdRule(
        pattern=_MEMBER["idPattern"],
        domains=tuple(_MEMBER["domains"]),
        excluded=tuple(_MEMBER["excluded"]),
        forwarding_domains=frozenset(_MEMBER["forwarding"]),
        alumni_domains=frozenset(_MEMBER["alumni"]),
        strict_foreign_academic=_MEMBER["strictForeignAcademic"],
    ),
    names=NameRules(
        university_sequences=(("university", "of", "testford"), ("testford",)),
        location_pattern=r"\btestford\b",
        self_tokens=frozenset(),
    ),
    university_domains=tuple(ZZ_FACTS["universityDomains"]),
    has_colleges=False,
    stages=(ZZ_SOCIETIES, ZZ_EVENTS),
    groups=MappingProxyType(
        {
            "events": StageGroup(
                "events",
                stages=("term_dates", "zz_events", "load", "report"),
                needs=("_resolved", "manual"),
                description="daily: the zz events stub, then load",
            ),
            "full": StageGroup("full", derive=True, description="weekly: every stage"),
        }
    ),
    paths=default_paths("zz"),
)


@contextmanager
def registered() -> Iterator[CampusProfile]:
    """``zz`` is a known campus inside the block (not the configured one)."""
    RAN.clear()
    campuses.register_for_tests(ZZ)
    try:
        yield ZZ
    finally:
        campuses.reset_for_tests()
        RAN.clear()
