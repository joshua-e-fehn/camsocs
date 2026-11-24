"""Location resolution (stage `locate`, docs/locations-and-map.md §2,
source-research §23): the deterministic rules, the Nominatim and Places
clients, the resolver and the stage against mocked Convex routes.

Every venue, society and talk here is fictional or a public building; no
network is reached (respx).
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest
import respx

from camsocs_pipeline.extract.memo import LLMMemo
from camsocs_pipeline.locate import resolver as resolver_module
from camsocs_pipeline.locate.matching import (
    VenueIndex,
    clean_room,
    input_hash,
    is_online_only,
    normalise,
)
from camsocs_pipeline.locate.model import (
    CAMBRIDGE_BOUNDS,
    ItemLocationInput,
    LocateReply,
    PendingItem,
    VenueRow,
)
from camsocs_pipeline.locate.nominatim import (
    Nominatim,
    NominatimBlocked,
    NominatimUnavailable,
    parse_result,
)
from camsocs_pipeline.locate.places import (
    FIELD_MASK,
    SEARCH_URL,
    Places,
    PlacesBlocked,
    PlacesUnavailable,
)
from camsocs_pipeline.locate.resolver import (
    PROMPT_NAME,
    Budget,
    Locator,
    deterministic,
)
from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.pipeline.load import ConvexLoader
from camsocs_pipeline.pipeline.report import RunReport
from camsocs_pipeline.pipeline.state import SyncState
from camsocs_pipeline.stages import locate as stage
from camsocs_pipeline.staging.store import StagingStore
from tests.fakes import FakeLLM

NOW = datetime(2026, 11, 24, 9, 0, tzinfo=UTC)
STARTS = int(datetime(2026, 11, 26, 18, 0, tzinfo=UTC).timestamp() * 1000)
NOMINATIM = "https://nominatim.example.org"
SITE = "https://convex.example.org"
UA = "camsocs-bot/0.1 (+https://camsocs.uk/about)"

INI = VenueRow(
    key="ven-isaac-newton-institute",
    name="Isaac Newton Institute",
    aliases=["ini"],
    address="20 Clarkson Road, Cambridge CB3 0EH",
    lat=52.2106,
    lng=0.1028,
)
ADC = VenueRow(key="ven-adc-theatre", name="ADC Theatre", lat=52.2079, lng=0.1203)
UNPLACED = VenueRow(key="ven-corpus-playroom", name="Corpus Playroom")
TRINITY = VenueRow(
    key="ven-trinity-college",
    name="Trinity College",
    college_key="org-trinity",
    lat=52.207,
    lng=0.117,
)
VENUES = [INI, ADC, UNPLACED, TRINITY]


def event(key: str = "evt-quokka-quiz", **fields: Any) -> PendingItem:
    values: dict[str, Any] = {
        "kind": "event",
        "itemKey": key,
        "startsAt": STARTS,
        "title": "Quokka Quiz",
        "organisers": ["Quokka Society"],
        "sourceType": "ics",
    }
    values.update(fields)
    return PendingItem.model_validate(values)


def talk(key: str = "talk-on-burrows", **fields: Any) -> PendingItem:
    values: dict[str, Any] = {
        "kind": "talk",
        "itemKey": key,
        "startsAt": STARTS,
        "title": "On burrows",
        "organisers": ["Department of Zoology"],
        "sourceType": "talks_cam",
        "online": False,
    }
    values.update(fields)
    return PendingItem.model_validate(values)


def osm(name: str, lat: float = 52.2, lng: float = 0.12, osm_id: int = 42) -> dict[str, Any]:
    return {
        "osm_type": "way",
        "osm_id": osm_id,
        "lat": str(lat),
        "lon": str(lng),
        "name": name,
        "address": {
            "house_number": "1",
            "road": "Burrow Lane",
            "city": "Cambridge",
            "postcode": "CB2 1AB",
        },
    }


def nominatim_query(request: httpx.Request) -> str:
    """A free-text search's `q`, or "street=…|postalcode=…" for a structured one."""
    params = request.url.params
    if "q" in params:
        return params["q"]
    return "|".join(
        f"{key}={params[key]}" for key in ("street", "city", "postalcode") if key in params
    )


def nominatim() -> Nominatim:
    return Nominatim(user_agent=UA, base_url=NOMINATIM, sleep=lambda _s: None)


