"""The suppression list on the pipeline side (`camsocs_pipeline.suppressions`):
nothing a removal or objection took off the site is posted again."""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from typing import Any

import pytest
import respx

import camsocs_pipeline.pipeline.load as load
from camsocs_pipeline.claims import missing_field, parser_field
from camsocs_pipeline.models.observation import (
    EventObservation,
    FetchInfo,
    IdentityHints,
    Observation,
    OrganiserObs,
    RelObs,
)
from camsocs_pipeline.models.wire import ClaimInput, EventOrganiserSet, SuppressionList
from camsocs_pipeline.pipeline.load import ConvexError, ConvexLoader, LoadPlan, plan_observations
from camsocs_pipeline.suppressions import (
    REDACTED,
    Suppressions,
    apply_suppressions,
    contact_hash,
)

SITE = "https://happy-otter-123.convex.site"
AT = datetime(2026, 10, 7, 12, 0, tzinfo=UTC)
ANNA = "anna.smith@gmail.com"


@pytest.fixture(autouse=True)
def _no_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(load.time, "sleep", lambda _seconds: None)


def org(key: str, *fields, **overrides) -> Observation:
    values = {
        "source_type": "society_website",
        "source_key": f"https://{key}.example/",
        "source_url": f"https://{key}.example/",
        "retrieved_at": AT,
        "fetch": FetchInfo(http_status=200),
        "entity_type": "organisation",
        "identity": IdentityHints(name=key),
        "entity_key": key,
        "fields": [parser_field("name", key, extractor="h1", evidence="primary"), *fields],
    }
    values.update(overrides)
    return Observation(**values)


def event(external_id: str, *organisers: str, merge: bool = False) -> EventObservation:
    return EventObservation(
        source_type="ics_feed",
        source_key=external_id,
        source_url="https://feeds.example/cal.ics",
        retrieved_at=AT,
        event_source="ics",
        external_id=external_id,
        visibility="public",
        organisers=[
            OrganiserObs(identity=IdentityHints(name=key, known_key=key)) for key in organisers
        ],
        unresolved_organisers=[OrganiserObs(identity=IdentityHints(name="Someone"))]
        if merge
        else [],
        fields=[
            parser_field("title", f"Talk {external_id}", extractor="ics", evidence="primary"),
            parser_field("startsAt", 1791489600000, extractor="ics", evidence="primary"),
        ],
    )


def field(name: str, value: object):
    return parser_field(name, value, extractor="t", evidence="primary")


def test_the_contact_hash_is_the_servers():
    # webapp/convex/lib/suppressions.ts contactHash: sha256 of trim + lower.
    expected = hashlib.sha256(ANNA.encode()).hexdigest()
    assert contact_hash("  Anna.Smith@GMAIL.com ") == expected


def test_a_suppressed_listing_is_posted_nowhere():
    chess = org(
        "org-chess",
        field("website", "https://chess.example/"),
        internal={"su_org_id": "1"},
        broker={
            "needs": [{"item": "speakers"}],
            "people": [{"name": "Anna", "role": "President"}],
        },
        relationships=[
            RelObs(
                type="partner_of",
                to_identity=IdentityHints(name="Go", known_key="org-go"),
                evidence_url="https://org-chess.example/",
            )
        ],
    )
    plan = plan_observations(
        [
            chess,
            org("org-go"),
            event("only-chess", "org-chess"),
            event("both", "org-chess", "org-go"),
            event("chess-and-unknown", "org-chess", merge=True),
        ]
    )
    report = apply_suppressions(plan, Suppressions(organisations=frozenset({"org-chess"})))

    assert {c.entity_key for c in plan.claims if c.entity_type == "organisation"} == {"org-go"}
    events = {c.entity_key for c in plan.claims if c.entity_type == "event"}
    assert len(events) == 2  # "only-chess" is not posted at all
    assert all(o.org_key != "org-chess" for s in plan.event_organisers for o in s.organisers)
    assert plan.org_internal == []
    assert plan.relationships == []
    assert plan.broker_profiles == []
    assert plan.people == []
    assert all(source.org_key != "org-chess" for source in plan.sources)
    assert report.counts["events"] == 1
    assert "held back by the suppression list" in str(report)


def test_a_suppressed_field_keeps_its_negative_claims():
    plan = plan_observations(
        [
            org(
                "org-chess",
                field("description", "We play chess."),
                missing_field("email", "not_found", extractor="t", evidence="primary"),
            )
        ]
    )
    apply_suppressions(
        plan, Suppressions(fields=frozenset({("org-chess", "description"), ("org-chess", "email")}))
    )
    kept = {(c.field, c.value is None) for c in plan.claims}
    assert ("description", False) not in kept
    assert ("email", True) in kept


