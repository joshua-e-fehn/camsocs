"""Cross-source event de-duplication at load time (`events.duplicates`): one
event, several sources — the higher-evidence reading keeps the event, the
others become additional claims on it."""

from __future__ import annotations

from datetime import UTC, datetime
from zoneinfo import ZoneInfo

from camsocs_pipeline.claims import llm_field, parser_field
from camsocs_pipeline.events.duplicates import find_duplicates
from camsocs_pipeline.keys import event_key
from camsocs_pipeline.models.observation import EventObservation, IdentityHints, OrganiserObs
from camsocs_pipeline.pipeline.load import plan_observations

LONDON = ZoneInfo("Europe/London")
SEEN = datetime(2026, 10, 9, 12, 0, tzinfo=UTC)
ORG = "org-test-players"


def ms(*parts: int) -> int:
    return int(datetime(*parts, tzinfo=LONDON).timestamp() * 1000)


def reading(
    source: str,
    external_id: str,
    title: str,
    starts_at: int,
    *,
    all_day: bool = False,
    organisers: tuple[str, ...] = (ORG,),
    visibility: str = "public",
    llm: bool = False,
    url: str | None = None,
) -> EventObservation:
    source_url = url or f"https://{source}.example.org/{external_id}"
    if llm:
        text = f"{title} on Thursday 15 October"
        fields = [
            llm_field(
                "title",
                title,
                quote=title,
                source_text=text,
                source_type="society_website",
                model="bulk-model-1",
                prompt_version="website_events_v1",
                evidence="primary",
            ),
            llm_field(
                "startsAt",
                starts_at,
                quote=None,
                source_text=text,
                source_type="society_website",
                model="bulk-model-1",
                prompt_version="website_events_v1",
                evidence="primary",
            ),
        ]
    else:
        fields = [
            parser_field("title", title, extractor=f"{source}.title", evidence="primary"),
            parser_field("startsAt", starts_at, extractor=f"{source}.startsAt", evidence="primary"),
        ]
    fields.append(parser_field("allDay", all_day, extractor=f"{source}.allDay", evidence="primary"))
    fields.append(
        parser_field(
            "sourceUrl", source_url + "#page", extractor=f"{source}.page", evidence="primary"
        )
    )
    return EventObservation(
        source_type={
            "camdram": "camdram",
            "su_whatson": "su_whatson",
            "website": "society_website",
            "termcard": "termcard",
            "mailing_list": "mailing_list_email",
            "google_calendar": "ics_feed",
        }[source],
        source_key=external_id,
        source_url=source_url,
        retrieved_at=SEEN,
        fields=fields,
        event_source=source,
        external_id=external_id,
        visibility=visibility,
        organisers=[
            OrganiserObs(identity=IdentityHints(name=key, known_key=key)) for key in organisers
        ],
    )


CAMDRAM = reading("camdram", "show:1/performance:2/2026-10-15", "Hamlet", ms(2026, 10, 15, 19, 30))
SU = reading("su_whatson", "events/1/2", "Test Players present: Hamlet", ms(2026, 10, 15, 19, 45))


def test_a_show_on_camdram_and_su_whats_on_is_one_event() -> None:
    duplicates = find_duplicates([SU, CAMDRAM])
    assert duplicates.primary_of == {
        ("su_whatson", "events/1/2"): ("camdram", "show:1/performance:2/2026-10-15")
    }
    assert duplicates.coarser == set()


def test_the_duplicate_adds_claims_to_the_primary_event_only() -> None:
    plan = plan_observations([SU, CAMDRAM])
    primary_key = event_key("camdram", "show:1/performance:2/2026-10-15")
    assert {c.entity_key for c in plan.claims} == {primary_key}
    su_claims = [c for c in plan.claims if c.source_url == SU.source_url]
    assert {c.field for c in su_claims} == {"title", "startsAt", "allDay", "visibility"}
    # The event keeps Camdram's identity and page.
    identity = {c.field: c.value for c in plan.claims if c.source_url == CAMDRAM.source_url}
    assert identity["source"] == "camdram"
    assert identity["sourceUrl"] == CAMDRAM.source_url + "#page"
    # Camdram's organiser set (replace); the duplicate names no one else, so
    # it adds no set of its own — but its page still gets its sources row.
    assert [(s.event_key, s.mode) for s in plan.event_organisers] == [(primary_key, "replace")]
    assert {r.url for r in plan.sources} == {CAMDRAM.source_url, SU.source_url}
    assert plan.duplicates.notes() == [
        "1 event readings merged into another source's event: 1 su_whatson → camdram"
    ]