def mock_nominatim(net: respx.MockRouter, answers: dict[str, list[dict[str, Any]]]) -> respx.Route:
    def answer(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=answers.get(nominatim_query(request), []))

    return net.get(f"{NOMINATIM}/search").mock(side_effect=answer)


def locator(tmp_path, llm=None, **kwargs: Any) -> Locator:
    return Locator(
        kwargs.pop("venues", VENUES),
        memo=LLMMemo(tmp_path / "llm"),
        llm=llm,
        nominatim=kwargs.pop("nominatim", nominatim()),
        places=kwargs.pop("places", None),
        now=NOW,
        workers=1,
        **kwargs,
    )


# --- matching -----------------------------------------------------------------------------------


def test_names_are_normalised_for_matching() -> None:
    assert normalise("St John's College, Cambridge") == "st johns college"
    assert normalise("Clare & Gonville, CB2 1TL") == "clare and gonville"
    assert normalise("Café Rouge") == "cafe rouge"


@pytest.mark.parametrize(
    "text, online",
    [
        ("Zoom", True),
        ("Online", True),
        ("Online (link sent on registration)", True),
        ("https://us02web.zoom.us/j/123456", True),
        ("MS Teams", True),
        ("Hybrid: Seminar Room 1 and Zoom", False),
        ("Seminar Room 1, Isaac Newton Institute", False),
        ("Lecture Theatre 1 or online", False),
        ("", False),
    ],
)
def test_only_an_online_place_is_online(text: str, online: bool) -> None:
    assert is_online_only(text) is online


def test_a_venue_text_names_a_known_venue_and_the_room_it_adds() -> None:
    index = VenueIndex.of(VENUES)
    assert index.match("Isaac Newton Institute") == (INI, None)
    assert index.match("INI") == (INI, None)
    assert index.match("Seminar Room 1, Isaac Newton Institute") == (INI, "Seminar Room 1")
    assert index.match("Isaac Newton Institute, Seminar Room 2") == (INI, "Seminar Room 2")
    assert index.match("Isaac Newton Institute, Cambridge CB3 0EH") == (INI, None)
    assert index.match("Somewhere else entirely") is None


def test_a_name_two_venues_share_matches_neither() -> None:
    twin = VenueRow(key="ven-adc-annexe", name="ADC Annexe", aliases=["adc theatre"])
    assert VenueIndex.of([ADC, twin]).match("ADC Theatre") is None


def test_a_room_is_never_a_person_a_link_or_the_venue_itself() -> None:
    assert clean_room("Seminar Room 1", "INI") == "Seminar Room 1"
    assert clean_room("Dr Quokka's office", "INI") is None
    assert clean_room("https://example.org/room", "INI") is None
    assert clean_room("Isaac Newton Institute", "Isaac Newton Institute") is None
    assert clean_room("x" * 300, "INI") is not None and len(clean_room("x" * 300, "INI")) == 120


def test_the_shortlist_puts_overlap_first_and_always_has_the_colleges() -> None:
    others = [VenueRow(key=f"ven-hall-{n}", name=f"Hall {n}") for n in range(100)]
    index = VenueIndex.of([*VENUES, *others])
    shortlist = index.shortlist(event(venueText="Newton Hall"), size=10)
    assert shortlist[0] == INI
    assert TRINITY in shortlist
    assert len(shortlist) == 10


def test_the_input_hash_changes_with_what_is_read_and_fits_the_server() -> None:
    first = input_hash(event(venueText="ADC"), PROMPT_NAME)
    assert first.startswith("locate_v2:") and len(first) <= 128
    assert first == input_hash(event(venueText="ADC"), PROMPT_NAME)
    assert first != input_hash(event(venueText="ADC Theatre"), PROMPT_NAME)
    assert first != input_hash(event(venueText="ADC"), "locate_v1")
    # The organisers' usual places count only when the item names no venue,
    # and in any order.
    assert first == input_hash(event(venueText="ADC", organiserPlaces=["Quokka Hall"]), PROMPT_NAME)
    bare = input_hash(event(), PROMPT_NAME)
    hinted = input_hash(event(organiserPlaces=["Quokka Hall", "Burrow Court"]), PROMPT_NAME)
    assert bare != hinted
    assert hinted == input_hash(event(organiserPlaces=["Burrow Court", "Quokka Hall"]), PROMPT_NAME)
    assert input_hash(event(venueKey=ADC.key), PROMPT_NAME) == input_hash(
        event(venueKey=ADC.key, organiserPlaces=["Quokka Hall"]), PROMPT_NAME
    )


