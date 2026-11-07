"""What each registry stage is (decision D8, spec §2): its phase, pillar,
campus, staging reads and writes, Convex sinks, network and model use, and
the docs § that governs it.

None of it changes how a stage runs (tests/test_registry_snapshot.py freezes
that); it is what the pipeline graph, the staging guard and the run log read.
The table below is the reviewed annotation: a deliberate change edits it in
the same commit.
"""

from __future__ import annotations

import re

import pytest

from camsocs_pipeline.campuses import CAMBRIDGE
from camsocs_pipeline.config import REPO_ROOT
from camsocs_pipeline.models.vocab import SOURCE_TYPES
from camsocs_pipeline.pipeline.context import PHASES, PILLARS, SELECTORS, Stage, StageGroup
from camsocs_pipeline.stages import ENGINE, GROUPS, STAGES, registry
from camsocs_pipeline.staging.store import RESOLVED, TALKS, events_directory

ORG, EVENTS, ALL = "@org_lookup", "@event_index", "@all_observations"

#: What `post_observations` calls, in order: the suppression list (read),
#: then sources, stored files, claims and the side tables.
OBSERVATIONS = (
    "suppressions", "sources", "files", "claims", "orgInternal", "relationships",
    "eventOrganisers", "events/superseded", "brokerInferences",
)  # fmt: skip

#: name → (phase, pillar, campus, writes, reads, sinks, network, llm, docs)
ANNOTATIONS: dict[str, tuple] = {
    "term_dates": ("seed", "shared", None, (), (), ("termDates",), False, False, ("§19",)),
    "su_directory": (
        "harvest", "societies", "cam", ("su_directory", "su_profile"), (), (), True, False, ("§1",)
    ),
    "proctors_register": (
        "harvest", "societies", "cam", ("proctors_register",), (), (), True, False, ("§2",)
    ),
    "sport_clubs": (
        "harvest", "societies", "cam", ("sport_az", "sport_club_page"), (), (), True, False,
        ("§3",),
    ),
    "sport_guide_pdf": (
        "harvest", "societies", "cam", ("sport_guide_pdf",), ("sport_club_page",), (), True,
        False, ("§4",),
    ),
    "camdram_societies": (
        "harvest", "societies", "cam", ("camdram",), (), (), True, False, ("§5",)
    ),
    "cucbc_clubs": ("harvest", "societies", "cam", ("cucbc",), (), (), True, False, ("§7",)),
    "colleges": (
        "harvest", "societies", "cam", ("college_list", "society_website"), (), (), True, False,
        ("§8",),
    ),
    "resolve": (
        "resolve", "societies", None, (RESOLVED,), (ALL,), ("crosswalk",), False, False, ()
    ),
    "enrich": (
        "enrich", "societies", None, ("society_website", "linktree"), (RESOLVED,), (), True, True,
        ("§13", "§14"),
    ),
    "classify": ("classify", "societies", None, (ALL,), (ALL,), (), True, True, ()),
    "camdram_events": (
        "events", "events", "cam", ("camdram.events",), (ORG,), ("crosswalk",), True, False, ("§5",)
    ),
    "talks_cam": (
        "events", "events", "cam", ("talks_list.events",), (ORG,), ("crosswalk",), True, False, ("§6",)
    ),
    "cucbc_events": (
        "events", "events", "cam", ("cucbc.events",), (ORG,), ("crosswalk",), True, False, ("§7",)
    ),
    "playwaze": (
        "events", "events", "cam", ("playwaze.events",), (ORG,), ("crosswalk",), True, False,
        ("§9",),
    ),
    "uni_events": (
        "events", "events", "cam", ("uni_events_api.events",), (ORG,), ("crosswalk",), True, False, ("§10",)
    ),
    "calendar_feeds": (
        "events", "events", None, ("ics_feed.events", "luma.events"), (ORG,), ("crosswalk",), True, False,
        ("§11",),
    ),
    "su_whatson": (
        "events", "events", "cam", ("su_whatson.events",), ("su_profile", ORG), ("crosswalk",), True, False,
        ("§12",),
    ),
    "website_events": (
        "events", "events", None, ("society_website.events",), ("society_website",), (), True,
        True, ("§14",),
    ),
    "inbox": (
        "inbox", "events", None, ("mailing_list_email",), (ORG, EVENTS),
        ("crosswalk", "inbound/pending", "inbound/file", *OBSERVATIONS, "inbound/mark"), False, True,
        ("§16", "§20"),
    ),
    "instagram": (
        "inbox", "events", None, ("instagram_api",), (ORG, EVENTS), ("crosswalk", "files"), True, True,
        ("§17",),
    ),
    "termcards": (
        "inbox", "events", None, ("termcard",), (ORG, EVENTS), ("crosswalk",), True, True,
        ("§21",),
    ),
    "load": ("load", "shared", None, (), (ALL,), OBSERVATIONS, False, False, ()),
    "talks": (
        "talks", "talks", "cam", (TALKS,), (),
        ("talks/departments", "talks/batch", "talks/sweep", "talks/runs"), True, False,
        ("talks-redesign-spec",),
    ),
    "report": (
        "report", "shared", None, (), (), ("coverage", "coverage/events"), False, False, ()
    ),
}  # fmt: skip


