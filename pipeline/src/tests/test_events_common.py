"""What every events stage shares: checks, drafts → observations, organiser
resolution against staging, staging directories and stored images."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import respx

from camsocs_pipeline.claims import parser_field
from camsocs_pipeline.events.checks import check_draft, mentions_link_in_bio
from camsocs_pipeline.events.common import (
    LONDON,
    EventDraft,
    Tally,
    build_event_observation,
    clean_text,
    default_window,
    finalise,
    infer_event_type,
    merge_drafts,
)
from camsocs_pipeline.keys import event_key
from camsocs_pipeline.media import CachedImages, sniff_raster
from camsocs_pipeline.models.observation import IdentityHints, Observation, OrganiserObs
from camsocs_pipeline.pipeline.load import ConvexLoader, attach_stored_files, plan_observations
from camsocs_pipeline.resolve.lookup import OrgLookup
from camsocs_pipeline.staging.store import StagingStore, events_directory

NOW = datetime(2026, 10, 7, 12, 0, tzinfo=UTC)
WINDOW = default_window(NOW)
AT = NOW
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


def draft(**overrides) -> EventDraft:
    values = {
        "event_source": "ics",
        "external_id": "uid-1",
        "title": "Freshers' Social",
        "starts_at": datetime(2026, 10, 14, 19, 0, tzinfo=LONDON),
    }
    values.update(overrides)
    return EventDraft(**values)


def organisation(key: str, name: str, **identity) -> Observation:
    return Observation(
        source_type="su_directory",
        source_key=key,
        source_url="https://www.cambridgesu.co.uk/opportunities/societies/",
        retrieved_at=AT,
        entity_type="organisation",
        identity=IdentityHints(name=name, **identity),
        entity_key=key,
        fields=[parser_field("name", name, extractor="t", evidence="secondary")],
    )


def fields_of(observation) -> dict:
    return {f.field: f for f in observation.fields}


class TestChecks:
    def test_impossible_years_are_rejected(self) -> None:
        for year in (1980, 1996, 2031):
            result = check_draft(
                draft(starts_at=datetime(year, 10, 14, tzinfo=LONDON)), WINDOW, now=NOW
            )
            assert (result.keep, result.reason) == (False, "impossible date")

    def test_an_end_before_the_start_is_dropped_and_the_event_kept(self) -> None:
        d = draft(ends_at=datetime(2026, 10, 14, 18, 0, tzinfo=LONDON))
        assert check_draft(d, WINDOW, now=NOW).keep
        assert d.ends_at is None

    def test_events_outside_the_window_are_left_out(self) -> None:
        d = draft(starts_at=datetime(2027, 3, 1, 19, 0, tzinfo=LONDON))
        assert check_draft(d, WINDOW, now=NOW).reason == "outside the window"

    def test_link_in_bio_is_flagged(self) -> None:
        assert mentions_link_in_bio("Tickets: link in our bio!")
        assert mentions_link_in_bio(None, "see linktr.ee/oursoc")
        assert not mentions_link_in_bio("A biography of Newton")
        d = draft(description="Sign up via the link in bio")
        assert check_draft(d, WINDOW, now=NOW).keep and d.link_in_bio


class TestBuilder:
    def test_values_become_parser_claims_and_absent_covered_fields_missing(self) -> None:
        d = draft(
            ends_at=datetime(2026, 10, 14, 21, 0, tzinfo=LONDON),
            event_type="social",
            inferred={"eventType"},
            covers=frozenset({"description", "venueText", "bookingUrl"}),
            page_url="https://example.org/events/1",
        )
        observation = build_event_observation(
            d,
            source_type="ics_feed",
            source_url="https://example.org/cal.ics",
            retrieved_at=AT,
            evidence="primary",
        )
        fields = fields_of(observation)
        assert fields["startsAt"].value == int(d.starts_at.timestamp() * 1000)
        assert fields["allDay"].value is False
        assert fields["eventType"].status == "inferred"
        assert fields["title"].status is None  # found
        assert fields["sourceUrl"].value == "https://example.org/events/1"
        for name in ("description", "bookingUrl", "venueText"):
            assert (fields[name].status, fields[name].missing_reason) == ("missing", "not_found")
        assert "speakers" not in fields  # not covered: omitted, never null
        assert all(f.value is not None or f.status for f in observation.fields)
        assert observation.content_sha256 is None

    def test_link_in_bio_records_the_booking_link_as_not_published(self) -> None:
        d = draft(link_in_bio=True)
        fields = fields_of(
            build_event_observation(
                d,
                source_type="ics_feed",
                source_url="https://x.org/c.ics",
                retrieved_at=AT,
                evidence="primary",
            )
        )
        assert fields["bookingUrl"].missing_reason == "not_published"

    def test_organisers_resolve_through_the_index_or_wait_unresolved(self) -> None:
        index = OrgLookup()
        index.add(organisation("org-test-players", "Test Players", camdram_id=22))
        d = draft(
            organisers=[
                OrganiserObs(identity=IdentityHints(name="TP", camdram_id=22), role="co_host"),
                OrganiserObs(identity=IdentityHints(name="Test Players"), role="organiser"),
                OrganiserObs(identity=IdentityHints(name="Unknown Society"), role="co_host"),
            ]
        )
        observation = build_event_observation(
            d,
            source_type="camdram",
            source_url="https://www.camdram.net/x.json",
            retrieved_at=AT,
            evidence="primary",
            index=index,
        )
        assert [(o.identity.known_key, o.role) for o in observation.organisers] == [
            ("org-test-players", "organiser")
        ]
        assert [o.identity.name for o in observation.unresolved_organisers] == ["Unknown Society"]
        assert observation.is_keyed  # an unknown organiser never holds the event back

    def test_venues_become_keys_when_known_and_text_otherwise(self) -> None:
        known = draft(venue=IdentityHints(name="ADC Theatre", known_key="ven-adc-theatre"))
        text = draft(venue=IdentityHints(name="  Pembroke   New Cellars "))
        plan = plan_observations(
            [
                build_event_observation(
                    d,
                    source_type="camdram",
                    source_url="https://www.camdram.net/x.json",
                    retrieved_at=AT,
                    evidence="primary",
                )
                for d in (known, text)
            ]
        )
        venue_claims = {(c.field, c.value) for c in plan.claims if c.field.startswith("venue")}
        assert venue_claims == {
            ("venueKey", "ven-adc-theatre"),
            ("venueText", "Pembroke New Cellars"),
        }

    def test_drafts_merge_by_source_and_external_id(self) -> None:
        a = draft(organisers=[OrganiserObs(identity=IdentityHints(name="A"), role="organiser")])
        b = draft(organisers=[OrganiserObs(identity=IdentityHints(name="B"), role="organiser")])
        c = draft(external_id="uid-2")
        merged = merge_drafts([a, b, c])
        assert len(merged) == 2
        assert [o.identity.name for o in merged[0].organisers] == ["A", "B"]

    def test_finalise_counts_what_it_leaves_out(self) -> None:
        tally = Tally()
        kept = finalise(
            [draft(), draft(external_id="old", starts_at=datetime(1996, 1, 1, tzinfo=LONDON))],
            WINDOW,
            tally,
            now=NOW,
        )
        assert len(kept) == 1
        assert tally.dropped == {"impossible date": 1}

    def test_event_keys_are_minted_from_source_and_external_id(self) -> None:
        assert draft().key() == event_key("ics", "uid-1")


class TestText:
    def test_clean_text_turns_html_into_plain_text(self) -> None:
        assert clean_text("<p>Free&nbsp;pizza &amp; games</p><p>All welcome</p>") == (
            "Free pizza & games\nAll welcome"
        )
        assert clean_text("   ") is None
        assert clean_text("x" * 50, max_length=10) == "xxxxxxxxx…"

    def test_event_types_are_guessed_from_title_keywords_and_say_so(self) -> None:
        assert infer_event_type("Annual Careers Fair") == "careers"
        assert infer_event_type("Speaker Event: In Conversation with X") == "talk"
        assert infer_event_type("Something") == "other"


class TestOrgLookupForEvents:
    def test_it_reads_keyed_organisations_and_their_feeds_from_staging(
        self, tmp_path: Path
    ) -> None:
        staging = StagingStore(tmp_path)
        resolved = organisation("org-cuas", "CU Astronomical Society", su_id="7641")
        resolved.internal = {"talks_list_ids": ["201664"], "luma_calendar_ids": ["cal-1"]}
        unkeyed = organisation("org-x", "Unresolved")
        unkeyed.entity_key = None
        staging.write("_resolved", "20261007T000000Z-aaaaaa", [resolved, unkeyed])
        index = OrgLookup.from_staging(staging)
        assert len(index) == 1
        assert index.resolve(IdentityHints(name="?", su_id="7641")) == "org-cuas"
        assert index.resolve(IdentityHints(name="CU Astronomical Society")) == "org-cuas"
        assert index.owner_of_talks_list("201664") == "org-cuas"
        assert [(f.kind, f.value) for f in index.feeds()] == [
            ("luma", "cal-1"),
            ("talks", "201664"),
        ]

    def test_ambiguous_names_resolve_to_nobody(self) -> None:
        index = OrgLookup()
        index.add(organisation("org-chess-a", "Chess Club"))
        index.add(organisation("org-chess-b", "Chess Club"))
        assert index.resolve(IdentityHints(name="Chess Club")) is None

    def test_boat_clubs_resolve_by_college(self) -> None:
        index = OrgLookup()
        index.add(
            organisation(
                "org-jesus-college-boat-club",
                "Jesus College Boat Club",
                org_type="college_boat_club",
                college_hint="Jesus",
            )
        )
        hint = IdentityHints(name="Jesus", org_type="college_boat_club", college_hint="Jesus")
        assert index.resolve(hint) == "org-jesus-college-boat-club"


def test_events_directories_are_staging_directories(tmp_path: Path) -> None:
    staging = StagingStore(tmp_path)
    assert events_directory("camdram") == "camdram.events"
    observation = build_event_observation(
        draft(),
        source_type="camdram",
        source_url="https://www.camdram.net/x.json",
        retrieved_at=AT,
        evidence="primary",
    )
    staging.write(events_directory("camdram"), "20261007T000000Z-aaaaaa", [observation])
    staging.write("camdram", "20261007T000000Z-aaaaaa", [organisation("org-a", "A")])
    assert staging.directories() == ["camdram", "camdram.events"]
    assert staging.read_latest("camdram.events")[0].external_id == "uid-1"


class TestStoredImages:
    def test_raster_types_are_sniffed_and_svg_refused(self) -> None:
        assert sniff_raster(PNG) == "image/png"
        assert sniff_raster(b"\xff\xd8\xff\xe0rest") == "image/jpeg"
        assert sniff_raster(b"RIFF\x00\x00\x00\x00WEBPVP8 ") == "image/webp"
        assert sniff_raster(b"\x00\x00\x00\x1cftypavif") == "image/avif"
        assert sniff_raster(b"<svg xmlns='http://www.w3.org/2000/svg'/>") is None

    def test_load_uploads_our_copy_and_drops_images_it_cannot_store(
        self, net: respx.MockRouter, make_settings
    ) -> None:
        site = "https://happy-otter-123.convex.site"
        upload = net.post(f"{site}/api/pipeline/files").mock(
            return_value=httpx.Response(200, json={"storageId": "kg2abc", "sha256": "x"})
        )
        net.get("https://img.example/robots.txt").respond(404)
        net.get("https://img.example/ok.png").respond(200, content=PNG)
        net.get("https://img.example/page.html").respond(200, text="<html>not an image</html>")
        claims = []
        for n, url in enumerate(("https://img.example/ok.png", "https://img.example/page.html")):
            observation = build_event_observation(
                draft(external_id=f"e{n}", image_url=url),
                source_type="ics_feed",
                source_url="https://x.org/c.ics",
                retrieved_at=AT,
                evidence="primary",
            )
            claims.extend(plan_observations([observation]).claims)
        media = CachedImages(make_settings(min_host_interval=0.0))
        kept, stored, dropped = attach_stored_files(claims, ConvexLoader(site, "k"), media)
        media.close()
        images = [c.value for c in kept if c.field == "image"]
        assert images == [{"sourceUrl": "https://img.example/ok.png", "storageId": "kg2abc"}]
        assert (stored, dropped, upload.call_count) == (1, 1, 1)
        assert len(kept) == len(claims) - 1


def test_window_is_seven_days_back_to_seventy_ahead() -> None:
    assert WINDOW.start == datetime(2026, 9, 30, tzinfo=LONDON)
    assert WINDOW.end - WINDOW.start >= timedelta(days=77)


class TestPoliteClientAdditions:
    """`fetch(headers=…)` for an API key a source asks for, and `post_form`
    for a public listing that loads by a form POST (sources/base.py)."""

    def client(self, tmp_path: Path):
        from camsocs_pipeline.sources.base import HostGates, PoliteClient

        return PoliteClient(
            user_agent="camsocs-test/0.1 (+https://example.org/camsocs)",
            cache_dir=tmp_path / "cache",
            gates=HostGates(),
            sleep=lambda _s: None,
        )

    def test_extra_headers_never_replace_the_user_agent(
        self, tmp_path: Path, net: respx.MockRouter
    ) -> None:
        net.get("https://api.example/robots.txt").respond(404)
        route = net.get("https://api.example/x.json").respond(200, json={})
        with self.client(tmp_path) as client:
            client.fetch(
                "https://api.example/x.json",
                headers={"Authorization": "Bearer t", "User-Agent": "Mozilla/5.0"},
            )
        request = route.calls[0].request
        assert request.headers["authorization"] == "Bearer t"
        assert request.headers["user-agent"].startswith("camsocs-test/")

    def test_post_form_checks_robots_and_caches_per_body(
        self, tmp_path: Path, net: respx.MockRouter
    ) -> None:
        net.get("https://league.example/robots.txt").respond(
            200, text="User-agent: *\nDisallow: /private\n"
        )
        route = net.post("https://league.example/fixtures").respond(200, text="<div>ok</div>")
        blocked = net.post("https://league.example/private/x").respond(200)
        with self.client(tmp_path) as client:
            first = client.post_form("https://league.example/fixtures", {"page": "1"})
            again = client.post_form(
                "https://league.example/fixtures", {"page": "1"}, fresh_for=timedelta(hours=1)
            )
            other = client.post_form("https://league.example/fixtures", {"page": "2"})
            refused = client.post_form("https://league.example/private/x", {"a": "b"})
        assert first.ok and first.text == "<div>ok</div>"
        assert again.from_cache and again.url == "https://league.example/fixtures"
        assert other.ok and route.call_count == 2
        assert route.calls[0].request.content == b"page=1"
        assert refused.outcome == "disallowed_by_robots" and blocked.call_count == 0

    def test_post_form_never_follows_a_redirect(
        self, tmp_path: Path, net: respx.MockRouter
    ) -> None:
        net.get("https://league.example/robots.txt").respond(404)
        net.post("https://league.example/fixtures").respond(302, headers={"Location": "/login"})
        login = net.get("https://league.example/login").respond(200)
        with self.client(tmp_path) as client:
            result = client.post_form("https://league.example/fixtures", {"page": "1"})
        assert (result.outcome, result.status) == ("http_error", 302)
        assert login.call_count == 0


def test_no_events_module_can_reach_an_llm() -> None:
    """talks.cam content is never passed to an LLM (source-research §6), and no
    events source uses one: the package imports no LLM client or LLM helper."""
    import ast

    import camsocs_pipeline.events as package

    for path in Path(package.__file__).parent.glob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        imported: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported |= {alias.name for alias in node.names}
            elif isinstance(node, ast.ImportFrom):
                imported.add(node.module or "")
                imported |= {alias.name for alias in node.names}
        assert not {"camsocs_pipeline.extract.llm", "llm_field", "openai"} & imported, path.name


def test_personal_crsid_addresses_never_reach_a_public_field() -> None:
    from camsocs_pipeline.events.common import redact_personal_emails

    text = (
        "Tickets: ab123@cam.ac.uk or XYZ9@hermes.cam.ac.uk; committee: president@soc.example, "
        "soc-chess@lists.cam.ac.uk, jcr@jesus.cam.ac.uk."
    )
    assert redact_personal_emails(text) == (
        "Tickets: [personal email withheld] or [personal email withheld]; committee: "
        "president@soc.example, soc-chess@lists.cam.ac.uk, jcr@jesus.cam.ac.uk."
    )
    observation = build_event_observation(
        draft(title="Talk (RSVP ab123@cam.ac.uk)", description="Email ab123@cam.ac.uk"),
        source_type="ics_feed",
        source_url="https://x.org/c.ics",
        retrieved_at=AT,
        evidence="primary",
    )
    assert "ab123" not in observation.model_dump_json()