# --- deterministic rules ------------------------------------------------------------------------


def test_the_rules_place_online_own_venues_and_aliases() -> None:
    index = VenueIndex.of(VENUES)
    online = deterministic(talk(online=True, venue="Zoom"), index)
    assert online is not None and online.reply.decision == "online"
    assert deterministic(talk(online=True), index).reply.decision == "online"  # type: ignore[union-attr]
    hybrid = deterministic(talk(online=True, venue="Seminar Room 1, INI"), index)
    assert hybrid is not None and hybrid.method == "alias" and hybrid.reply.venue_key == INI.key
    own = deterministic(event(venueKey=ADC.key, venueText="Larkum Studio, ADC Theatre"), index)
    assert own is not None and own.method == "source"
    assert (own.reply.venue_key, own.reply.room) == (ADC.key, "Larkum Studio")
    alias = deterministic(event(venueText="Seminar Room 1, Isaac Newton Institute"), index)
    assert alias is not None and alias.method == "alias" and alias.reply.room == "Seminar Room 1"
    assert deterministic(event(venueText="The Burrow"), index) is None


# --- Nominatim ------------------------------------------------------------------------------------


def test_nominatim_searches_cambridge_politely_and_reads_the_address(net: respx.MockRouter) -> None:
    route = mock_nominatim(net, {"The Burrow, Cambridge": [osm("The Burrow")]})
    waits: list[float] = []
    ticks = iter([0.0, 0.2, 1.2])
    client = Nominatim(
        user_agent=UA, base_url=NOMINATIM, clock=lambda: next(ticks), sleep=waits.append
    )
    place = client.find(["The Burrow", "The Burrow, Cambridge"])
    assert place is not None and place.url == "https://www.openstreetmap.org/way/42"
    assert place.address == "1 Burrow Lane, Cambridge CB2 1AB"
    assert client.calls == 2 and waits == [pytest.approx(0.8)]
    request = route.calls.last.request
    assert request.headers["User-Agent"] == UA
    params = request.url.params
    assert params["format"] == "jsonv2" and params["bounded"] == "1"
    assert params["viewbox"] == "0.03,52.26,0.22,52.15"
    # The same query again is answered from the run's cache.
    assert client.search("The Burrow, Cambridge") == place and client.calls == 2


def test_nominatim_refuses_a_result_outside_cambridge(net: respx.MockRouter) -> None:
    mock_nominatim(net, {"The Burrow": [osm("The Burrow", lat=51.5, lng=-0.12)]})
    assert nominatim().search("The Burrow") is None
    assert not CAMBRIDGE_BOUNDS.contains(51.5, -0.12)


def test_nominatim_stops_when_refused(net: respx.MockRouter) -> None:
    net.get(f"{NOMINATIM}/search").respond(429)
    client = nominatim()
    with pytest.raises(NominatimBlocked):
        client.search("The Burrow")
    with pytest.raises(NominatimBlocked):
        client.search("Another")
    assert client.calls == 1


@pytest.mark.parametrize(
    "answer",
    [
        httpx.Response(503),
        httpx.Response(200, text="<html>busy</html>"),
        httpx.ConnectError("down"),
    ],
)
def test_nominatim_without_an_answer_is_no_answer_and_is_not_cached(
    net: respx.MockRouter, answer: httpx.Response | Exception
) -> None:
    route = net.get(f"{NOMINATIM}/search")
    route.side_effect = [answer, httpx.Response(200, json=[osm("The Burrow")])]
    client = nominatim()
    with pytest.raises(NominatimUnavailable):
        client.search("The Burrow")
    assert not client.blocked and client.errors == 1
    # Not remembered as "nothing found": asked again, and answered.
    assert client.search("The Burrow") is not None and client.calls == 2


def test_a_malformed_result_is_ignored() -> None:
    assert parse_result({"osm_type": "way"}) is None
    assert parse_result({"osm_type": "area", "osm_id": 1, "lat": "52", "lon": "0.1"}) is None


# --- Places ---------------------------------------------------------------------------------


