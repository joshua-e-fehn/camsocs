"""The loader's per-route methods and `post_observations`: what rows keyed
observations become, and in which order they are posted."""

from __future__ import annotations

import base64
import json
from datetime import UTC, datetime

import httpx
import pytest
import respx

import camsocs_pipeline.pipeline.load as load
from camsocs_pipeline import keys
from camsocs_pipeline.claims import missing_field, parser_field
from camsocs_pipeline.models.observation import (
    EventObservation,
    FetchInfo,
    IdentityHints,
    Observation,
    OrganiserObs,
    RelObs,
)
from camsocs_pipeline.pipeline.load import ConvexError, ConvexLoader, plan_observations
from camsocs_pipeline.seeds.term_dates import TERM_DATES

SITE = "https://happy-otter-123.convex.site"
AT = datetime(2026, 10, 7, 12, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def _no_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(load.time, "sleep", lambda _seconds: None)


def loader(**kwargs) -> ConvexLoader:
    return ConvexLoader(SITE, "test-key", max_retries=1, **kwargs)


def org(**overrides) -> Observation:
    values = {
        "source_type": "society_website",
        "source_key": "https://cugs.org/",
        "source_url": "https://cugs.org/",
        "retrieved_at": AT,
        "fetch": FetchInfo(http_status=200),
        "entity_type": "organisation",
        "identity": IdentityHints(name="CU German Society"),
        "entity_key": "org-cu-german-society",
        "fields": [parser_field("name", "CU German Society", extractor="h1", evidence="primary")],
    }
    values.update(overrides)
    return Observation(**values)


def event(**overrides) -> EventObservation:
    values = {
        "source_type": "ics_feed",
        "source_key": "uid-1",
        "source_url": "https://cugs.org/cal.ics",
        "retrieved_at": AT,
        "event_source": "ics",
        "external_id": "uid-1",
        "visibility": "public",
        "organisers": [
            OrganiserObs(identity=IdentityHints(name="CUGS", known_key="org-cu-german-society"))
        ],
        "fields": [
            parser_field("title", "Stammtisch", extractor="ics.summary", evidence="primary"),
            parser_field("startsAt", 1791489600000, extractor="ics.dtstart", evidence="primary"),
        ],
    }
    values.update(overrides)
    return EventObservation(**values)


class TestPlan:
    def test_unkeyed_records_are_skipped(self) -> None:
        plan = plan_observations([org(entity_key=None), org()])
        assert plan.skipped == 1
        assert len(plan.claims) == 1

    def test_sources_are_one_row_per_url_with_what_they_yielded(self) -> None:
        email = parser_field("email", "hello@cugs.org", extractor="mailto", evidence="primary")
        plan = plan_observations([org(), org(fields=[email])])
        [source] = plan.sources
        assert source.key == keys.source_key("https://cugs.org/")
        assert source.org_key == "org-cu-german-society"
        assert source.yielded == ["email", "name"]
        assert source.http_status == 200

    def test_a_page_seen_for_several_organisations_belongs_to_none(self) -> None:
        directory = "https://example.org/directory"
        plan = plan_observations(
            [
                org(source_url=directory),
                org(source_url=directory, entity_key="org-cu-chess-club"),
                org(),
            ]
        )
        owners = {source.url: source.org_key for source in plan.sources}
        assert owners == {directory: None, "https://cugs.org/": "org-cu-german-society"}

    def test_people_keep_their_academic_year(self) -> None:
        record = org(
            broker={
                "people": [
                    {"name": "Anna Example", "role": "President", "academic_year": "2026-27"}
                ]
            }
        )
        [person] = plan_observations([record]).people
        assert person.academic_year == "2026-27"

    def test_internal_identifiers_relationships_and_broker_rows(self) -> None:
        record = org(
            internal={"su_org_id": "6789", "ics_urls": ["https://cugs.org/cal.ics"]},
            relationships=[
                RelObs(
                    type="sponsors",
                    to_identity=IdentityHints(name="Bank", known_key="org-bank"),
                    evidence_url="https://cugs.org/sponsors",
                    direction="incoming",
                    evidence="primary",
                    visibility="public",
                )
            ],
            broker={
                "needs": [{"item": "sponsorship", "evidence_quote": "We seek sponsors"}],
                "people": [{"name": "Anna Example", "role": "President"}],
            },
        )
        plan = plan_observations([record])
        assert plan.org_internal[0].to_wire() == {
            "orgKey": "org-cu-german-society",
            "suOrgId": "6789",
            "icsUrls": ["https://cugs.org/cal.ics"],
        }
        [edge] = plan.relationships
        assert (edge.from_key, edge.type, edge.to_key) == (
            "org-bank",
            "sponsors",
            "org-cu-german-society",
        )
        assert edge.evidence_kind == "primary"
        assert plan.broker_profiles[0].needs[0].source_url == "https://cugs.org/"
        assert plan.broker_profiles[0].offers is None
        [person] = plan.people
        assert person.key == keys.person_key("org-cu-german-society", "Anna Example")
        assert person.method == "parser"

    def test_events_become_claims_and_an_organiser_set(self) -> None:
        plan = plan_observations([event()])
        key = keys.event_key("ics", "uid-1")
        assert {claim.entity_key for claim in plan.claims} == {key}
        assert plan.event_organisers[0].to_wire() == {
            "eventKey": key,
            "organisers": [{"orgKey": "org-cu-german-society", "role": "organiser"}],
            "mode": "replace",
        }

    def test_an_event_with_unresolved_organisers_only_adds(self) -> None:
        # An empty or partial index (a fresh machine, a --limit run) must not
        # remove the organisers Convex already knows.
        unresolved = event()
        unresolved.unresolved_organisers = [
            OrganiserObs(identity=IdentityHints(name="CU Somebody Society"))
        ]
        assert plan_observations([unresolved]).event_organisers[0].mode == "merge"

    def test_two_readings_of_one_field_from_one_source_are_not_posted(self) -> None:
        # Two rows of one PDF resolved to one organisation: whichever arrived
        # last would win. Neither does; the collision is reported.
        def guide_row(key: str, value: bool) -> Observation:
            return Observation(
                source_type="sport_guide_pdf",
                source_key=key,
                source_url="https://www.sport.cam.ac.uk/guide.pdf",
                retrieved_at=AT,
                entity_type="organisation",
                identity=IdentityHints(name="Rowing"),
                entity_key="org-boat-club-rowing",
                fields=[
                    parser_field(
                        "sport.collegeCompetition", value, extractor="guide", evidence="primary"
                    ),
                    parser_field("sport.sport", "Rowing", extractor="guide", evidence="primary"),
                ],
            )

        plan = plan_observations([guide_row("a", True), guide_row("b", False)])
        fields = {claim.field for claim in plan.claims}
        assert "sport.collegeCompetition" not in fields and "sport.sport" in fields
        assert plan.collisions == [
            "org-boat-club-rowing sport.collegeCompetition: 2 readings from one source"
        ]

    def test_two_stages_reading_one_home_page_join_their_readings(self) -> None:
        # The colleges stage and enrichment both read a JCR's home page: the
        # same URL with and without its slash, and parts of one list of
        # socials, are one reading each — not a collision that drops both.
        def home(stage: str, website: str, socials: list[dict]) -> Observation:
            return Observation(
                source_type="society_website",
                source_key=f"{stage}:home",
                source_url="https://quokkajcr.example/",
                retrieved_at=AT,
                entity_type="organisation",
                identity=IdentityHints(name="Quokka JCR"),
                entity_key="org-quokka-jcr",
                fields=[
                    parser_field("website", website, extractor=stage, evidence="primary"),
                    parser_field("socials", socials, extractor=stage, evidence="primary"),
                ],
            )

        insta = {"platform": "instagram", "url": "https://instagram.com/quokkajcr"}
        welfare = {"platform": "instagram", "url": "https://instagram.com/quokkajcr_welfare"}
        face = {"platform": "facebook_page", "url": "https://facebook.com/quokkajcr"}
        plan = plan_observations(
            [
                home("colleges", "https://quokkajcr.example", [insta, face, welfare]),
                home("website", "https://quokkajcr.example/", [face, insta]),
            ]
        )
        assert plan.collisions == []
        by_field = {c.field: c for c in plan.claims}
        assert by_field["website"].value == "https://quokkajcr.example"
        assert [s["url"] for s in by_field["socials"].value] == [
            face["url"],
            insta["url"],
            welfare["url"],
        ]
        assert sum(c.field == "socials" for c in plan.claims) == 1

    def test_internal_source_urls_make_no_source_row(self) -> None:
        mail = event(
            source_type="mailing_list_email",
            source_url="inbound:<abc@lists.cam.ac.uk>",
            event_source="mailing_list",
            visibility="cam_only",
        )
        assert plan_observations([mail]).sources == []


class TestRoutes:
    def test_post_observations_posts_in_dependency_order(self, net: respx.MockRouter) -> None:
        order: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            path = request.url.path.removeprefix("/api/pipeline/")
            order.append(path)
            body = {"inserted": 1, "updated": 0, "unchanged": 0}
            if path == "claims":
                body |= {"entities": {"created": 1}, "rejected": []}
            return httpx.Response(200, json=body)

        net.post(url__startswith=f"{SITE}/api/pipeline/").mock(side_effect=handler)
        record = org(
            internal={"su_org_id": "1"},
            broker={"needs": [{"item": "speakers"}]},
        )
        report = loader().post_observations([record, event()], run_key="r1")
        # The suppression list first: nothing is posted before it is applied.
        assert order == [
            "suppressions",
            "sources",
            "claims",
            "orgInternal",
            "eventOrganisers",
            "brokerInferences",
        ]
        assert report.claims.entities == {"created": 1}

    def test_claims_carry_the_run_key_and_collect_rejections(self, net: respx.MockRouter) -> None:
        route = net.post(f"{SITE}/api/pipeline/claims").respond(
            200,
            json={
                "inserted": 0,
                "updated": 0,
                "unchanged": 0,
                "entities": {"created": 0, "updated": 0, "unchanged": 0},
                "rejected": [{"index": 0, "entityKey": "org-a", "field": "x", "reason": "bad"}],
            },
        )
        plan = plan_observations(
            [org(fields=[missing_field("email", "not_found", extractor="r", evidence="primary")])]
        )
        result = loader().post_claims(plan.claims, run_key="r1")
        body = json.loads(route.calls[0].request.content)
        assert body["runKey"] == "r1"
        assert "value" not in body["claims"][0]
        assert result.rejected[0]["reason"] == "bad"

    def test_upload_file_sends_base64_and_returns_the_storage_id(self, net) -> None:
        route = net.post(f"{SITE}/api/pipeline/files").respond(
            200, json={"storageId": "kg2abc", "sha256": "ff", "inserted": 1, "unchanged": 0}
        )
        result = loader().upload_file(b"\x89PNG\r\n\x1a\n", "image/png")
        body = json.loads(route.calls[0].request.content)
        assert base64.b64decode(body["data"]) == b"\x89PNG\r\n\x1a\n"
        assert body["contentType"] == "image/png"
        assert result.storage_id == "kg2abc"
        assert ConvexLoader("", "", dry_run=True).upload_file(b"x", "image/png").storage_id == (
            "dry-run"
        )

    def test_inbound_pending_parses_mail(self, net) -> None:
        net.post(f"{SITE}/api/pipeline/inbound/pending").respond(
            200,
            json=[
                {"messageId": "<a@x>", "receivedAt": 1, "from": "l@x", "subject": "s", "text": "t"}
            ],
        )
        [mail] = loader().inbound_pending(limit=5)
        assert mail.message_id == "<a@x>"

    def test_purge_dev_calls_until_done(self, net) -> None:
        route = net.post(f"{SITE}/api/pipeline/purge").mock(
            side_effect=[
                httpx.Response(200, json={"deleted": {"fieldClaims": 4000}, "done": False}),
                httpx.Response(
                    200, json={"deleted": {"fieldClaims": 10, "orgCards": 3}, "done": True}
                ),
            ]
        )
        assert loader().purge_dev() == {"fieldClaims": 4010, "orgCards": 3}
        assert json.loads(route.calls[0].request.content) == {"confirm": "PURGE-DEV"}

    def test_purge_refusal_surfaces_as_an_error(self, net) -> None:
        net.post(f"{SITE}/api/pipeline/purge").respond(
            400, json={"error": "Refusing to purge: this is not the dev deployment"}
        )
        with pytest.raises(ConvexError, match="not the dev deployment"):
            loader().purge_dev()

    def test_term_dates_seed_posts_every_term(self, net) -> None:
        route = net.post(f"{SITE}/api/pipeline/termDates").respond(
            200, json={"inserted": 6, "updated": 0, "unchanged": 0}
        )
        result = loader().upsert_term_dates(TERM_DATES)
        terms = json.loads(route.calls[0].request.content)["terms"]
        assert result.inserted == 6
        assert terms[0] == {
            "academicYear": "2026-27",
            "term": "michaelmas",
            "fullTermStart": "2026-10-06",
            "fullTermEnd": "2026-12-04",
            "sourceUrl": "https://www.cam.ac.uk/about-the-university/term-dates-and-calendars",
        }