def test_a_suppressed_address_is_cut_out_everywhere():
    plan = plan_observations(
        [
            org(
                "org-chess",
                field("email", ANNA.upper()),
                field(
                    "roleEmails",
                    [
                        {"role": "president", "email": ANNA},
                        {"role": "secretary", "email": "sec@chess.example"},
                    ],
                ),
                field("mailingList", {"platform": "other", "address": ANNA}),
                field("description", f"Write to {ANNA} or sec@chess.example."),
            ),
            org("org-go", field("roleEmails", [{"role": "other", "email": ANNA}])),
        ]
    )
    report = apply_suppressions(plan, Suppressions(contact_hashes=frozenset({contact_hash(ANNA)})))
    by_field = {(c.entity_key, c.field): c.value for c in plan.claims}
    assert ("org-chess", "email") not in by_field
    assert by_field[("org-chess", "roleEmails")] == [
        {"role": "secretary", "email": "sec@chess.example"}
    ]
    assert by_field[("org-chess", "mailingList")] == {"platform": "other"}
    assert by_field[("org-chess", "description")] == (f"Write to {REDACTED} or sec@chess.example.")
    assert ("org-go", "roleEmails") not in by_field
    assert ANNA not in json.dumps([c.to_wire() for c in plan.claims]).lower()
    assert report.counts["values redacted"] == 3


def test_a_suppressed_person_is_not_re_added():
    plan = plan_observations(
        [
            org(
                "org-chess",
                broker={
                    "people": [
                        {"name": "Anna", "role": "President"},
                        {"name": "Ben", "role": "Secretary"},
                    ]
                },
            )
        ]
    )
    anna = next(p.key for p in plan.people if p.name == "Anna")
    apply_suppressions(plan, Suppressions(people=frozenset({anna})))
    assert [p.name for p in plan.people] == ["Ben"]


class TestLoader:
    def loader(self, **kwargs) -> ConvexLoader:
        return ConvexLoader(SITE, "test-key", max_retries=1, **kwargs)

    def test_the_list_is_read_once_and_applied_before_posting(self, net: respx.MockRouter) -> None:
        listed = net.post(f"{SITE}/api/pipeline/suppressions").respond(
            200, json={"organisations": ["org-chess"], "truncated": False}
        )
        claims = net.post(f"{SITE}/api/pipeline/claims").respond(
            200, json={"inserted": 1, "rejected": []}
        )
        net.post(f"{SITE}/api/pipeline/sources").respond(200, json={"inserted": 1})
        loader = self.loader()
        report = loader.post_observations([org("org-chess"), org("org-go")])
        loader.post_observations([org("org-go")])
        assert listed.call_count == 1
        posted = json.loads(claims.calls[0].request.content)["claims"]
        assert {c["entityKey"] for c in posted} == {"org-go"}
        assert report.suppressed.counts["claims"] == 1

    def test_an_undeployed_route_filters_nothing_and_says_so(self, net: respx.MockRouter) -> None:
        net.post(f"{SITE}/api/pipeline/suppressions").respond(404, json={"error": "No route"})
        loader = self.loader()
        assert loader.suppressions().empty
        assert "not deployed" in (loader.suppressions_note or "")

    def test_a_truncated_list_stops_the_load(self, net: respx.MockRouter) -> None:
        net.post(f"{SITE}/api/pipeline/suppressions").respond(200, json={"truncated": True})
        with pytest.raises(ConvexError, match="truncated"):
            self.loader().suppressions()

    def test_a_dry_run_reads_no_list(self) -> None:
        loader = ConvexLoader("", "", dry_run=True)
        assert loader.suppressions().empty
        assert loader.suppressions_note == "dry run: suppression list not read"

    def test_the_wire_model_reads_the_route(self) -> None:
        body = SuppressionList.model_validate(
            {
                "organisations": ["org-a"],
                "fields": [{"orgKey": "org-b", "field": "email"}],
                "contactHashes": ["ab"],
                "people": ["per-1"],
                "truncated": False,
            }
        )
        suppressions = Suppressions.from_wire(body)
        assert suppressions.fields == frozenset({("org-b", "email")})
        assert len(suppressions) == 4