def test_places_asks_for_ids_only_inside_cambridge(net: respx.MockRouter) -> None:
    route = net.post(SEARCH_URL).respond(200, json={"places": [{"id": "ChIJabcdefghijk"}]})
    client = Places(api_key="test-places-key", user_agent=UA)
    assert client.place_id("The Burrow, Cambridge") == "ChIJabcdefghijk"
    request = route.calls.last.request
    assert request.headers["X-Goog-FieldMask"] == FIELD_MASK == "places.id"
    assert request.headers["X-Goog-Api-Key"] == "test-places-key"
    assert "test-places-key" not in str(request.url) and "key" not in repr(client)
    body = json.loads(request.content)
    assert body["textQuery"] == "The Burrow, Cambridge"
    assert body["locationRestriction"]["rectangle"] == {
        "low": {"latitude": 52.15, "longitude": 0.03},
        "high": {"latitude": 52.26, "longitude": 0.22},
    }


def test_places_stops_on_a_refused_key(net: respx.MockRouter) -> None:
    net.post(SEARCH_URL).respond(403)
    client = Places(api_key="k", user_agent=UA)
    with pytest.raises(PlacesBlocked):
        client.place_id("x")
    with pytest.raises(PlacesBlocked):
        client.place_id("y")
    assert client.calls == 1


@pytest.mark.parametrize("answer", [httpx.Response(500), httpx.ReadTimeout("slow")])
def test_places_without_an_answer_is_no_answer(
    net: respx.MockRouter, answer: httpx.Response | Exception
) -> None:
    net.post(SEARCH_URL).mock(side_effect=[answer])
    client = Places(api_key="k", user_agent=UA)
    with pytest.raises(PlacesUnavailable):
        client.place_id("x")
    assert not client.blocked and client.errors == 1


def test_places_ignores_an_id_the_server_would_refuse(net: respx.MockRouter) -> None:
    net.post(SEARCH_URL).respond(200, json={"places": [{"id": "bad id!"}]})
    assert Places(api_key="k", user_agent=UA).place_id("x") is None


# --- the resolver -----------------------------------------------------------------------------


def reply(**fields: Any):
    return lambda _text, _tier: fields


def test_a_new_venue_is_found_on_osm_and_posted_with_osm_values_only(
    tmp_path, net: respx.MockRouter
) -> None:
    mock_nominatim(
        net,
        {"Burrow Hall, Quokka Road, Cambridge": [osm("Burrow Lecture Hall")]},
    )
    fake = FakeLLM(
        reply(
            decision="new",
            new_venue={
                "name": "Burrow Hall",
                "address": "Quokka Road, Cambridge",
                "osm_query": "Burrow Hall, Quokka Road, Cambridge",
            },
            room="Room 2",
            precision="exact",
        )
    )
    run = locator(tmp_path, fake)
    item = event(venueText="room 2 at the burrow, ask Sam for the key")
    [row] = run.resolve([item])
    assert row.precision == "exact" and row.venue_key == "ven-burrow-lecture-hall"
    assert (row.room, row.method, row.model, row.prompt_version) == (
        "Room 2",
        "llm",
        "bulk-model-1",
        "locate_v2",
    )
    assert row.input_hash == input_hash(item, PROMPT_NAME)
    claims = {c.field: c for c in run.venue_claims()}
    assert set(claims) == {"name", "address", "lat", "lng"}
    # OpenStreetMap's own name and address, never the model's wording (D1, §1a).
    assert claims["name"].value == "Burrow Lecture Hall"
    assert claims["address"].value == "1 Burrow Lane, Cambridge CB2 1AB"
    assert {c.source_type for c in claims.values()} == {"osm_nominatim"}
    assert claims["lat"].source_url == "https://www.openstreetmap.org/way/42"
    assert all("Sam" not in json.dumps(c.to_wire()) for c in claims.values())
    assert all("Quokka Road" not in json.dumps(c.to_wire()) for c in claims.values())
    # The prompt showed the item and the shortlist.
    assert "Venue as listed: room 2 at the burrow" in fake.calls[0]["text"]
    assert "ven-trinity-college: Trinity College" in fake.calls[0]["text"]


