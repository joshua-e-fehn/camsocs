"""The stage registry and its groups, frozen (multi-campus seam, guardrail L0a).

Cambridge's stage, group and module names, their order, what each group runs
and reads, and each stage's `requires` and `fetches` are part of what must stay
byte-identical while the campus seam lands: the VPS timers, the alert script,
the run log in Convex and PostHog all key on them. A deliberate change edits
the literal below in the same commit, so it shows in review.
"""

from __future__ import annotations

from datetime import timedelta

from camsocs_pipeline.pipeline.sync import STAGE_ORDER, resolve_group, resolve_stages
from camsocs_pipeline.stages import GROUPS, STAGES, stage_names

#: (name, requires, fetches), in registry order.
STAGE_SNAPSHOT: tuple[tuple[str, tuple[str, ...], bool], ...] = (
    ("term_dates", (), False),
    ("su_directory", (), False),
    ("proctors_register", (), False),
    ("sport_clubs", (), False),
    ("sport_guide_pdf", (), False),
    ("camdram_societies", (), False),
    ("cucbc_clubs", (), False),
    ("colleges", (), False),
    ("resolve", (), False),
    ("enrich", (), True),
    ("classify", (), False),
    ("camdram_events", (), True),
    ("talks_cam", (), True),
    ("cucbc_events", (), True),
    ("playwaze", (), True),
    ("uni_events", (), True),
    ("calendar_feeds", (), True),
    ("su_whatson", (), True),
    ("website_events", (), True),
    ("inbox", (), False),
    ("instagram", (), False),
    ("termcards", (), False),
    ("load", ("resolve",), False),
    ("talks", (), True),
    ("report", (), False),
)

#: Each group's stages, needs, stale_after and derive.
GROUP_SNAPSHOT: dict[str, dict[str, object]] = {
    "events": {
        "stages": (
            "term_dates",
            "camdram_events",
            "talks_cam",
            "cucbc_events",
            "playwaze",
            "uni_events",
            "calendar_feeds",
            "su_whatson",
            "website_events",
            "inbox",
            "instagram",
            "termcards",
            "load",
            "talks",
            "report",
        ),
        "needs": ("_resolved", "society_website", "su_profile"),
        "stale_after": timedelta(days=8),
        "derive": False,
    },
    "full": {"stages": (), "needs": (), "stale_after": None, "derive": True},
    "talks": {"stages": ("talks",), "needs": (), "stale_after": None, "derive": False},
}


def test_the_ordered_stage_names_are_frozen() -> None:
    names = [name for name, _requires, _fetches in STAGE_SNAPSHOT]
    assert len(names) == 25
    assert stage_names() == names
    assert list(STAGE_ORDER) == names


def test_each_stage_keeps_its_requires_and_fetches() -> None:
    assert tuple((s.name, s.requires, s.fetches) for s in STAGES) == STAGE_SNAPSHOT


def test_each_stage_runs_its_own_module() -> None:
    """No stage carries its own function: each is ``stages.<name>.run``."""
    assert [stage.fn for stage in STAGES] == [None] * len(STAGES)


def test_the_groups_are_frozen() -> None:
    assert list(GROUPS) == list(GROUP_SNAPSHOT)
    for name, group in GROUPS.items():
        assert group.name == name
        assert {
            "stages": group.stages,
            "needs": group.needs,
            "stale_after": group.stale_after,
            "derive": group.derive,
        } == GROUP_SNAPSHOT[name], name


def test_each_group_resolves_to_the_same_stages_in_registry_order() -> None:
    expected = {
        "events": list(GROUP_SNAPSHOT["events"]["stages"]),  # type: ignore[call-overload]
        "full": [name for name, _requires, _fetches in STAGE_SNAPSHOT],
        "talks": ["talks"],
    }
    for name, stages in expected.items():
        group = resolve_group(name)
        assert [s.name for s in resolve_stages(group.stages or None)] == stages, name