def test_an_event_with_an_unresolved_organiser_stays_without_the_suppressed_one() -> None:
    plan = plan_observations([event("e", "org-chess", merge=True)])
    apply_suppressions(plan, Suppressions(organisations=frozenset({"org-chess"})))
    assert [s.organisers for s in plan.event_organisers] == [[]]
    assert {c.field for c in plan.claims} >= {"title", "startsAt"}


#: Shared with webapp/convex/suppressions.test.ts: one name, one hash on both sides.
NAME_HASH = "93db1c9b776578519dcba3ae13c01ce85d7baf40a6e4d3de3b7f20973bec4774"


def test_events_and_names_removed_on_request_are_never_posted() -> None:
    from camsocs_pipeline.suppressions import Suppressions, apply_suppressions, name_hash

    assert name_hash("Anna-Lena Ó Bríen") == NAME_HASH
    suppressions = Suppressions.from_wire(
        SuppressionList(events=["evt-gone"], name_hashes=[name_hash("Anna Example")])
    )

    def event_claim(key: str, field: str, value: Any) -> ClaimInput:
        return ClaimInput(
            entity_type="event",
            entity_key=key,
            field=field,
            value=value,
            evidence="primary",
            method="parser",
            extractor="t",
            source_key="src-x",
            source_url="https://x.example/",
            source_type="ics_feed",
            retrieved_at=0,
        )

    plan = LoadPlan(
        claims=[
            event_claim("evt-gone", "title", "Quiz"),
            event_claim("evt-kept", "title", "Talk by ANNA EXAMPLE"),
            event_claim("evt-kept", "speakers", [{"name": "Anna Example"}, {"name": "Bo Ex"}]),
            event_claim("evt-solo", "speakers", [{"name": "Anna Example"}]),
        ],
        event_organisers=[
            EventOrganiserSet(event_key="evt-gone", organisers=[]),
        ],
    )
    report = apply_suppressions(plan, suppressions)
    by = {(c.entity_key, c.field): c.value for c in plan.claims}
    assert ("evt-gone", "title") not in by and plan.event_organisers == []
    assert by[("evt-kept", "title")] == "Talk by [name removed]"
    assert by[("evt-kept", "speakers")] == [{"name": "Bo Ex"}]
    assert ("evt-solo", "speakers") not in by
    assert report.counts["events"] == 1


def test_no_model_reads_a_suppressed_event_name_or_address(net: respx.MockRouter) -> None:
    """Privacy ordering (review 2026-10-10): the suppression list is applied
    before the calendar-noise model (D6) reads any reading, and quotes lose
    suppressed names too."""
    from camsocs_pipeline.extract.event_noise import NoiseClassifier
    from camsocs_pipeline.keys import event_key
    from camsocs_pipeline.suppressions import name_hash
    from tests.fakes import FakeLLM

    gone = event("gone", "org-chess")
    kept = event("kept", "org-chess")
    for record, title in ((gone, "Hackathon at Example Labs"), (kept, "Anna Example's hackathon")):
        record.fields[0] = parser_field("title", title, extractor="ics", evidence="primary")
        record.fields.append(
            parser_field(
                "description",
                f"Write to {ANNA}; Anna Example hosts it.",
                extractor="ics",
                evidence="primary",
            ).model_copy(update={"evidence_quote": "Anna Example hosts it"})
        )
    net.post(f"{SITE}/api/pipeline/suppressions").respond(
        200,
        json={
            "events": [event_key("ics", "gone")],
            "contactHashes": [contact_hash(ANNA)],
            "nameHashes": [name_hash("Anna Example")],
            "truncated": False,
        },
    )
    claims = net.post(f"{SITE}/api/pipeline/claims").respond(
        200, json={"inserted": 1, "rejected": []}
    )
    net.post(f"{SITE}/api/pipeline/sources").respond(200, json={"inserted": 1})
    net.post(f"{SITE}/api/pipeline/eventOrganisers").respond(200, json={"inserted": 1})
    llm = FakeLLM(lambda _t, _tier: {"kind": "event", "evidence_quote": "hackathon"})

    report = ConvexLoader(SITE, "test-key", max_retries=1).post_observations(
        [gone, kept],
        noise=NoiseClassifier(llm),  # type: ignore[arg-type]
    )

    seen = "\n".join(call["text"] for call in llm.calls)
    assert "Example Labs" not in seen, "the suppressed event never reached the model"
    assert "Anna Example" not in seen and ANNA not in seen
    assert "[name removed]" in seen and REDACTED in seen
    posted = json.dumps(json.loads(claims.calls[0].request.content))
    assert "Anna Example" not in posted and ANNA not in posted
    assert report.suppressed.counts["events"] == 1