def test_an_osm_place_with_a_persons_name_is_no_venue(tmp_path, net: respx.MockRouter) -> None:
    mock_nominatim(net, {"Dr Quokka's rooms, Cambridge": [osm("Dr Quokka's rooms")]})
    fake = FakeLLM(reply(decision="new", new_venue={"name": "Dr Quokka's rooms"}))
    run = locator(tmp_path, fake)
    [row] = run.resolve([event("evt-a", venueText="the rooms")])
    assert row.precision == "unknown"
    assert run.venue_claims() == []


def test_osm_without_an_answer_defers_every_item_naming_the_venue(
    tmp_path, net: respx.MockRouter
) -> None:
    route = net.get(f"{NOMINATIM}/search").respond(503)
    fake = FakeLLM(reply(decision="new", new_venue={"name": "Burrow Hall"}))
    run = locator(tmp_path, fake)
    assert run.resolve([event("evt-a"), event("evt-b")]) == []
    assert run.metrics.deferred == 2 and run.metrics.unknown == 0
    assert route.call_count == 2, "an unanswered venue is not remembered as not found"
    assert any("did not answer" in note for note in run.notes)


def test_an_unplaced_venue_is_looked_up_again_after_an_outage(
    tmp_path, net: respx.MockRouter
) -> None:
    route = net.get(f"{NOMINATIM}/search")
    route.side_effect = [
        httpx.ConnectError("down"),
        httpx.Response(200, json=[osm("Corpus Playroom")]),
    ]
    run = locator(tmp_path)
    rows = run.resolve(
        [event("evt-a", venueKey=UNPLACED.key), event("evt-b", venueKey=UNPLACED.key)]
    )
    # The first got no answer and waits for the next run (no row); the second
    # asked again and placed the venue.
    assert [(r.item_key, r.venue_key) for r in rows] == [("evt-b", UNPLACED.key)]
    assert run.metrics.deferred == 1 and route.call_count == 2
    assert {c.field for c in run.venue_claims()} >= {"lat", "lng"}


def test_a_venue_osm_does_not_know_falls_back_to_its_parent(
    tmp_path, net: respx.MockRouter
) -> None:
    mock_nominatim(net, {"Trinity College, Cambridge": [osm("Trinity College")]})
    fake = FakeLLM(
        reply(
            decision="new",
            new_venue={"name": "Old Burrow Room", "osm_query": "Old Burrow Room"},
            parent={"name": "Trinity College"},
            precision="exact",
        )
    )
    [row] = locator(tmp_path, fake).resolve([talk(venue="Old Burrow Room")])
    assert (row.precision, row.venue_key, row.room) == ("building", TRINITY.key, "Old Burrow Room")


def test_a_key_picked_off_the_list_gives_way_to_the_parent(tmp_path, net: respx.MockRouter) -> None:
    cms = osm("Centre for Mathematical Sciences", osm_id=7)
    mock_nominatim(net, {"Centre for Mathematical Sciences, Cambridge": [cms]})
    fake = FakeLLM(
        reply(
            decision="existing",
            venue_key=ADC.key,
            parent={"name": "Centre for Mathematical Sciences"},
            room="MR15",
        )
    )
    [row] = locator(tmp_path, fake).resolve([event(venueText="MR15, CMS")])
    assert (row.venue_key, row.room) == ("ven-centre-for-mathematical-sciences", "MR15")
    # A known venue the place text names is kept, parent or not.
    trusted = FakeLLM(
        reply(decision="existing", venue_key=ADC.key, parent={"name": "Somewhere Else"})
    )
    [row] = locator(tmp_path / "b", trusted).resolve([event("evt-b", venueText="ADC bar")])
    assert row.venue_key == ADC.key


def test_a_room_named_as_a_new_venue_becomes_its_building(tmp_path, net: respx.MockRouter) -> None:
    route = mock_nominatim(net, {})
    fake = FakeLLM(
        reply(
            decision="new",
            new_venue={"name": "Old Burrow Room, Trinity College"},
            parent={"name": "Trinity College"},
            room="Old Burrow Room",
        )
    )
    [row] = locator(tmp_path, fake).resolve([event(venueText="Old Burrow Room, Trinity")])
    assert (row.precision, row.venue_key, row.room) == ("exact", TRINITY.key, "Old Burrow Room")
    assert not route.called