def test_a_duplicate_adds_new_organisers_and_never_a_second_role() -> None:
    """2026-10-09: Camdram lists a show by the ADC with the Footlights as
    co-host; the Footlights' site calls it its own. A second role for the
    Footlights was removed by every load's replace and re-added by the merge."""
    show = reading("camdram", "show:9/performance:9/2026-10-15", "Revue", ms(2026, 10, 15, 19, 30))
    show.organisers = [
        OrganiserObs(identity=IdentityHints(name="ADC", known_key=ORG)),
        OrganiserObs(identity=IdentityHints(name="FL", known_key="org-fl"), role="co_host"),
    ]
    site = reading("website", "org-fl:2026-10-15:revue", "Revue", ms(2026, 10, 15, 19, 30))
    site.organisers = [
        OrganiserObs(identity=IdentityHints(name="FL", known_key="org-fl")),
        OrganiserObs(identity=IdentityHints(name="Guest", known_key="org-guest")),
    ]
    plan = plan_observations([site, show])
    sets = [(s.mode, [(o.org_key, o.role) for o in s.organisers]) for s in plan.event_organisers]
    # One set per event, folded from both readings: a replace followed by a
    # merge (in another request, maybe) removed the guest and added it back
    # on every load (review 2026-10-10).
    assert sets == [
        ("replace", [(ORG, "organiser"), ("org-fl", "co_host"), ("org-guest", "organiser")])
    ]
    assert len({s.event_key for s in plan.event_organisers}) == len(plan.event_organisers)


def test_a_camdram_show_without_a_society_merges_with_its_companys_page() -> None:
    show = reading(
        "camdram",
        "show:7/performance:7/2026-10-30",
        "Tom Example: Ribbing For Your Pleasure",
        ms(2026, 10, 30, 23, 0),
        organisers=(),
    )
    site = reading(
        "website",
        "org-fl:2026-10-30:tom-example-ribbing-for-your-pleasure",
        "Tom Example: Ribbing For Your Pleasure",
        ms(2026, 10, 30, 23, 0),
        organisers=("org-fl",),
    )
    plan = plan_observations([site, show])
    assert plan.duplicates.primary_of == {
        ("website", "org-fl:2026-10-30:tom-example-ribbing-for-your-pleasure"): (
            "camdram",
            "show:7/performance:7/2026-10-30",
        )
    }
    (only,) = plan.event_organisers
    assert [(o.org_key, o.role) for o in only.organisers] == [("org-fl", "organiser")]


def test_one_organisers_card_and_page_at_the_same_minute_are_one_event() -> None:
    card = reading(
        "termcard",
        "org:2026-10-20:seminar-2",
        "Seminar 2: Ethics in Modelling",
        ms(2026, 10, 20, 16),
    )
    page = reading(
        "website",
        "org:2026-10-20:seminar",
        "Seminar: Financial Mathematics and Modelling",
        ms(2026, 10, 20, 16),
    )
    assert len(find_duplicates([card, page]).primary_of) == 1
    # Not at another minute, and not with nothing but "Seminar" in common.
    later = reading(
        "website", "org:2026-10-20:x", "Seminar: Survival Psychology", ms(2026, 10, 20, 16)
    )
    assert find_duplicates([card, later]).primary_of == {}


