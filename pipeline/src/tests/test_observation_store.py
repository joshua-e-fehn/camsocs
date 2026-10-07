"""The staging format and its store: what harvesters may write, and how the
loader finds the latest of each source."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from camsocs_pipeline.claims import parser_field
from camsocs_pipeline.models.observation import (
    EventObservation,
    FieldObs,
    IdentityHints,
    Observation,
    OrganiserObs,
)
from camsocs_pipeline.staging.store import RESOLVED, StagingStore

AT = datetime(2026, 10, 7, 12, 0, tzinfo=UTC)


def observation(name: str = "CU Chess Club", **overrides) -> Observation:
    values = {
        "source_type": "su_directory",
        "source_key": "6789",
        "source_url": "https://www.cambridgesu.co.uk/opportunities/societies/",
        "retrieved_at": AT,
        "entity_type": "organisation",
        "identity": IdentityHints(name=name, su_id="6789"),
        "fields": [parser_field("name", name, extractor="su.name", evidence="secondary")],
    }
    values.update(overrides)
    return Observation(**values)


class TestObservationRules:
    def test_a_field_without_a_value_must_say_missing(self) -> None:
        with pytest.raises(ValidationError, match="omit the field"):
            FieldObs(field="email", method="parser", evidence="primary", extractor="r")

    def test_a_missing_field_carries_no_value(self) -> None:
        with pytest.raises(ValidationError, match="carries no value"):
            FieldObs(
                field="email",
                value="a@b.org",
                status="missing",
                method="parser",
                evidence="primary",
                extractor="r",
            )

    def test_fields_must_belong_to_the_entity_type(self) -> None:
        with pytest.raises(ValidationError, match="not organisation fields: startsAt"):
            observation(fields=[parser_field("startsAt", 1, extractor="r", evidence="primary")])

    def test_vocabularies_are_enforced(self) -> None:
        with pytest.raises(ValidationError):
            observation(source_type="instagram_scrape")
        with pytest.raises(ValidationError):
            IdentityHints(name="x", level="galactic")

    def test_teams_need_a_parent_and_timestamps_a_zone(self) -> None:
        with pytest.raises(ValidationError, match="parent"):
            observation(entity_type="team", fields=[])
        with pytest.raises(ValidationError, match="timezone"):
            observation(retrieved_at=datetime(2026, 10, 7, 12, 0))

    def test_event_identity_is_not_repeated_as_fields(self) -> None:
        with pytest.raises(ValidationError, match="attributes"):
            EventObservation(
                source_type="ics_feed",
                source_key="x",
                source_url="https://x.org/cal.ics",
                retrieved_at=AT,
                event_source="ics",
                external_id="uid-1",
                visibility="public",
                fields=[parser_field("visibility", "public", extractor="r", evidence="primary")],
            )

    def test_keyed_means_every_reference_is_resolved(self) -> None:
        assert not observation().is_keyed
        assert observation(entity_key="org-cu-chess-club").is_keyed
        event = EventObservation(
            source_type="ics_feed",
            source_key="x",
            source_url="https://x.org/cal.ics",
            retrieved_at=AT,
            event_source="ics",
            external_id="uid-1",
            visibility="public",
            organisers=[OrganiserObs(identity=IdentityHints(name="Chess"))],
        )
        assert not event.is_keyed


class TestStagingStore:
    def test_round_trip_and_latest_file_wins(self, tmp_path) -> None:
        store = StagingStore(tmp_path)
        store.write("su_directory", "20261006T000000Z-aaaaaa", [observation("Old Name")])
        store.write("su_directory", "20261007T000000Z-bbbbbb", [observation("New Name")])
        latest = store.read_latest("su_directory")
        assert [record.identity.name for record in latest] == ["New Name"]
        assert latest[0] == observation("New Name")

    def test_directories_list_sources_then_resolved(self, tmp_path) -> None:
        store = StagingStore(tmp_path)
        store.write(RESOLVED, "r1", [observation(entity_key="org-cu-chess-club")])
        store.write("proctors_register", "r1", [observation(source_type="proctors_register")])
        store.write("camdram", "r1", [observation(source_type="camdram")])
        (tmp_path / "not-a-source").mkdir()
        assert store.directories() == ["camdram", "proctors_register", RESOLVED]

    def test_a_failed_or_empty_write_publishes_nothing(self, tmp_path) -> None:
        store = StagingStore(tmp_path)
        with pytest.raises(RuntimeError), store.writer("camdram", "r1") as out:
            out.write(observation())
            raise RuntimeError("crash mid-stage")
        assert store.write("camdram", "r2", []) == 0
        assert store.latest_path("camdram") is None
        assert list((tmp_path / "camdram").iterdir()) == []

    def test_unknown_directories_and_bad_run_keys_are_refused(self, tmp_path) -> None:
        store = StagingStore(tmp_path)
        with pytest.raises(ValueError, match="source type"):
            store.path("instagram_scrape", "r1")
        with pytest.raises(ValueError, match="run key"):
            store.path("camdram", "../escape")

    def test_nothing_staged_reads_as_empty(self, tmp_path) -> None:
        store = StagingStore(tmp_path / "missing")
        assert store.directories() == []
        assert store.read_latest("camdram") == []