def test_part_of_the_venue_name_is_no_room() -> None:
    assert clean_room("Hall", "Fitzpatrick Hall") is None
    assert clean_room("Hall", "Trinity College") == "Hall"
    assert clean_room("Room 2", "Fitzpatrick Hall") == "Room 2"


def test_nothing_found_is_unknown_with_a_note(tmp_path, net: respx.MockRouter) -> None:
    mock_nominatim(net, {})
    fake = FakeLLM(reply(decision="new", new_venue={"name": "The Lost Burrow"}))
    [row] = locator(tmp_path, fake).resolve([event(venueText="The Lost Burrow")])
    assert row.precision == "unknown" and row.venue_key is None
    assert row.note == "not found on OpenStreetMap or by postcode: The Lost Burrow"
    unknown = FakeLLM(reply(decision="unknown", note="no venue and no host"))
    [row] = locator(tmp_path / "b", unknown).resolve([event("evt-b")])
    assert (row.precision, row.note) == ("unknown", "no venue and no host")


def test_an_area_without_an_anchor_is_central_cambridge(tmp_path, net: respx.MockRouter) -> None:
    mock_nominatim(net, {"Market Square, Cambridge": [osm("Market Square")]})
    fake = FakeLLM(
        reply(decision="new", precision="area", area_label="Central Cambridge (sent to attendees)")
    )
    [row] = locator(tmp_path, fake).resolve([event(description="Location sent on acceptance")])
    assert row.precision == "area" and row.venue_key == "ven-market-square"
    assert row.area_label == "Central Cambridge (sent to attendees)" and row.room is None


def test_a_known_venue_without_coordinates_is_looked_up_once(
    tmp_path, net: respx.MockRouter
) -> None:
    route = mock_nominatim(net, {"Corpus Playroom, Cambridge": [osm("Corpus Playroom")]})
    run = locator(tmp_path)
    rows = run.resolve(
        [event("evt-a", venueKey=UNPLACED.key), event("evt-b", venueKey=UNPLACED.key)]
    )
    assert [r.venue_key for r in rows] == [UNPLACED.key] * 2
    assert route.call_count == 1
    assert {c.field for c in run.venue_claims()} == {"lat", "lng", "address"}


def test_replies_are_cached_and_a_dry_run_uses_only_the_cache(
    tmp_path, net: respx.MockRouter
) -> None:
    fake = FakeLLM(reply(decision="existing", venue_key=TRINITY.key, precision="building"))
    item = event(organisers=["Trinity Quokka Society"])
    locator(tmp_path, fake).resolve([item])
    assert len(fake.calls) == 1
    # Without a model (a dry run): the cached reply, no request.
    dry = locator(tmp_path, None, nominatim=None)
    [row] = dry.resolve([item])
    assert (row.precision, row.venue_key, row.method) == ("building", TRINITY.key, "llm")
    assert dry.metrics.llm_cache_hits == 1 and dry.metrics.llm_calls == 0
    # An item no reply is cached for waits for a real run.
    assert dry.resolve([event("evt-other")]) == [] and dry.metrics.deferred == 1


def test_budgets_leave_items_for_the_next_run(tmp_path, net: respx.MockRouter) -> None:
    mock_nominatim(net, {"Burrow Hall, Cambridge": [osm("Burrow Hall")]})
    fake = FakeLLM(reply(decision="new", new_venue={"name": "Burrow Hall"}))
    run = locator(tmp_path, fake, budget=Budget(llm_items=1))
    rows = run.resolve([event("evt-a"), event("evt-b")])
    assert len(rows) == 1 and run.metrics.deferred == 1
    assert any("model budget" in note for note in run.notes)
    no_geocoding = locator(tmp_path / "b", fake, budget=Budget(nominatim_calls=0))
    assert no_geocoding.resolve([event("evt-c")]) == []
    assert no_geocoding.metrics.deferred == 1


def test_a_model_error_defers_the_item(tmp_path) -> None:
    fake = FakeLLM(lambda _t, _tier: RuntimeError("down"))
    run = locator(tmp_path, fake)
    assert run.resolve([event()]) == [] and run.metrics.llm_errors == 1


