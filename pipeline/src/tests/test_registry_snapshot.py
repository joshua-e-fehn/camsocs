"""The stage registry and its groups, frozen (multi-campus seam, guardrail L0a).

Cambridge's stage and group names, the function each stage runs, their order,
what each group runs and reads, and each stage's `requires` and `fetches` are
part of what must stay byte-identical while the campus seam lands: the VPS timers, the alert script,
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


#: What each stage runs: ``module:qualname`` of the function `Stage.resolve`
#: returns. A stage given its own `fn`, or a module other than
#: ``stages.<name>`` (whose ``run`` may re-export another module's), shows here.
STAGE_TARGETS: dict[str, str] = {
    "term_dates": "camsocs_pipeline.stages.term_dates:run",
    "su_directory": "camsocs_pipeline.stages.su_directory:run",
    "proctors_register": "camsocs_pipeline.stages.proctors_register:run",
    "sport_clubs": "camsocs_pipeline.stages.sport_clubs:run",
    "sport_guide_pdf": "camsocs_pipeline.stages.sport_guide_pdf:run",
    "camdram_societies": "camsocs_pipeline.stages.camdram_societies:run",
    "cucbc_clubs": "camsocs_pipeline.stages.cucbc_clubs:run",
    "colleges": "camsocs_pipeline.stages.colleges:run",
    "resolve": "camsocs_pipeline.stages.resolve:run",
    "enrich": "camsocs_pipeline.stages.enrich:run",
    "classify": "camsocs_pipeline.stages.classify:run",
    "camdram_events": "camsocs_pipeline.events.camdram:run",
    "talks_cam": "camsocs_pipeline.events.talks_cam:run",
    "cucbc_events": "camsocs_pipeline.events.cucbc:run",
    "playwaze": "camsocs_pipeline.events.playwaze:run",
    "uni_events": "camsocs_pipeline.events.uni_events:run",
    "calendar_feeds": "camsocs_pipeline.events.calendar_feeds:run",
    "su_whatson": "camsocs_pipeline.events.su_whatson:run",
    "website_events": "camsocs_pipeline.sources.websites.events:run",
    "inbox": "camsocs_pipeline.stages.inbox:run",
    "instagram": "camsocs_pipeline.stages.instagram:run",
    "termcards": "camsocs_pipeline.stages.termcards:run",
    "load": "camsocs_pipeline.stages.load:run",
    "talks": "camsocs_pipeline.talks.stage:run",
    "report": "camsocs_pipeline.stages.report:run",
}


def test_each_stage_runs_its_own_module() -> None:
    """No stage carries its own function: each resolves through its module."""
    assert [stage.fn for stage in STAGES] == [None] * len(STAGES)


def test_each_stage_resolves_to_the_same_function() -> None:
    """The run target itself is frozen, so rerouting a stage (its own `fn`,
    or a `module` other than ``stages.<name>``) is a snapshot diff."""
    targets = {}
    for stage in STAGES:
        fn = stage.resolve()
        targets[stage.name] = f"{fn.__module__}:{fn.__qualname__}"
    assert list(targets) == list(STAGE_TARGETS)
    assert targets == STAGE_TARGETS


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