def _docs(stage: Stage) -> tuple[str, ...]:
    return tuple(d.removeprefix("source-research") for d in stage.docs)


def test_every_stage_is_annotated_as_reviewed() -> None:
    assert list(ANNOTATIONS) == [stage.name for stage in STAGES]
    for stage in STAGES:
        actual = (
            stage.phase,
            stage.pillar,
            stage.campus,
            stage.writes,
            stage.reads,
            stage.sinks,
            stage.network,
            stage.llm,
            _docs(stage),
        )
        assert actual == ANNOTATIONS[stage.name], stage.name


def test_every_stage_that_reads_the_org_lookup_declares_the_crosswalk() -> None:
    """`OrgLookup.for_stage` reads `/api/pipeline/crosswalk` on a real run, so
    every stage that reads `@org_lookup` lists that route in `sinks=`."""
    for stage in STAGES:
        if ORG in stage.reads:
            assert "crosswalk" in stage.sinks, stage.name


def test_the_pillars_are_the_three_plus_shared() -> None:
    assert PILLARS == ("societies", "events", "talks", "shared")
    assert {stage.pillar for stage in STAGES} == set(PILLARS)
    # talks.cam lists feed the events pillar (G1); the talks pillar is `talks`.
    by_name = {stage.name: stage for stage in STAGES}
    assert by_name["talks_cam"].pillar == "events"
    assert by_name["talks"].pillar == "talks"


def test_phases_are_monotonic_in_the_registry() -> None:
    assert PHASES == (
        "seed",
        "harvest",
        "resolve",
        "enrich",
        "classify",
        "events",
        "inbox",
        "load",
        "talks",
        "report",
    )
    order = [PHASES.index(stage.phase) for stage in STAGES]
    assert order == sorted(order)
    assert {stage.phase for stage in STAGES} == set(PHASES)


def _staging_directories() -> set[str]:
    return {*SOURCE_TYPES, *(events_directory(t) for t in SOURCE_TYPES), RESOLVED, TALKS}


def test_every_write_is_a_staging_directory_or_the_wildcard() -> None:
    allowed = _staging_directories() | {ALL}
    for stage in STAGES:
        assert set(stage.writes) <= allowed, stage.name


def test_every_read_is_a_staging_directory_or_a_selector() -> None:
    allowed = _staging_directories() | set(SELECTORS)
    for stage in STAGES:
        assert set(stage.reads) <= allowed, stage.name


def test_every_group_needs_what_its_stages_read_and_do_not_write() -> None:
    for name, group in GROUPS.items():
        assert group.derived_needs(STAGES) <= set(group.needs), name
    # The events group reads the SU profiles and the sites enrichment read.
    assert GROUPS["events"].derived_needs(STAGES) == {"su_profile", "society_website"}
    assert GROUPS["full"].derived_needs(STAGES) == frozenset()


def test_derived_needs_leave_out_selectors_and_what_the_group_writes() -> None:
    stages = [
        Stage("a", phase="harvest", writes=("camdram",), reads=(ORG,)),
        Stage("b", phase="events", reads=("camdram", "su_profile", ALL)),
    ]
    assert StageGroup("g").derived_needs(stages) == {"su_profile"}
    assert StageGroup("g", stages=("b",)).derived_needs(stages) == {"camdram", "su_profile"}


def test_every_cited_section_exists() -> None:
    text = (REPO_ROOT / "docs" / "source-research.md").read_text(encoding="utf-8")
    sections = set(re.findall(r"^## §(\d+)\b", text, flags=re.MULTILINE))
    for stage in STAGES:
        for doc in stage.docs:
            if doc.startswith("source-research§"):
                assert doc.removeprefix("source-research§") in sections, (stage.name, doc)
            else:
                assert (REPO_ROOT / "docs" / f"{doc}.md").is_file(), (stage.name, doc)


def test_engine_and_campus_stages_partition_the_registry() -> None:
    assert tuple(stage for stage in STAGES if stage.campus is None) == ENGINE
    assert {stage.campus for stage in STAGES} == {None, "cam"}
    assert len(ENGINE) + len(CAMBRIDGE.stages) == len(STAGES)
    assert registry(CAMBRIDGE) is STAGES


def test_a_stage_refuses_an_unknown_phase_or_pillar() -> None:
    with pytest.raises(ValueError, match="phase"):
        Stage("x", phase="fetch")  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="pillar"):
        Stage("x", pillar="university")  # type: ignore[arg-type]


def test_a_stage_module_overrides_where_its_run_lives() -> None:
    stage = Stage("anything", module="camsocs_pipeline.stages.report")
    from camsocs_pipeline.stages import report

    assert stage.resolve() is report.run