def test_place_ids_for_new_and_known_venues_within_the_budget(
    tmp_path, net: respx.MockRouter
) -> None:
    net.post(SEARCH_URL).respond(200, json={"places": [{"id": "ChIJabcdefghijk"}]})
    tried: dict[str, str] = {TRINITY.key: "2026-11-20"}
    run = locator(
        tmp_path,
        places=Places(api_key="k", user_agent=UA),
        places_tried=tried,
        budget=Budget(places_calls=2),
    )
    run.resolve([event(venueKey=ADC.key)])
    run.place_ids()
    claims = [c for c in run.venue_claims() if c.field == "googlePlaceId"]
    # ADC first (this run used it), then the next due; Trinity was tried 4 days ago.
    assert [c.entity_key for c in claims] == [ADC.key, UNPLACED.key]
    assert claims[0].source_type == "google_places"
    assert claims[0].source_url == "https://www.google.com/maps/place/?q=place_id:ChIJabcdefghijk"
    assert tried[ADC.key] == "2026-11-24"


def test_a_place_id_without_an_answer_is_asked_again_next_run(
    tmp_path, net: respx.MockRouter
) -> None:
    net.post(SEARCH_URL).respond(503)
    tried: dict[str, str] = {}
    run = locator(
        tmp_path,
        places=Places(api_key="k", user_agent=UA),
        places_tried=tried,
        budget=Budget(places_calls=2),
    )
    run.place_ids()
    assert tried == {} and run.venue_claims() == []
    assert any("did not answer for 2 venues" in note for note in run.notes)


def test_a_rescheduled_item_is_due_again() -> None:
    item = event()
    stored = {"inputHash": input_hash(item, PROMPT_NAME), "precision": "exact"}
    same = PendingItem.model_validate({**wire(item), "stored": {**stored, "startsAt": STARTS}})
    moved = PendingItem.model_validate(
        {**wire(item), "stored": {**stored, "startsAt": STARTS - 7 * 86_400_000}}
    )
    older = PendingItem.model_validate({**wire(item), "stored": stored})
    assert stage.due([same, moved, older]) == ([moved], 2)


# --- the stage ------------------------------------------------------------------------------------


def convex(net: respx.MockRouter, items: list[dict[str, Any]], venues: list[dict[str, Any]]):
    base = f"{SITE}/api/pipeline"
    return {
        "pending": net.post(f"{base}/locations/pending").respond(
            200, json={"page": items, "continueCursor": "x", "isDone": True}
        ),
        "venues": net.post(f"{base}/venues/all").respond(
            200, json={"page": venues, "continueCursor": "y", "isDone": True}
        ),
        "claims": net.post(f"{base}/claims").respond(
            200, json={"inserted": 0, "updated": 0, "unchanged": 0, "rejected": []}
        ),
        "batch": net.post(f"{base}/locations/batch").respond(
            200,
            json={
                "inserted": 1,
                "updated": 0,
                "unchanged": 0,
                "rejected": [{"itemKey": "evt-b", "reason": "no event with this key"}],
            },
        ),
        "summary": net.post(f"{base}/locations/summary").respond(
            200, json={"upcoming": 40, "resolved": 38, "unknown": 2, "unresolvedShare": 0.05}
        ),
    }


def context(make_settings, tmp_path, *, dry_run: bool = False, limit: int | None = None):
    settings = make_settings()
    run = RunReport(run_key="20261124T090000Z-abcdef", command="sync", dry_run=dry_run)
    return StageContext(
        settings=settings,
        report=run.stage("locate"),
        run=run,
        loader=ConvexLoader(SITE, "test-key", dry_run=dry_run),
        state=SyncState(),
        staging=StagingStore(tmp_path / "staging"),
        dry_run=dry_run,
        limit=limit,
    )


def wire(item: PendingItem) -> dict[str, Any]:
    return item.model_dump(by_alias=True, exclude_none=True)


