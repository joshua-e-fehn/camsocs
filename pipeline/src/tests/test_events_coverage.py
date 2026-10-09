"""Events coverage (R3, 2026-10-09): feed references as societies write them
(Google embed ids, Luma calendar slugs), SU profiles' own event lists and
their yearless dates — offline (respx), fixtures shaped like the live pages."""

from __future__ import annotations

import json
from datetime import date

import pytest
import respx

from camsocs_pipeline.events import calendar_feeds, su_whatson
from camsocs_pipeline.extract.when import TermCalendar
from camsocs_pipeline.models.observation import IdentityHints, Observation
from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.sources.base import HostGates, PoliteClient
from camsocs_pipeline.sources.policy import ROBOTS_OVERRIDE_NOTE
from tests.test_events_sources import (  # noqa: F401  (ctx is a fixture)
    LUMA_ICS,
    NOW,
    PNG,
    WINDOW,
    allow,
    ctx,
    fields,
    fixture,
    london,
    staged,
)

GOOGLE_ICS = b"""BEGIN:VCALENDAR\r
VERSION:2.0\r
PRODID:-//Google Inc//Google Calendar 70.9054//EN\r
X-WR-CALNAME:Test Society\r
X-WR-TIMEZONE:Europe/London\r
BEGIN:VEVENT\r
DTSTART:20261020T180000Z\r
DTEND:20261020T190000Z\r
UID:abc123@google.com\r
SUMMARY:Welcome drinks\r
LOCATION:The Old Library\\, Cambridge\r
END:VEVENT\r
END:VCALENDAR\r
"""


def luma_page(slug: str, api_id: str, name: str = "Test Society") -> str:
    """A luma.com calendar page's own data, as the live pages carry it."""
    data = {
        "props": {
            "pageProps": {
                "initialData": {
                    "data": {
                        "calendar": {"api_id": api_id, "slug": slug, "name": name},
                        "upcoming": {"entries": [{"calendar": {"api_id": "cal-Other1"}}]},
                    }
                }
            }
        }
    }
    return (
        '<html><head><script id="__NEXT_DATA__" type="application/json">'
        + json.dumps(data)
        + "</script></head><body></body></html>"
    )


# --- calendar feeds (§11) ------------------------------------------------------------------


def test_feed_references_as_sites_write_them() -> None:
    # A calendar page's slug is not an id: it is resolved from its page.
    assert calendar_feeds.feed_url("luma", "caish") is None
    assert calendar_feeds.feed_url(
        "luma", "https://api.lu.ma/ics/get?entity=calendar&id=cal-AbC1"
    ) == ("https://api.lu.ma/ics/get?entity=calendar&id=cal-AbC1")
    # ?cid= carries the id base64-encoded: this is "testsoc@gmail.com".
    assert calendar_feeds.google_calendar_id("dGVzdHNvY0BnbWFpbC5jb20") == "testsoc@gmail.com"
    assert calendar_feeds.google_calendar_id("testsoc@gmail.com") == "testsoc@gmail.com"
    assert calendar_feeds.google_calendar_id("plainid12345") == "plainid12345"
    same = "https://calendar.google.com/calendar/ical/testsoc%40gmail.com/public/basic.ics"
    assert calendar_feeds.feed_url("google", "dGVzdHNvY0BnbWFpbC5jb20") == same
    assert calendar_feeds.feed_url("ics", same) == same
    assert calendar_feeds.feed_kind("ics", same) == "google"
    assert calendar_feeds.feed_kind("ics", "https://ics.teamup.com/feed/x/0.ics") == "ics"


def test_a_luma_page_names_its_own_calendar_only() -> None:
    page = luma_page("caish", "cal-4TNl4yi3sVEcAO5")
    assert calendar_feeds.luma_calendar_id(page, "CAISH") == "cal-4TNl4yi3sVEcAO5"
    assert calendar_feeds.luma_calendar_id(page, "other") is None
    assert calendar_feeds.luma_calendar_id("<html>no data</html>", "caish") is None