def test_a_feeds_time_and_a_pages_an_hour_apart_in_summer_time_are_one_event() -> None:
    feed = reading("google_calendar", "uid-9/x", "Open training session", ms(2026, 10, 9, 20, 0))
    page = reading(
        "website", "org:2026-10-09:open-training-session", "Open training session",
        ms(2026, 10, 9, 19, 0), llm=True,
    )  # fmt: skip
    duplicates = find_duplicates([feed, page])
    assert duplicates.primary_of == {
        ("website", "org:2026-10-09:open-training-session"): ("google_calendar", "uid-9/x")
    }
    # The feed's time stands: the page adds no competing start.
    assert duplicates.coarser == {("website", "org:2026-10-09:open-training-session")}
    # In winter (GMT) an hour apart is two events.
    winter_feed = reading("google_calendar", "uid-9/y", "Open training", ms(2026, 11, 20, 20, 0))
    winter_page = reading(
        "website", "org:2026-11-20:open-training", "Open training", ms(2026, 11, 20, 19, 0)
    )
    assert find_duplicates([winter_feed, winter_page]).primary_of == {}


def test_an_all_day_reading_adds_no_competing_start() -> None:
    card = reading("termcard", "org:2026-10-15:hamlet", "Hamlet", ms(2026, 10, 15), all_day=True)
    plan = plan_observations([card, CAMDRAM])
    card_fields = {c.field for c in plan.claims if c.source_url == card.source_url}
    assert card_fields == {"title", "visibility"}


def test_a_matinee_and_an_evening_stay_two_events() -> None:
    matinee = reading(
        "camdram", "show:1/performance:1/2026-10-15", "Hamlet", ms(2026, 10, 15, 14, 30)
    )
    site = reading("website", "org:2026-10-15:hamlet", "Hamlet", ms(2026, 10, 15), all_day=True)
    duplicates = find_duplicates([site, CAMDRAM, matinee])
    assert set(duplicates.primary_of) == {("website", "org:2026-10-15:hamlet")}
    assert duplicates.coarser == {("website", "org:2026-10-15:hamlet")}


def test_a_feed_beats_a_page_the_model_read() -> None:
    page = reading("website", "org:2026-10-15:quiz", "Pub Quiz", ms(2026, 10, 15, 19, 0), llm=True)
    feed = reading("google_calendar", "uid-1/x", "CUTP Pub Quiz", ms(2026, 10, 15, 19, 15))
    duplicates = find_duplicates([page, feed])
    assert duplicates.primary_of == {
        ("website", "org:2026-10-15:quiz"): ("google_calendar", "uid-1/x")
    }


def test_what_never_merges() -> None:
    other_org = reading(
        "su_whatson", "events/9/1", "Hamlet", ms(2026, 10, 15, 19, 30), organisers=("org-x",)
    )
    late = reading("su_whatson", "events/1/3", "Hamlet", ms(2026, 10, 15, 20, 30))
    next_day = reading("su_whatson", "events/1/4", "Hamlet", ms(2026, 10, 16, 19, 30))
    different = reading("su_whatson", "events/1/5", "Board games night", ms(2026, 10, 15, 19, 30))
    mail = reading(
        "mailing_list",
        "org:2026-10-15:hamlet",
        "Hamlet",
        ms(2026, 10, 15, 19, 30),
        visibility="cam_only",
        url="inbound:<abc@example.org>",
    )
    nobody = reading("su_whatson", "events/1/6", "Hamlet", ms(2026, 10, 15, 19, 30), organisers=())
    records = [CAMDRAM, other_org, late, next_day, different, mail, nobody]
    assert find_duplicates(records).primary_of == {}


def test_two_entries_of_one_listing_stay_two_events() -> None:
    # One feed lists both: the listing itself says they are two events, even
    # with the same organiser, day, start and look-alike titles.
    feed = "https://calendar.example.org/basic.ics"
    first = reading("google_calendar", "uid-1", "Chess club", ms(2026, 10, 15, 19, 0), url=feed)
    second = reading(
        "google_calendar", "uid-2", "Chess club beginners", ms(2026, 10, 15, 19, 0), url=feed
    )
    assert find_duplicates([first, second]).primary_of == {}