def test_the_stage_reads_convex_resolves_and_posts(
    make_settings, tmp_path, net: respx.MockRouter, monkeypatch: pytest.MonkeyPatch
) -> None:
    done = event("evt-done", venueText="ADC Theatre")
    stored = {"inputHash": input_hash(done, PROMPT_NAME), "precision": "exact"}
    items = [
        {**wire(done), "stored": stored},
        wire(event("evt-a", venueText="Seminar Room 1, Isaac Newton Institute")),
        wire(talk(online=True)),
        wire(event("evt-b", venueText="Somewhere")),
    ]
    routes = convex(net, items, [v.model_dump(by_alias=True, exclude_none=True) for v in VENUES])
    fake = FakeLLM(reply(decision="unknown", note="no venue and no host"))
    monkeypatch.setattr(stage, "LLMClient", lambda _settings: fake)
    monkeypatch.setattr(type(make_settings()), "require_llm", lambda _self: None)
    ctx = context(make_settings, tmp_path)

    stage.run(ctx, now=NOW)

    pending = json.loads(routes["pending"].calls.last.request.content)
    assert pending["to"] - pending["from"] == 121 * 86_400_000
    rows = json.loads(routes["batch"].calls.last.request.content)["locations"]
    assert [(r["itemKey"], r["precision"], r["method"]) for r in rows] == [
        ("evt-a", "exact", "alias"),
        ("talk-on-burrows", "online", "source"),
        ("evt-b", "unknown", "llm"),
    ]
    assert rows[0]["room"] == "Seminar Room 1" and rows[0]["venueKey"] == INI.key
    assert not routes["claims"].called, "no venue was new"
    metrics = ctx.report.metrics
    assert (metrics["pending"], metrics["resolved"], metrics["unknown"]) == (4, 2, 1)
    assert (metrics["llmCalls"], metrics["placesCalls"], metrics["unresolvedShare"]) == (1, 0, 0.05)
    notes = "\n".join(ctx.report.notes)
    assert "GOOGLE_PLACES_API_KEY is not set" in notes
    assert "1 rows refused (evt-b: no event with this key)" in notes
    assert "above the 2% target" in notes
    assert ctx.report.unchanged == 1 and ctx.report.inserted == 1


def test_a_dry_run_reads_nothing_and_posts_nothing(
    make_settings, tmp_path, net: respx.MockRouter, llm_tripwire: list[str]
) -> None:
    routes = convex(net, [wire(event())], [])
    ctx = context(make_settings, tmp_path, dry_run=True)
    stage.run(ctx, now=NOW)
    assert not any(route.called for route in routes.values())
    assert llm_tripwire == []
    assert "dry run" in ctx.report.notes[0]


def test_the_limit_caps_the_items_resolved(
    make_settings, tmp_path, net: respx.MockRouter, monkeypatch: pytest.MonkeyPatch
) -> None:
    items = [wire(talk(f"talk-{n}", online=True)) for n in range(5)]
    routes = convex(net, items, [])
    monkeypatch.setattr(type(make_settings()), "require_llm", lambda _self: None)
    monkeypatch.setattr(stage, "LLMClient", lambda _settings: FakeLLM(reply(decision="online")))
    stage.run(context(make_settings, tmp_path, limit=2), now=NOW)
    assert len(json.loads(routes["batch"].calls.last.request.content)["locations"]) == 2


def test_a_row_round_trips_the_wire() -> None:
    row = ItemLocationInput(
        kind="event",
        item_key="evt-a",
        starts_at=STARTS,
        precision="online",
        method="source",
        input_hash="locate_v1:abc",
    )
    assert row.to_wire() == {
        "kind": "event",
        "itemKey": "evt-a",
        "startsAt": STARTS,
        "precision": "online",
        "method": "source",
        "inputHash": "locate_v1:abc",
    }
    assert LocateReply.model_validate({"decision": "online"}).precision == "online"
    assert LocateReply.model_validate({}).decision == "unknown"


def test_the_prompt_names_its_placeholders() -> None:
    text = resolver_module.PROMPT_PATH.read_text(encoding="utf-8")
    assert "$venues" in text and "$item" in text
    assert resolver_module.PROMPT_PATH.name == f"{PROMPT_NAME}.md" == "locate_v2.md"


# --- settings ----------------------------------------------------------------------------------


def test_the_places_key_is_optional_and_never_printed(make_settings) -> None:
    from click.testing import CliRunner

    from camsocs_pipeline.cli import cli

    assert not make_settings().places_configured
    assert not make_settings(google_places_api_key="   ").places_configured
    settings = make_settings(google_places_api_key="test-places-secret")
    assert settings.places_configured
    result = CliRunner().invoke(cli, ["status"], obj={"settings": settings})
    assert result.exit_code == 0, result.output
    assert "test-places-secret" not in result.output
    assert "Places key: " in result.output and "set (locate: place ids only)" in result.output
    assert "https://nominatim.openstreetmap.org (1s apart)" in result.output