def test_slugs_resolve_and_duplicate_references_are_read_once(
    ctx: StageContext,  # noqa: F811
    net: respx.MockRouter,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from camsocs_pipeline.events.seeds import FeedSeed

    monkeypatch.setattr(
        calendar_feeds,
        "FEED_SEEDS",
        (FeedSeed("luma", "cal-1", IdentityHints(name="Test Society"), "https://x", "d"),),
    )
    org = Observation(
        source_type="society_website",
        source_key="k",
        source_url="https://soc.example/",
        retrieved_at=NOW,
        entity_type="organisation",
        identity=IdentityHints(name="Other Society"),
        entity_key="org-other-society",
        internal={
            # One calendar linked twice: by id and base64-encoded (?cid=).
            "google_calendar_ids": ["testsoc@gmail.com", "dGVzdHNvY0BnbWFpbC5jb20"],
            "luma_calendar_ids": ["othersoc", "gonesoc"],
        },
    )
    ctx.staging.write("_resolved", "20261007T000000Z-aaaaaa", [org])
    allow(net, "https://api.lu.ma", "User-agent: *\nDisallow: /insights/\n")
    allow(net, "https://luma.com", "User-agent: Googlebot\nDisallow: /in/\n")
    allow(net, "https://calendar.google.com", "User-agent: *\nAllow: /$\nDisallow: /\n")
    net.get("https://luma.com/othersoc").respond(200, text=luma_page("othersoc", "cal-1"))
    net.get("https://luma.com/gonesoc").respond(404)
    luma = net.get(url__startswith="https://api.lu.ma/ics/get").respond(200, content=LUMA_ICS)
    google = net.get(
        "https://calendar.google.com/calendar/ical/testsoc%40gmail.com/public/basic.ics"
    ).respond(200, content=GOOGLE_ICS)

    calendar_feeds.run(ctx, window=WINDOW, now=NOW)

    # The slug resolved to the seed's calendar: one feed, both owners.
    (event,) = staged(ctx, "luma.events")
    assert luma.call_count == 1
    assert [o.identity.known_key for o in event.organisers] == ["org-other-society"]
    assert [o.identity.name for o in event.unresolved_organisers] == ["Test Society"]
    assert any("gonesoc" in n and "dropped" in n for n in ctx.report.notes)
    # Google's robots.txt disallows the feed; a society's public feed is read
    # under D3, once, and its sources row says robots.txt disallowed it.
    assert google.call_count == 1
    (drinks,) = staged(ctx, "ics_feed.events")
    assert drinks.event_source == "google_calendar"
    assert fields(drinks)["title"] == "Welcome drinks"
    assert drinks.fetch is not None and drinks.fetch.robots_verdict == "disallowed"
    assert ROBOTS_OVERRIDE_NOTE in (drinks.fetch.access_note or "")
    assert any("1 disallowed by robots.txt" in n for n in ctx.report.notes)


# --- SU profiles' own event lists (§12) ------------------------------------------------------

PROFILE = (
    '<html><body><h1>Test Society</h1><div class="mslwidget soc-event-list">'
    '<div class="msl_eventlist"><div class="event_item item1" '
    'data-msl-organisation-id="9999"><dl><dt>'
    '<a href="/events/9999/1234/"><span class="msl_event_image">'
    '<img src="/asset/Event/9999/poster.png?thumbnail_width=250" alt="" /></span></a>'
    '<a href="/events/9999/1234/" class="msl_event_name">Freshers Meet</a></dt>'
    '<dd class="msl_event_time">9th October </dd>'
    '<dd class="msl_event_location">Granta Place</dd></dl></div>'
    '<div class="event_item item2" data-msl-organisation-id="9999"><dl><dt>'
    '<a href="/events/9999/1240/" class="msl_event_name">Board Games Night</a></dt>'
    '<dd class="msl_event_time">15th October </dd>'
    '<dd class="msl_event_location">The Old Library</dd></dl></div>'
    "</div></div></body></html>"
)


def test_a_profile_list_parses_its_items() -> None:
    items = su_whatson.parse_profile_events(PROFILE, "https://su.example/organisation/x/")
    assert [(i.external_id, i.when, i.location) for i in items] == [
        ("events/9999/1234", "9th October", "Granta Place"),
        ("events/9999/1240", "15th October", "The Old Library"),
    ]
    assert su_whatson.parse_profile_events("<html><body>none</body></html>", "https://x/") == []


def test_a_profile_list_adds_its_events_and_falls_back_to_its_own_date(
    ctx: StageContext,  # noqa: F811
    net: respx.MockRouter,
) -> None:
    base = "https://www.cambridgesu.co.uk"
    profile_url = f"{base}/organisation/testsoc/"
    ctx.staging.write(
        "su_profile",
        "20261007T000000Z-aaaaaa",
        [
            Observation(
                source_type="su_profile",
                source_key="testsoc",
                source_url=profile_url,
                retrieved_at=NOW,
                entity_type="organisation",
                identity=IdentityHints(name="Test Society", su_id="9999"),
            )
        ],
    )
    allow(net, base, "User-agent: *\nDisallow: /asset/\n")
    net.get(profile_url).respond(200, text=PROFILE)
    with PoliteClient(
        user_agent="t",
        cache_dir=ctx.settings.cache_dir,
        min_interval=0,
        gates=HostGates(),
        sleep=lambda _s: None,
        now=lambda: NOW,
    ) as warm:
        warm.fetch(profile_url)  # what the su_directory stage left in the cache
    net.get(f"{base}/whatson/").respond(200, content=fixture("su_whatson.html"))
    net.get(f"{base}/events/9999/1234/").respond(200, content=fixture("su_event.html"))
    net.get(f"{base}/events/9999/1240/").respond(500)
    poster = net.get(f"{base}/asset/Event/9999/poster.png?thumbnail_width=250").respond(
        200, content=PNG, headers={"content-type": "image/png"}
    )

    su_whatson.run(ctx, window=WINDOW, now=NOW)

    events = {e.external_id: e for e in staged(ctx, "su_whatson.events")}
    # The What's On event listed on the profile too is one event.
    assert sorted(events) == ["events/9999/1234", "events/9999/1240"]
    fallback = events["events/9999/1240"]
    values = fields(fallback)
    assert values["startsAt"] == int(london(2026, 10, 15).timestamp() * 1000)
    assert values["allDay"] is True
    inferred = {f.field for f in fallback.fields if f.status == "inferred"}
    assert {"startsAt", "allDay"} <= inferred
    assert fallback.source_url == profile_url
    assert values["sourceUrl"] == f"{base}/events/9999/1240/"
    # The poster the society's profile links: /asset/ is robots-disallowed,
    # but D3 covers SU files linked from a society profile (su_asset).
    assert poster.call_count == 1
    assert fields(events["events/9999/1234"])["image"] == {
        "sourceUrl": f"{base}/asset/Event/9999/poster.png?thumbnail_width=250"
    }
    assert "image" not in values  # no page read, no poster linked


@pytest.mark.parametrize(
    ("text", "seen", "expected"),
    [
        ("15th October", date(2026, 10, 7), date(2026, 10, 15)),
        ("3rd October", date(2026, 10, 7), date(2026, 10, 3)),  # within the week's grace
        ("20th January", date(2026, 10, 7), date(2027, 1, 20)),
        # A year ago or nine-plus months ahead: an old item, ambiguous.
        ("1st October", date(2026, 10, 9), None),
        ("1st August", date(2026, 10, 9), None),
        # 2029 has no verified Full Term dates.
        ("15th October", date(2029, 10, 7), None),
        ("31st February", date(2026, 10, 7), None),
        ("TBC", date(2026, 10, 7), None),
    ],
)
def test_a_yearless_list_date(text: str, seen: date, expected: date | None) -> None:
    assert su_whatson.infer_listing_date(text, seen, TermCalendar.default()) == expected
