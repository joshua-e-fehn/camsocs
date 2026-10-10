"""`camsocs clean-events` (review 2026-10-10): stored events no corrected
reader restates — pre-D6 notices, pre-fix D1 titles, unmarked external
events, cards no longer read — listed, and removed only on production."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import respx
from click.testing import CliRunner

from camsocs_pipeline.cleanup import candidates
from camsocs_pipeline.cli import cli
from camsocs_pipeline.config import EnvChoice
from camsocs_pipeline.models.wire import ScannedEvent

NOW = datetime(2026, 10, 12, 12, 0, tzinfo=UTC)
DAY = 86_400_000
NOW_MS = int(NOW.timestamp() * 1000)
SITE = "https://happy-otter-123.convex.site"


def stored(key: str, title: str, *, days: float, **overrides: object) -> ScannedEvent:
    values: dict[str, object] = {
        "key": key,
        "title": title,
        "starts_at": NOW_MS + int(days * DAY),
        "source": "google_calendar",
        "source_url": "https://calendar.google.com/calendar/ical/x/public/basic.ics",
        "visibility": "public",
        "organiser_keys": ["org-islamic-society"],
        "last_seen_at": NOW_MS - DAY // 2,
    }
    values.update(overrides)
    return ScannedEvent.model_validate(values)


EVENTS = [
    stored("evt-pr", "PR closed to sisters (Brothers PR Chill, Assassins start)", days=-5),
    stored("evt-mst", "MSt students in residence", days=-12),
    stored("evt-social", "Brothers PR Chill", days=-5),
    stored(
        "evt-ctf",
        "Some CTF 2026",
        days=-8,
        description="CTF Event from CTFTime\nMore info: https://ctf.example.org/",
        organiser_keys=["org-cyber-security-society"],
    ),
    stored(
        "evt-ctf-marked",
        "Next CTF 2026",
        days=-8,
        hosting="takes_part",
        description="CTF Event from CTFTime",
        organiser_keys=["org-cyber-security-society"],
    ),
    stored("evt-someone", "I someone", days=-30, last_seen_at=NOW_MS - 20 * DAY, source="camdram"),
    stored("evt-someone-now", "Drinks with someone", days=3),
    stored(
        "evt-card-old",
        "Opening Reception",
        days=40,
        source="termcard",
        last_seen_at=NOW_MS - 2 * DAY - 5 * DAY,
    ),
    stored("evt-card", "Oktoberfest", days=4, source="termcard"),
    stored("evt-show", "Closed", days=4, source="camdram"),
]


def test_the_candidates_are_the_events_no_reader_restates() -> None:
    found = {c.key: c.reason for c in candidates(EVENTS, now=NOW)}
    assert found == {
        "evt-pr": "notice:notice.room_closure",
        "evt-mst": "notice:notice.date_marker",
        "evt-ctf": "external:external.ctftime",
        "evt-someone": "stale-redaction",
        "evt-card-old": "stale-card",
    }


def test_titles_are_shown_only_when_asked() -> None:
    [first, *_] = candidates(EVENTS, now=NOW)
    assert "PR closed" not in first.line(titles=False) and first.key in first.line(titles=False)
    assert first.title.split()[0] in first.line(titles=True)


def invoke(make_settings, *args: str, env: str = "prod"):
    settings = make_settings(convex_http_url=SITE, pipeline_api_key="test-key")
    obj = {"settings": settings, "env": EnvChoice(env, settings.cache_dir / f".env.{env}")}
    return CliRunner().invoke(cli, list(args), obj=obj)


def test_the_command_lists_without_apply_and_removes_only_on_prod(
    make_settings, net: respx.MockRouter
) -> None:
    page = {
        "page": [event.model_dump(by_alias=True, exclude_none=True) for event in EVENTS],
        "isDone": True,
        "continueCursor": "",
    }
    net.post(f"{SITE}/api/pipeline/events/scan").respond(200, json=page)
    removal = net.post(f"{SITE}/api/pipeline/events/remove").respond(
        200, json={"removed": ["evt-pr"], "missing": []}
    )

    listed = invoke(make_settings, "clean-events")
    assert listed.exit_code == 0, listed.output
    assert "5 to remove" in listed.output and "dry run" in listed.output
    assert "PR closed" not in listed.output, "no titles without --titles"
    assert not removal.called

    refused = invoke(make_settings, "clean-events", "--apply", env="dev")
    assert refused.exit_code != 0 and "production only" in refused.output
    assert not removal.called

    applied = invoke(make_settings, "clean-events", "--apply")
    assert applied.exit_code == 0, applied.output
    body = json.loads(removal.calls[0].request.content)
    assert body["confirm"] == "REMOVE-EVENTS"
    assert sorted(body["keys"]) == sorted(
        ["evt-pr", "evt-mst", "evt-ctf", "evt-someone", "evt-card-old"]
    )


def test_a_week_old_ctf_already_marked_is_left_alone() -> None:
    later = NOW + timedelta(days=1)
    assert "evt-ctf-marked" not in {c.key for c in candidates(EVENTS, now=later)}
