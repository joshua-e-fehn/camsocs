"""Calendar noise (decision D6): the rules (`events.noise`), the model for
borderline readings and the sifting every load does (`extract.event_noise`).

The two feeds are excerpts of the real cached calendars (var/cache, read
2026-10-10): the Islamic Society's brothers' termcard calendar and the Cyber
Security Society's calendar, with VEVENTs copied as published — only the
security seminar's speaker, a person, is left out of its description. The
other texts are synthetic; organisations and links are made up or
`example.org`.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import respx

from camsocs_pipeline.claims import parser_field
from camsocs_pipeline.events.calendar_feeds import event_draft
from camsocs_pipeline.events.common import EventWindow, build_event_observation
from camsocs_pipeline.events.ics import parse_ics
from camsocs_pipeline.events.noise import (
    EventText,
    NoiseContext,
    candidate_links,
    judge,
    own_names,
)
from camsocs_pipeline.extract.event_noise import (
    NoiseClassifier,
    NoiseReply,
    sift_events,
    verdict_fields,
)
from camsocs_pipeline.extract.memo import LLMMemo
from camsocs_pipeline.keys import event_key
from camsocs_pipeline.models.observation import (
    EventObservation,
    IdentityHints,
    Observation,
    OrganiserObs,
)
from camsocs_pipeline.pipeline.load import ConvexLoader
from camsocs_pipeline.sources.links import name_tokens
from tests.fakes import FakeLLM

FIXTURES = Path(__file__).parent / "fixtures" / "events"
AT = datetime(2026, 10, 10, 1, 0, tzinfo=UTC)
#: Wide enough for every entry of the excerpts, past ones included.
WINDOW = EventWindow(datetime(2025, 9, 1, tzinfo=UTC), datetime(2027, 1, 1, tzinfo=UTC))
SITE = "https://quiet-otter-123.convex.site"

ISOC = IdentityHints(name="Islamic Society", known_key="org-islamic-society")
CYBER = IdentityHints(name="Cyber Security Society", known_key="org-cyber-security-society")
ISOC_FEED = "https://calendar.google.com/calendar/ical/isoc-brothers/public/basic.ics"
CYBER_FEED = "https://calendar.google.com/calendar/ical/cybersoc/public/basic.ics"


def feed_records(name: str, owner: IdentityHints, url: str) -> list[EventObservation]:
    """The fixture feed as the calendar_feeds stage stages it."""
    calendar = parse_ics((FIXTURES / name).read_bytes(), WINDOW)
    return [
        build_event_observation(
            event_draft(event, kind="google", owners=[owner]),
            source_type="ics_feed",
            source_url=url,
            retrieved_at=AT,
            evidence="primary",
        )
        for event in calendar.events
    ]


def title_of(record: EventObservation) -> str:
    return next(str(obs.value) for obs in record.fields if obs.field == "title")


def field_of(record: EventObservation, name: str) -> Any:
    return next((obs for obs in record.fields if obs.field == name), None)


def text(title: str, **overrides: Any) -> EventText:
    names = overrides.pop("organisers", ("Quokka Society",))
    return EventText(
        title=title,
        organisers=names,
        own_tokens=frozenset(name_tokens(*names)),
        own_names=own_names(names),
        source_type=overrides.pop("source_type", "ics_feed"),
        event_source=overrides.pop("event_source", "google_calendar"),
        **overrides,
    )


# --- the real feeds ------------------------------------------------------------------------------


class TestIslamicSocietyFeed:
    def test_prayer_room_notices_are_dropped_and_its_events_kept(self) -> None:
        records = feed_records("islamic_society_brothers.ics", ISOC, ISOC_FEED)
        classifier = NoiseClassifier()
        kept = sift_events(records, classifier)
        titles = sorted(title_of(r) for r in kept if isinstance(r, EventObservation))
        assert titles == [
            "Brothers PR Chill (Start of Assassins Game)",
            "Brothers Quran Circle",
            "OUISoc Visits Cambridge!",
            "Varsity at Oxford",
        ]
        assert classifier.stats.dropped == {"notice.room_closure": 3}
        assert len(classifier.stats.dropped_keys) == 3
        notes = "\n".join(classifier.stats.notes())
        assert "3 notices dropped (notice.room_closure 3)" in notes
        assert '"PR CLOSED for cleaning"' in notes

    def test_kept_events_are_the_societys_own(self) -> None:
        records = feed_records("islamic_society_brothers.ics", ISOC, ISOC_FEED)
        kept = sift_events(records, NoiseClassifier())
        for record in kept:
            assert isinstance(record, EventObservation)
            hosting = field_of(record, "hosting")
            assert hosting.value == "hosts"
            assert hosting.method == "parser"
            assert hosting.status == "inferred"
            assert hosting.extractor.startswith("event_noise.event.")
            assert field_of(record, "externalUrl") is None

    def test_the_rule_quotes_what_it_matched(self) -> None:
        verdict = judge(text("PR closed to brothers (Sisters Quran Circle)"))
        assert (verdict.kind, verdict.rule, verdict.evidence) == (
            "notice",
            "notice.room_closure",
            "PR closed",
        )
        # The prayer room as a venue is no closure.
        assert judge(text("Brothers PR Chill (Start of Assassins Game)")).kind == "event"


class TestCyberSecuritySocietyFeed:
    def test_ctftime_imports_are_taken_part_in_with_their_own_page(self) -> None:
        records = feed_records("cyber_security_society.ics", CYBER, CYBER_FEED)
        classifier = NoiseClassifier()
        kept = {title_of(r): r for r in sift_events(records, classifier)}
        assert len(kept) == len(records)  # nothing on it is a notice
        deadface = kept["🚩 DEADFACE CTF 2026"]
        assert field_of(deadface, "hosting").value == "takes_part"
        assert field_of(deadface, "hosting").extractor == "event_noise.external.ctftime"
        assert field_of(deadface, "hosting").evidence_quote == "CTF Event from CTFTime"
        assert field_of(deadface, "externalUrl").value == "https://ctf.deadface.io/"
        # "More info" is the page; the Discord invite above it never is.
        them = kept["🚩 THEM?!CTF 2026"]
        assert field_of(them, "externalUrl").value == "https://themctf.com/"
        assert field_of(kept["🚩 Incognito 7.0"], "externalUrl").value == (
            "https://incognito.axiosiiitl.dev/"
        )
        assert classifier.stats.external["external.ctftime"] == 3

    def test_its_own_workshops_and_talks_are_its_own(self) -> None:
        records = feed_records("cyber_security_society.ics", CYBER, CYBER_FEED)
        kept = {title_of(r): r for r in sift_events(records, NoiseClassifier())}
        for title in (
            "Beginner CTF Workshop",
            "HTB workshop event",
            "🧼💻 CyberSecurity Hygiene Basics - with CyberSoc President",
        ):
            assert field_of(kept[title], "hosting").value == "hosts", title

    def test_a_seminar_another_series_lists_on_talks_cam_is_taken_part_in(self) -> None:
        records = feed_records("cyber_security_society.ics", CYBER, CYBER_FEED)
        kept = {title_of(r): r for r in sift_events(records, NoiseClassifier())}
        seminar = kept["Title to be confirmed"]
        assert field_of(seminar, "hosting").value == "takes_part"
        assert field_of(seminar, "hosting").extractor == "event_noise.external.talks_cam"
        assert field_of(seminar, "externalUrl").value == (
            "https://talks.cam.ac.uk/talk/index/243718"
        )

    def test_a_talk_on_the_societys_own_list_is_its_own(self) -> None:
        records = feed_records("cyber_security_society.ics", CYBER, CYBER_FEED)
        own_talk = EventObservation(
            source_type="talks_list",
            source_key="243718",
            source_url="https://talks.cam.ac.uk/show/xml/1",
            retrieved_at=AT,
            event_source="talks_cam",
            external_id="243718",
            visibility="public",
            organisers=[OrganiserObs(identity=CYBER)],
            fields=[parser_field("title", "A talk", extractor="t", evidence="primary")],
        )
        kept = sift_events([*records, own_talk], NoiseClassifier())
        seminar = next(r for r in kept if title_of(r) == "Title to be confirmed")
        assert field_of(seminar, "hosting").value == "hosts"
        assert field_of(seminar, "hosting").extractor == "event_noise.event.own_talks_list"


# --- the rules ---------------------------------------------------------------------------------


class TestNoticeRules:
    def test_closures_openings_and_opening_hours(self) -> None:
        for title in (
            "PR CLOSED for cleaning",
            "PR closed to sisters",
            "MCR Room closed for renovation",
            "Prayer room reopens",
            "Bar open",
            "Library opening hours",
        ):
            assert judge(text(title)).rule == "notice.room_closure", title
        for title in (
            "(CLOSED) MCR Committee Meeting",
            "Sisters' Open Mic Night",
            "Open",
            "Bar Reopening Night",
        ):
            assert judge(text(title)).kind == "event", title
        # A closure is a notice whatever event its reason names.
        assert judge(text("PR closed to sisters (Brothers Social Night)")).kind == "notice"

    def test_cancellations_of_nothing(self) -> None:
        for title in ("Cancelled", "No Archery at Churchill", "No session this week"):
            assert judge(text(title)).rule == "notice.nothing", title
        # A cancelled event is still the event.
        assert judge(text("Cancelled: Student Drop-In Evening")).kind == "event"
        assert judge(text("No-Pressure Social")).kind == "event"

    def test_booking_and_admin_notices(self) -> None:
        assert judge(text("Grad Hall Booking Opens")).rule == "notice.booking"
        for title in (
            "2025 JCR Committee Nominations Deadline",
            "Deadline for Photo Contest",
            "Essay Competition Submissions Close",
            "Porters' office hours",
        ):
            assert judge(text(title)).rule == "notice.admin", title
        # With an event word it is only borderline.
        verdict = judge(text("Beat the Deadline workshop"))
        assert (verdict.kind, verdict.borderline) == ("event", ("deadline-like",))

    def test_date_markers(self) -> None:
        for title in (
            "Full Term starts",
            "End of Michaelmas Term",
            "Bank Holiday",
            "Reading week",
            "MSt students in residence",
            "Christmas vacation 2026",
        ):
            assert judge(text(title)).rule == "notice.date_marker", title
        for title in ("End of Term Social", "Start of term party", "Holiday session"):
            assert judge(text(title)).kind == "event", title

    def test_placeholders_only_with_nothing_else(self) -> None:
        for title in ("TBC", "Busy", "Hold", "Title to be confirmed", "?"):
            assert judge(text(title)).rule == "notice.placeholder", title
        described = text("Title to be confirmed", description="A visiting researcher on privacy.")
        assert judge(described).borderline == ("placeholder with a description",)
        assert judge(text("TBC", has_speakers=True)).kind == "event"
        # A listing that states its events (talks.cam) has no placeholders.
        talk = text("Title to be confirmed", source_type="talks_list", event_source="talks_cam")
        assert judge(talk).kind == "event"


class TestExternalRules:
    def test_a_title_the_society_marks(self) -> None:
        verdict = judge(text("[External] Energy conference", urls=("https://cuen.example.org/",)))
        assert (verdict.kind, verdict.rule) == ("external", "external.marked")
        assert verdict.external_url == "https://cuen.example.org/"

    def test_a_ctf_named_after_the_society_is_its_own(self) -> None:
        own = text(
            "Quokka Soc CTF",
            description="CTF Event from CTFTime",
            organisers=("Quokka Society", "Quokka Soc"),
        )
        assert judge(own).kind == "event"

    def test_candidate_links_are_never_invites_forms_maps_or_the_societys_own(self) -> None:
        links = candidate_links(
            [
                "https://discord.gg/abc",
                "https://forms.gle/xyz",
                "https://maps.app.goo.gl/q",
                "https://www.instagram.com/quokkasoc/",
                "https://www.linkedin.com/in/someone/",
                "https://quokka.example.org/events",
                "https://poster.example.net/card.png",
                "https://hack.example.net/",
            ],
            own_hosts=["quokka.example.org"],
        )
        assert links == ["https://hack.example.net/"]


class TestBorderline:
    def test_hosted_by_an_organisation_not_a_person(self) -> None:
        other = text("Energy modelling talk", description="Organised by the Energy Initiative.")
        assert judge(other).borderline == ("hosted by another",)
        person = text("Pub social", description="Hosted by Anna Smith & Ben Jones")
        assert judge(person).borderline == ()
        ours = text("Pub social", description="Hosted by the Quokka Society")
        assert judge(ours).borderline == ()

    def test_attending_and_other_universities(self) -> None:
        kirtan = text(
            "KCL Kirtan Darbar",
            description="Very beautiful venue, tonnes of sikh socs go",
        )
        assert judge(kirtan).borderline == ("attending", "another university")

    def test_fixtures_listings_and_own_names_settle_it(self) -> None:
        assert judge(text("Blues vs Oxford 1s (A)")).rule == "event.fixture"
        assert judge(text("Varsity at Oxford")).rule == "event.fixture"
        cucbc = text("Fairbairn Cup Tournament", source_type="cucbc", event_source="cucbc")
        assert judge(cucbc).rule == "event.listing"
        named = text("CUQS Careers Fair 2026", organisers=("Cambridge University Quokka Society",))
        assert judge(named).rule == "event.own_name"  # its acronym
        # A topic word of the name is no claim to the event.
        topic = text("Engineering Careers Fair", organisers=("Engineering Society",))
        assert judge(topic).borderline == ("gathering",)


# --- the model ---------------------------------------------------------------------------------


def borderline_record(title: str, description: str, *, source_type: str = "ics_feed"):
    draft_fields = [
        parser_field("title", title, extractor="t", evidence="primary"),
        parser_field("description", description, extractor="t", evidence="primary"),
    ]
    return EventObservation(
        source_type=source_type,
        source_key="k1",
        source_url="https://calendar.google.com/calendar/ical/quokka/public/basic.ics",
        retrieved_at=AT,
        event_source="google_calendar",
        external_id="k1",
        visibility="public",
        organisers=[OrganiserObs(identity=IdentityHints(name="Quokka Society", known_key="org-q"))],
        fields=draft_fields,
    )


KIRTAN = borderline_record(
    "KCL Kirtan Darbar",
    "Very beautiful venue, tonnes of sikh socs go. Details: https://kirtan.example.org/",
)


class TestModel:
    def test_an_external_verdict_with_its_quote_and_page(self) -> None:
        llm = FakeLLM(
            lambda _t, _tier: {
                "kind": "external",
                "evidence_quote": "tonnes of sikh socs go",
                "external_link": 1,
            }
        )
        classifier = NoiseClassifier(llm)  # type: ignore[arg-type]
        [kept] = sift_events([KIRTAN], classifier)
        assert isinstance(kept, EventObservation)
        hosting = field_of(kept, "hosting")
        assert (hosting.value, hosting.method, hosting.status) == ("takes_part", "llm", None)
        assert (hosting.extractor, hosting.prompt_version) == ("bulk-model-1", "event_noise_v1")
        assert (hosting.evidence_quote, hosting.quote_check) == ("tonnes of sikh socs go", "exact")
        assert field_of(kept, "externalUrl").value == "https://kirtan.example.org/"
        assert classifier.stats.external == {"model": 1}
        [call] = llm.calls
        assert (
            "KCL Kirtan Darbar" in call["text"] and "1. https://kirtan.example.org/" in call["text"]
        )

    def test_an_unquoted_external_verdict_is_inferred_and_a_bad_link_is_dropped(self) -> None:
        llm = FakeLLM(lambda _t, _tier: {"kind": "external", "external_link": 7})
        [kept] = sift_events([KIRTAN], NoiseClassifier(llm))  # type: ignore[arg-type]
        assert field_of(kept, "hosting").status == "inferred"
        assert field_of(kept, "externalUrl").status == "missing"

    def test_a_notice_needs_its_quote(self) -> None:
        essay = borderline_record("Essay Competition Opens", "Questions released; deadline later.")
        unquoted = FakeLLM(lambda _t, _tier: {"kind": "notice", "evidence_quote": "made up"})
        classifier = NoiseClassifier(unquoted)  # type: ignore[arg-type]
        [kept] = sift_events([essay], classifier)
        assert field_of(kept, "hosting").value == "hosts"
        assert classifier.stats.unverified == 1
        quoted = FakeLLM(
            lambda _t, _tier: {"kind": "notice", "evidence_quote": "Essay Competition Opens"}
        )
        classifier = NoiseClassifier(quoted)  # type: ignore[arg-type]
        assert sift_events([essay], classifier) == []
        assert classifier.stats.dropped == {"model": 1}

    def test_talks_cam_never_reaches_the_model(self) -> None:
        relay = borderline_record(
            "Energy conference",
            "The series is on talks.cam.ac.uk; hosted by the Energy Initiative",
        )
        llm = FakeLLM(lambda _t, _tier: {"kind": "event"})
        classifier = NoiseClassifier(llm)  # type: ignore[arg-type]
        sift_events([relay], classifier)
        assert llm.calls == []

    def test_a_failed_call_leaves_it_hosted(self) -> None:
        llm = FakeLLM(lambda _t, _tier: RuntimeError("down"))
        classifier = NoiseClassifier(llm)  # type: ignore[arg-type]
        [kept] = sift_events([KIRTAN], classifier)
        assert field_of(kept, "hosting").value == "hosts"
        assert (classifier.stats.model_failed, classifier.stats.undecided) == (1, 1)

    def test_replies_are_cached_and_a_dry_run_reads_the_cache(self, tmp_path: Path) -> None:
        memo = LLMMemo(tmp_path)
        llm = FakeLLM(
            lambda _t, _tier: {"kind": "external", "evidence_quote": "tonnes of sikh socs go"}
        )
        sift_events([KIRTAN], NoiseClassifier(llm, memo))  # type: ignore[arg-type]
        dry = NoiseClassifier(None, memo)
        [kept] = sift_events([KIRTAN], dry)
        assert field_of(kept, "hosting").value == "takes_part"
        assert dry.stats.model_cached == 1
        cold = NoiseClassifier(None, LLMMemo(tmp_path / "empty"))
        [kept] = sift_events([KIRTAN], cold)
        assert field_of(kept, "hosting").value == "hosts"
        assert cold.stats.undecided == 1

    def test_the_reply_schema_defaults(self) -> None:
        assert NoiseReply.model_validate({"kind": "event"}).external_link is None


# --- claims and the load ----------------------------------------------------------------------


def test_a_source_that_states_hosting_is_not_judged() -> None:
    stated = KIRTAN.model_copy(
        update={
            "fields": [
                *KIRTAN.fields,
                parser_field("hosting", "hosts", extractor="t", evidence="primary"),
            ]
        }
    )
    llm = FakeLLM(lambda _t, _tier: {"kind": "external"})
    [kept] = sift_events([stated], NoiseClassifier(llm))  # type: ignore[arg-type]
    assert [obs.value for obs in kept.fields if obs.field == "hosting"] == ["hosts"]
    assert llm.calls == []


def test_a_notice_on_an_event_another_listing_keeps_is_retracted() -> None:
    # One UID on two calendars (the Islamic Society's, 2026-10-10): the
    # brothers' calendar lists the Quran circle, the sisters' calendar the
    # same entry as a prayer-room closure. Posted before D6, the closure's
    # title could win; now it is restated not_found from its own listing.
    [circle] = [
        r
        for r in feed_records("islamic_society_brothers.ics", ISOC, ISOC_FEED)
        if title_of(r) == "Brothers Quran Circle"
    ]
    sisters = "https://calendar.google.com/calendar/ical/isoc-sisters/public/basic.ics"
    closure = circle.model_copy(
        update={
            "source_url": sisters,
            "fields": [
                parser_field(
                    "title",
                    "PR closed to sisters (Brothers Quran Circle)",
                    extractor="ics.title",
                    evidence="primary",
                )
                if obs.field == "title"
                else obs
                for obs in circle.fields
            ],
        }
    )
    lone = closure.model_copy(update={"external_id": "another-uid@google.com"})
    classifier = NoiseClassifier()
    kept = sift_events([circle, closure, lone], classifier)
    assert len(kept) == 2  # the lone closure is dropped; the shared one retracted
    by_url = {r.source_url: r for r in kept if isinstance(r, EventObservation)}
    assert title_of(by_url[ISOC_FEED]) == "Brothers Quran Circle"
    retracted = by_url[sisters]
    assert event_key(retracted.event_source, retracted.external_id) == event_key(
        circle.event_source, circle.external_id
    )
    assert retracted.venue is None
    assert {obs.field for obs in retracted.fields} == {obs.field for obs in circle.fields}
    for obs in retracted.fields:
        assert (obs.value, obs.status, obs.missing_reason) == (None, "missing", "not_found")
        assert obs.extractor == "event_noise.notice.room_closure"
    assert classifier.stats.retracted == 1
    assert classifier.stats.dropped == {"notice.room_closure": 2}
    assert "1 of the notices restated not_found" in "\n".join(classifier.stats.notes())


def test_a_rule_verdict_without_a_page_restates_it_missing() -> None:
    verdict = judge(text("[External] Energy conference"))
    fields = verdict_fields(KIRTAN, verdict)
    assert [(f.field, f.value, f.status, f.missing_reason) for f in fields] == [
        ("hosting", "takes_part", "inferred", None),
        ("externalUrl", None, "missing", "not_found"),
    ]


def test_context_reads_names_aliases_and_websites() -> None:
    org = Observation(
        source_type="su_profile",
        source_key="q",
        source_url="https://example.org/q",
        retrieved_at=AT,
        entity_type="organisation",
        identity=IdentityHints(name="Cambridge University Quokka Society", aliases=["CUQS"]),
        entity_key="org-q",
        fields=[
            parser_field(
                "website", "https://quokka.example.org/", extractor="t", evidence="primary"
            )
        ],
    )
    context = NoiseContext.from_records([org])
    reading = context.text_of(KIRTAN)
    assert "cuqs" in reading.own_names
    assert "quokka.example.org" in reading.own_hosts


def test_the_load_posts_no_notice_and_every_kept_events_verdict(net: respx.MockRouter) -> None:
    bodies: dict[str, list[Any]] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path.removeprefix("/api/pipeline/")
        bodies.setdefault(path, []).append(json.loads(request.content))
        body: dict[str, Any] = {"inserted": 1, "updated": 0, "unchanged": 0}
        if path == "claims":
            body |= {"entities": {"created": 1}, "rejected": []}
        return httpx.Response(200, json=body)

    net.post(url__startswith=f"{SITE}/api/pipeline/").mock(side_effect=handler)
    records = [
        *feed_records("islamic_society_brothers.ics", ISOC, ISOC_FEED),
        *feed_records("cyber_security_society.ics", CYBER, CYBER_FEED),
    ]
    report = ConvexLoader(SITE, "k", max_retries=0).post_observations(records, run_key="r1")
    claims = [claim for body in bodies["claims"] for claim in body["claims"]]
    keys = {claim["entityKey"] for claim in claims}
    for dropped in report.noise.dropped_keys:
        assert dropped not in keys
    assert len(report.noise.dropped_keys) == 3
    hosting = {c["entityKey"]: c["value"] for c in claims if c["field"] == "hosting"}
    # Every kept event carries its verdict (one title D1 cannot make safe aside).
    assert len(hosting) == len(records) - 3 - len(report.redaction.dropped)
    ctf = next(r for r in records if title_of(r) == "🚩 DEADFACE CTF 2026")
    assert hosting[event_key(ctf.event_source, ctf.external_id)] == "takes_part"
    external = [c for c in claims if c["field"] == "externalUrl" and "value" in c]
    assert {c["value"] for c in external} >= {"https://ctf.deadface.io/"}
    assert all(c["extractor"].startswith("event_noise.") for c in external)
