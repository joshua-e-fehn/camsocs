"""Location coverage (prompt `locate_v2`, docs/locations-and-map.md §2,
source-research §23): the lenient reply, the building always named, the
geocoding chain (Nominatim in and around Cambridge, worldwide for a place
outside it, Photon, Nominatim's structured search, postcodes.io), the
model's building name and the organisers' usual places.

Every venue, society and talk here is fictional or a public building; no
network is reached (respx).
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest
import respx

from camsocs_pipeline.extract.llm import LLMValidationError
from camsocs_pipeline.locate.geocode import GeoBudget, GeocodeDeferred, Geocoder, country_code
from camsocs_pipeline.locate.model import Building, LocateReply
from camsocs_pipeline.locate.nominatim import level_of, parse_result
from camsocs_pipeline.locate.photon import Photon, PhotonUnavailable, parse_feature
from camsocs_pipeline.locate.postcodes import Postcodes, PostcodesUnavailable, find_postcode
from camsocs_pipeline.locate.resolver import (
    Budget,
    model_building_address,
    model_building_name,
)
from tests.fakes import FakeLLM
from tests.test_locate import (
    ADC,
    INI,
    NOMINATIM,
    TRINITY,
    UA,
    event,
    locator,
    mock_nominatim,
    nominatim,
    nominatim_query,
    osm,
    reply,
    talk,
)
from tests.test_locate import (
    VENUES as VENUES_,
)

PHOTON = "https://photon.example.org"
POSTCODES = "https://postcodes.example.org"


def photon() -> Photon:
    return Photon(user_agent=UA, base_url=PHOTON, sleep=lambda _s: None)


def postcodes() -> Postcodes:
    return Postcodes(user_agent=UA, base_url=POSTCODES, sleep=lambda _s: None)


def feature(name: str, lat: float, lng: float, *, key: str = "building", value: str = "yes"):
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [lng, lat]},
        "properties": {
            "osm_type": "W",
            "osm_id": 77,
            "osm_key": key,
            "osm_value": value,
            "name": name,
            "street": "Madingley Road",
            "housenumber": "19",
            "city": "Cambridge",
            "postcode": "CB3 0HA",
            "countrycode": "GB",
        },
    }


def mock_photon(net: respx.MockRouter, answers: dict[str, list[dict[str, Any]]]) -> respx.Route:
    def answer(request: httpx.Request) -> httpx.Response:
        found = answers.get(request.url.params["q"], [])
        return httpx.Response(200, json={"type": "FeatureCollection", "features": found})

    return net.get(f"{PHOTON}/api").mock(side_effect=answer)


def mock_postcodes(net: respx.MockRouter, points: dict[str, tuple[float, float]]) -> respx.Route:
    def answer(request: httpx.Request) -> httpx.Response:
        code = request.url.path.rsplit("/", 1)[-1].replace("%20", " ")
        if code not in points:
            return httpx.Response(404, json={"status": 404, "error": "Postcode not found"})
        lat, lng = points[code]
        return httpx.Response(
            200,
            json={
                "status": 200,
                "result": {
                    "postcode": code,
                    "latitude": lat,
                    "longitude": lng,
                    "admin_district": "Cambridge",
                },
            },
        )

    return net.get(url__startswith=f"{POSTCODES}/postcodes/").mock(side_effect=answer)


def chain(tmp_path, fake, **kwargs: Any):
    return locator(
        tmp_path,
        fake,
        photon=kwargs.pop("photon", photon()),
        postcodes=kwargs.pop("postcodes", postcodes()),
        **kwargs,
    )


# --- the reply ---------------------------------------------------------------------------------


def test_the_reply_reads_what_a_model_writes_rather_than_failing() -> None:
    lenient = LocateReply.model_validate(
        {
            "precision": "Building",
            "building": "Trinity College",
            "venueKey": "",
            "areaLabel": "  ",
            "outsideCambridge": "yes",
            "room": 12,
            "unexpected": {"x": 1},
        }
    )
    assert lenient.precision == "building" and lenient.venue_key is None
    assert lenient.building == Building(name="Trinity College")
    assert lenient.outside_cambridge is True and lenient.room is None
    assert lenient.area_label is None and lenient.decision == "new"
    assert LocateReply.model_validate({"precision": "somewhere"}).precision is None
    assert LocateReply.model_validate({"decision": "unknown"}).decision == "unknown"
    # v1's shape is still read.
    v1 = LocateReply.model_validate(
        {"decision": "new", "new_venue": {"name": "X Hall", "osmQuery": "X Hall, Cambridge"}}
    )
    assert v1.building is not None and v1.building.osm_query == "X Hall, Cambridge"
    assert v1.decision == "new"
    assert LocateReply.model_validate({"venue_key": ADC.key}).decision == "existing"


def test_an_invalid_key_never_drops_the_item(tmp_path, net: respx.MockRouter) -> None:
    cms = osm("Centre for Mathematical Sciences", osm_id=7)
    mock_nominatim(net, {"Centre for Mathematical Sciences, Wilberforce Road, Cambridge": [cms]})
    fake = FakeLLM(
        reply(
            precision="exact",
            venue_key="ven-cms-not-listed",
            building={
                "name": "Centre for Mathematical Sciences",
                "address": "Wilberforce Road, Cambridge CB3 0WA",
                "osm_query": "Centre for Mathematical Sciences, Wilberforce Road, Cambridge",
                "country": "GB",
            },
            room="MR12",
        )
    )
    [row] = chain(tmp_path, fake).resolve([talk(venue="MR12, Centre for Mathematical Sciences")])
    assert (row.precision, row.venue_key, row.room) == (
        "exact",
        "ven-centre-for-mathematical-sciences",
        "MR12",
    )


def test_a_listed_key_or_a_known_name_needs_no_lookup(tmp_path, net: respx.MockRouter) -> None:
    route = mock_nominatim(net, {})
    by_key = FakeLLM(
        reply(
            precision="exact",
            venue_key=INI.key,
            building={"name": "Isaac Newton Institute", "address": "20 Clarkson Road CB3 0EH"},
            room="Seminar Room 1",
        )
    )
    [row] = chain(tmp_path, by_key).resolve([talk(venue="Seminar Room 1, Newton Institute")])
    assert (row.venue_key, row.room) == (INI.key, "Seminar Room 1")
    # No key, but the building is a known venue by name.
    by_name = FakeLLM(reply(precision="building", building={"name": "Trinity College"}))
    [row] = chain(tmp_path / "b", by_name).resolve([event("evt-b")])
    assert (row.precision, row.venue_key) == ("building", TRINITY.key)
    assert not route.called


def test_the_organisers_usual_places_are_shown_to_the_model(
    tmp_path, net: respx.MockRouter
) -> None:
    fake = FakeLLM(reply(precision="building", venue_key=TRINITY.key, building="Trinity College"))
    item = event(
        title="Swim & Coffee",
        organisers=["Quokka Swimming Club"],
        organiserPlaces=["Trinity College", "Parkside Pools"],
    )
    [row] = chain(tmp_path, fake).resolve([item])
    assert "Organiser's usual places: Trinity College; Parkside Pools" in fake.calls[0]["text"]
    assert row.precision == "building" and row.venue_key == TRINITY.key
    bare = FakeLLM(reply(precision="unknown", note="no venue and no host"))
    chain(tmp_path / "b", bare).resolve([event("evt-c")])
    assert "Organiser's usual places: (not known)" in bare.calls[0]["text"]


def test_a_reply_that_fails_validation_is_asked_once_of_the_strong_model(tmp_path) -> None:
    fake = FakeLLM(
        lambda _text, tier: (
            LLMValidationError("did not validate")
            if tier == "bulk"
            else {"precision": "building", "venue_key": TRINITY.key}
        )
    )
    [row] = chain(tmp_path, fake).resolve([event()])
    assert [call["tier"] for call in fake.calls] == ["bulk", "strong"]
    assert row.venue_key == TRINITY.key and row.model == "strong-model-1"
    # When the client already fell back (its error says so), not again.
    fell_back = LLMValidationError("did not validate")
    fell_back.add_note("Fallback to strong-model-1 failed too: LLMValidationError")
    twice = FakeLLM(lambda _text, _tier: fell_back)
    run = chain(tmp_path / "b", twice)
    assert run.resolve([event("evt-b")]) == [] and len(twice.calls) == 1


# --- outside Cambridge ---------------------------------------------------------------------------


def test_an_away_fixture_is_placed_at_the_opponents_course(tmp_path, net: respx.MockRouter) -> None:
    course = {
        **osm("Woking Golf Club", lat=51.305, lng=-0.585, osm_id=9),
        "category": "leisure",
        "type": "golf_course",
        "address": {
            "road": "Pond Road",
            "town": "Woking",
            "postcode": "GU22 0JZ",
            "country_code": "gb",
        },
    }
    route = mock_nominatim(net, {"Woking Golf Club, Pond Road, Woking": [course]})
    fake = FakeLLM(
        reply(
            precision="exact",
            building={
                "name": "Woking Golf Club",
                "address": "Pond Road, Woking GU22 0JZ",
                "osm_query": "Woking Golf Club, Pond Road, Woking",
                "country": "GB",
            },
            outside_cambridge=True,
        )
    )
    run = chain(tmp_path, fake)
    [row] = run.resolve([event(title="Woking", organisers=["Quokka Golf Club"])])
    assert (row.precision, row.venue_key) == ("exact", "ven-woking-golf-club")
    params = route.calls.last.request.url.params
    assert "viewbox" not in params and "bounded" not in params
    assert params["countrycodes"] == "gb"
    claims = {c.field: c for c in run.venue_claims()}
    assert claims["lat"].value == 51.305 and claims["name"].value == "Woking Golf Club"
    assert run.metrics.outside == 1


def test_a_far_result_is_refused_for_a_place_not_flagged_outside(
    tmp_path, net: respx.MockRouter
) -> None:
    far = osm("Woking Golf Club", lat=51.305, lng=-0.585)
    mock_nominatim(net, {"Woking Golf Club, Cambridge": [far], "Woking Golf Club": [far]})
    mock_photon(net, {"Woking Golf Club": [feature("Woking Golf Club", 51.305, -0.585)]})
    fake = FakeLLM(reply(precision="exact", building={"name": "Woking Golf Club"}))
    [row] = chain(tmp_path, fake).resolve([event(title="Woking")])
    assert row.precision == "unknown"


def test_a_worldwide_hit_must_match_what_was_asked_and_its_country(
    tmp_path, net: respx.MockRouter
) -> None:
    wrong = {**osm("Royal Quokka Hotel", lat=48.85, lng=2.35), "address": {"country_code": "fr"}}
    mock_nominatim(net, {"Burrow School, Lille": [wrong]})
    geocoder = Geocoder(nominatim())
    spec = Building(name="Burrow School", osm_query="Burrow School, Lille", country="FR")
    assert geocoder.locate(spec, outside=True) is None


def test_only_a_town_found_makes_an_area(tmp_path, net: respx.MockRouter) -> None:
    town = {
        **osm("Leuven", lat=50.879, lng=4.700),
        "category": "boundary",
        "type": "administrative",
        "addresstype": "city",
        "address": {"city": "Leuven", "country_code": "be"},
    }
    mock_nominatim(net, {"Leuven, Belgium": [town]})
    mock_photon(net, {})
    fake = FakeLLM(
        reply(
            precision="exact",
            building={"name": "Leuven", "osm_query": "Leuven, Belgium", "country": "BE"},
            outside_cambridge=True,
        )
    )
    [row] = chain(tmp_path, fake).resolve([event(title="Quokka conference")])
    assert (row.precision, row.venue_key) == ("area", "ven-area--leuven")
    assert row.area_label == "Leuven (exact place not known)" and row.room is None


# --- the chain --------------------------------------------------------------------------------


def test_photon_finds_a_long_name_nominatim_misses(tmp_path, net: respx.MockRouter) -> None:
    mock_nominatim(net, {})
    route = mock_photon(
        net,
        {
            "Battcock Centre for Experimental Astrophysics": [
                feature("Battcock Centre", 52.21, 0.09)
            ]
        },
    )
    fake = FakeLLM(
        reply(
            precision="exact",
            building={"name": "Battcock Centre for Experimental Astrophysics"},
            room="Room F17",
        )
    )
    run = chain(tmp_path, fake)
    [row] = run.resolve([talk(venue="Battcock, Room F17")])
    assert (row.precision, row.venue_key, row.room) == ("exact", "ven-battcock-centre", "Room F17")
    params = route.calls.last.request.url.params
    assert params["bbox"] == "-0.1,52.05,0.35,52.35"
    assert route.calls.last.request.headers["User-Agent"] == UA
    claims = {c.field: c for c in run.venue_claims()}
    assert claims["name"].source_type == "osm_nominatim"
    assert claims["name"].source_url == "https://www.openstreetmap.org/way/77"
    assert claims["address"].value == "19 Madingley Road, Cambridge CB3 0HA"


def test_a_postcode_places_a_building_under_the_models_name(
    tmp_path, net: respx.MockRouter
) -> None:
    mock_nominatim(net, {})
    mock_photon(net, {})
    route = mock_postcodes(net, {"CB2 1QA": (52.2035, 0.1203)})
    fake = FakeLLM(
        reply(
            precision="exact",
            building={
                "name": "Quokka Research Centre",
                "address": "Pembroke Street, Cambridge CB2 1QA",
            },
        )
    )
    run = chain(tmp_path, fake)
    [row] = run.resolve([event(venueText="Quokka Research Centre, Pembroke Street")])
    assert (row.precision, row.venue_key) == ("building", "ven-quokka-research-centre")
    assert route.called
    claims = {c.field: c for c in run.venue_claims()}
    assert set(claims) == {"name", "address", "lat", "lng"}
    assert claims["lat"].source_type == "postcodes_io" and claims["lat"].method == "parser"
    assert claims["lat"].source_url == f"{'https://api.postcodes.io'}/postcodes/CB2%201QA"
    # The model's name and address: inferred model claims, cited to the lookup.
    assert claims["name"].method == "llm" and claims["name"].status == "inferred"
    assert claims["name"].value == "Quokka Research Centre"
    assert claims["address"].value == "Pembroke Street, Cambridge CB2 1QA"
    assert run.metrics.model_named_venues == 1


def test_a_structured_search_finds_the_street(tmp_path, net: respx.MockRouter) -> None:
    street = {**osm("Burrow Lane"), "name": "", "category": "highway", "type": "residential"}
    mock_nominatim(net, {"street=1 Burrow Lane|postalcode=CB2 1AB": [street]})
    mock_photon(net, {})
    fake = FakeLLM(
        reply(
            precision="exact",
            building={"name": "Burrow House", "address": "1 Burrow Lane, Cambridge CB2 1AB"},
        )
    )
    run = chain(tmp_path, fake, postcodes=None)
    [row] = run.resolve([event(venueText="Burrow House")])
    assert (row.precision, row.venue_key) == ("building", "ven-burrow-house")
    assert {c.field: c.source_type for c in run.venue_claims()}["lat"] == "osm_nominatim"


def test_a_model_name_that_is_not_a_buildings_makes_no_venue(
    tmp_path, net: respx.MockRouter
) -> None:
    mock_nominatim(net, {})
    mock_photon(net, {})
    mock_postcodes(net, {"CB2 1QA": (52.2035, 0.1203)})
    fake = FakeLLM(
        reply(
            precision="exact",
            building={"name": "Prof Quokka's house", "address": "Pembroke Street CB2 1QA"},
        )
    )
    run = chain(tmp_path, fake)
    [row] = run.resolve([event()])
    assert row.precision == "unknown" and run.venue_claims() == []


@pytest.mark.parametrize(
    "name, ok",
    [
        ("Great Shelford Memorial Hall", True),
        ("St Quokka's Church", True),
        ("Dr Quokka's rooms", False),
        ("Burrow Hall, CB2 1QA", False),
        ("Join us for drinks! Bring a friend", False),
        ("a b c d e f g h i", False),
        ("call 0122333444555", False),
        ("https://example.org/hall", False),
        ("", False),
    ],
)
def test_the_models_building_name_must_read_as_one(name: str, ok: bool) -> None:
    assert (model_building_name(name, event(venueText=name)) is not None) is ok


def test_an_events_title_is_no_building_name() -> None:
    item = event(title="The Annual Quokka Society Winter Ball")
    assert model_building_name("The Annual Quokka Society Winter Ball", item) is None
    item = event(title="Woking", organisers=["Quokka Golf Club"])
    assert model_building_name("Woking Golf Club", item) == "Woking Golf Club"


def test_the_models_address_must_carry_the_postcode_it_was_placed_by() -> None:
    from camsocs_pipeline.locate.geocode import GeoHit

    hit = GeoHit(
        lat=52.2,
        lng=0.12,
        name=None,
        address=None,
        level="postcode",
        source_type="postcodes_io",
        source_url="https://api.postcodes.io/postcodes/CB2%201QA",
        service="postcodes_io",
    )
    assert model_building_address("Pembroke Street, Cambridge CB2 1QA", hit)
    assert model_building_address("Pembroke Street, Cambridge CB3 0FD", hit) is None
    assert model_building_address("Pembroke Street, Cambridge", hit) is None


def test_an_outage_anywhere_in_the_chain_defers_the_item(tmp_path, net: respx.MockRouter) -> None:
    mock_nominatim(net, {})
    net.get(f"{PHOTON}/api").respond(502)
    fake = FakeLLM(reply(precision="exact", building={"name": "Burrow Hall"}))
    run = chain(tmp_path, fake)
    assert run.resolve([event()]) == [] and run.metrics.deferred == 1
    assert any("Photon did not answer" in note for note in run.notes)


def test_each_service_has_its_budget(tmp_path, net: respx.MockRouter) -> None:
    mock_nominatim(net, {})
    route = mock_photon(net, {})
    fake = FakeLLM(reply(precision="exact", building={"name": "Burrow Hall"}))
    run = chain(tmp_path, fake, budget=Budget(photon_calls=0))
    assert run.resolve([event()]) == []
    assert not route.called
    assert any("Photon budget spent" in note for note in run.notes)
    geocoder = Geocoder(nominatim(), budget=GeoBudget(nominatim=0))
    with pytest.raises(GeocodeDeferred) as raised:
        geocoder.locate(Building(name="X"))
    assert raised.value.budget


# --- the clients ------------------------------------------------------------------------------


def test_photon_parses_features_and_refuses_what_is_malformed() -> None:
    place = parse_feature(feature("Battcock Centre", 52.21, 0.09))
    assert place is not None and place.url == "https://www.openstreetmap.org/way/77"
    assert place.level == "feature" and place.country_code == "gb"
    assert parse_feature({"properties": {"osm_type": "X"}, "geometry": {}}) is None
    town = parse_feature(feature("Bern", 46.95, 7.44, key="place", value="city"))
    assert town is not None and town.level == "area"


def test_photon_without_an_answer_is_no_answer(net: respx.MockRouter) -> None:
    route = net.get(f"{PHOTON}/api")
    route.side_effect = [httpx.ConnectError("down"), httpx.Response(200, json={"features": []})]
    client = photon()
    with pytest.raises(PhotonUnavailable):
        client.search("Burrow Hall")
    assert client.search("Burrow Hall") is None and client.calls == 2


def test_postcodes_finds_a_point_and_knows_a_missing_postcode(net: respx.MockRouter) -> None:
    route = mock_postcodes(net, {"CB3 0FD": (52.2108, 0.0915)})
    client = postcodes()
    point = client.lookup("15 JJ Thomson Avenue, Cambridge cb30fd")
    assert point is not None and (point.lat, point.lng) == (52.2108, 0.0915)
    assert point.url == "https://api.postcodes.io/postcodes/CB3%200FD"
    assert client.lookup("CB9 9ZZ") is None
    assert client.lookup("CB9 9ZZ") is None and route.call_count == 2, "a 404 is an answer"
    assert route.calls[0].request.headers["User-Agent"] == UA


def test_postcodes_without_an_answer_is_no_answer(net: respx.MockRouter) -> None:
    net.get(url__startswith=f"{POSTCODES}/postcodes/").respond(503)
    with pytest.raises(PostcodesUnavailable):
        postcodes().lookup("CB3 0FD")


@pytest.mark.parametrize(
    "text, code",
    [
        ("15 JJ Thomson Avenue, Cambridge CB3 0FD", "CB3 0FD"),
        ("Pond Road, Woking gu220jz", "GU22 0JZ"),
        ("MR12, Centre for Mathematical Sciences", None),
        (None, None),
    ],
)
def test_postcodes_are_found_in_text(text: str | None, code: str | None) -> None:
    assert find_postcode(text) == code


def test_nominatim_levels_and_structured_search(net: respx.MockRouter) -> None:
    assert level_of("place", "city") == "area"
    assert level_of("boundary", "administrative", "city") == "area"
    assert level_of("highway", "residential") == "street"
    assert level_of("place", "house") == "street"
    assert level_of("amenity", "university") == "feature"
    assert level_of("leisure", "golf_course") == "feature"
    result = parse_result({**osm("X"), "address": {"country_code": "GB"}})
    assert result is not None and result.country_code == "gb"
    route = net.get(f"{NOMINATIM}/search").respond(200, json=[])
    assert nominatim().search_structured(street="1 Burrow Lane", postalcode="CB2 1AB") is None
    params = route.calls.last.request.url.params
    assert (params["street"], params["postalcode"], params["bounded"]) == (
        "1 Burrow Lane",
        "CB2 1AB",
        "1",
    )
    assert nominatim_query(route.calls.last.request) == "street=1 Burrow Lane|postalcode=CB2 1AB"
    # A city alone is no structured search.
    assert nominatim().search_structured(city="Cambridge") is None


@pytest.mark.parametrize(
    "text, code",
    [("GB", "gb"), ("UK", "gb"), ("Belgium", "be"), ("CHE", "ch"), ("Narnia", None), (None, None)],
)
def test_country_codes(text: str | None, code: str | None) -> None:
    assert country_code(text) == code


def test_the_new_source_type_is_in_both_vocabularies() -> None:
    from pathlib import Path

    from camsocs_pipeline.models.vocab import SOURCE_TYPES

    assert "postcodes_io" in SOURCE_TYPES
    vocab = Path(__file__).resolve().parents[3] / "webapp" / "lib" / "vocab.ts"
    assert '"postcodes_io"' in vocab.read_text(encoding="utf-8")


def test_a_key_the_organisers_name_is_kept(tmp_path, net: respx.MockRouter) -> None:
    route = mock_nominatim(net, {})
    fake = FakeLLM(
        reply(precision="building", venue_key=TRINITY.key, building={"name": "Great Burrow Court"})
    )
    item = event(title="Quokka social", organisers=["Trinity Quokka Society"])
    [row] = chain(tmp_path, fake).resolve([item])
    assert (row.precision, row.venue_key) == ("building", TRINITY.key)
    assert not route.called


def test_a_worldwide_hit_in_another_country_is_refused(net: respx.MockRouter) -> None:
    elsewhere = {**osm("Burrow School", lat=40.7, lng=-74.0), "address": {"country_code": "us"}}
    mock_nominatim(net, {"Burrow School, Lille": [elsewhere]})
    spec = Building(name="Burrow School", osm_query="Burrow School, Lille", country="FR")
    assert Geocoder(nominatim()).locate(spec, outside=True) is None


# --- review fixes: coarse places stay coarse, G1, grounding, loose matches -----------------------


def _leuven() -> dict[str, Any]:
    return {
        **osm("Leuven", lat=50.879, lng=4.700),
        "category": "boundary",
        "type": "administrative",
        "addresstype": "city",
        "address": {"city": "Leuven", "country_code": "be"},
    }


_LEUVEN_REPLY = {
    "precision": "exact",
    "building": {"name": "Leuven", "osm_query": "Leuven, Belgium", "country": "BE"},
    "outside_cambridge": True,
}


def test_a_town_found_stays_an_area_for_every_item_and_run(tmp_path, net: respx.MockRouter) -> None:
    mock_nominatim(net, {"Leuven, Belgium": [_leuven()]})
    mock_photon(net, {})
    fake = FakeLLM(reply(**_LEUVEN_REPLY))
    run = chain(tmp_path, fake)
    rows = run.resolve([event("evt-a", title="Quokka conference"), event("evt-b", title="Day 2")])
    assert [(r.precision, r.venue_key, r.area_label) for r in rows] == [
        ("area", "ven-area--leuven", "Leuven (exact place not known)"),
        ("area", "ven-area--leuven", "Leuven (exact place not known)"),
    ]
    # A later run: the area venue is known, by its key only.
    from camsocs_pipeline.locate.model import VenueRow

    area = VenueRow(key="ven-area--leuven", name="Leuven", lat=50.879, lng=4.7)
    later = chain(tmp_path / "b", FakeLLM(reply(**_LEUVEN_REPLY)), venues=[*VENUES_, area])
    [row] = later.resolve([event("evt-c", title="Day 3")])
    assert (row.precision, row.venue_key) == ("area", "ven-area--leuven")
    # Never offered to the model as a building, never matched by name.
    assert "ven-area--leuven" not in later.render(event("evt-d", venueText="Leuven"))
    assert later.index.by_name("Leuven") is None


def test_the_city_itself_is_no_answer_for_a_building(tmp_path, net: respx.MockRouter) -> None:
    city = {
        **osm("Cambridge", lat=52.2, lng=0.12),
        "category": "boundary",
        "type": "administrative",
        "addresstype": "city",
    }
    mock_nominatim(net, {"Kiki's, Cambridge": [city]})
    mock_photon(net, {})
    fake = FakeLLM(reply(precision="exact", building={"name": "Kiki's"}))
    run = chain(tmp_path, fake)
    [row] = run.resolve([event(venueText="Kiki's")])
    assert row.precision == "unknown" and run.venue_claims() == []


def test_a_point_near_the_building_stays_coarse_for_every_item_and_run(
    tmp_path, net: respx.MockRouter
) -> None:
    mock_nominatim(net, {})
    mock_photon(net, {})
    mock_postcodes(net, {"CB2 1QA": (52.2035, 0.1203)})
    building = {"name": "Quokka Research Centre", "address": "Pembroke Street, Cambridge CB2 1QA"}
    fake = FakeLLM(reply(precision="exact", building=building))
    coarse: dict[str, str] = {}
    run = chain(tmp_path, fake, coarse_venues=coarse)
    rows = run.resolve(
        [
            event("evt-a", venueText="Quokka Research Centre"),
            event("evt-b", venueText="Quokka Research Centre, ground floor"),
        ]
    )
    assert [(r.precision, r.venue_key) for r in rows] == [
        ("building", "ven-quokka-research-centre"),
        ("building", "ven-quokka-research-centre"),
    ]
    assert coarse == {"ven-quokka-research-centre": "postcode"}
    # A later run reaches the venue by name (deterministic alias match).
    from camsocs_pipeline.locate.model import VenueRow

    known = VenueRow(
        key="ven-quokka-research-centre", name="Quokka Research Centre", lat=52.2035, lng=0.1203
    )
    later = chain(tmp_path / "b", None, venues=[*VENUES_, known], coarse_venues=coarse)
    [row] = later.resolve([event("evt-c", venueText="Quokka Research Centre")])
    assert (row.precision, row.method, row.venue_key) == ("building", "alias", known.key)


def test_a_lookup_is_remembered_by_how_it_was_searched(tmp_path, net: respx.MockRouter) -> None:
    course = {
        **osm("Burrow Golf Club", lat=51.3, lng=-0.6, osm_id=9),
        "category": "leisure",
        "type": "golf_course",
        "address": {"town": "Burrowfield", "country_code": "gb"},
    }
    mock_nominatim(net, {"Burrow Golf Club": [course]})
    mock_photon(net, {})
    spec = {"name": "Burrow Golf Club", "country": "GB"}

    def answer(text: str, _tier: str) -> dict[str, Any]:
        away = "Away" in text
        return {"precision": "exact", "building": spec, "outsideCambridge": away}

    run = chain(tmp_path, FakeLLM(answer))
    home, away = run.resolve(
        [event("evt-a", title="Home match"), event("evt-b", title="Away match")]
    )
    # The Cambridge search found nothing; the worldwide one still ran.
    assert home.precision == "unknown"
    assert (away.precision, away.venue_key) == ("exact", "ven-burrow-golf-club")


def test_a_talk_never_names_a_venue_in_the_models_words(tmp_path, net: respx.MockRouter) -> None:
    mock_nominatim(net, {})
    mock_photon(net, {})
    mock_postcodes(net, {"CB2 1QA": (52.2035, 0.1203)})
    fake = FakeLLM(
        reply(
            precision="exact",
            building={
                "name": "Quokka Research Centre",
                "address": "Pembroke Street, Cambridge CB2 1QA",
            },
        )
    )
    run = chain(tmp_path, fake)
    rows = run.resolve(
        [
            talk(venue="Quokka Research Centre"),
            event("evt-talks", venueText="Quokka Research Centre", sourceType="talks_cam"),
        ]
    )
    assert [row.precision for row in rows] == ["unknown", "unknown"]
    assert run.venue_claims() == []


def test_a_model_name_the_item_does_not_give_makes_no_venue(
    tmp_path, net: respx.MockRouter
) -> None:
    mock_nominatim(net, {})
    mock_photon(net, {})
    mock_postcodes(net, {"CB2 1PZ": (52.2, 0.12)})
    building = {"name": "Bowmen Hall", "address": "Burrow Lane, Cambridge CB2 1PZ"}
    invented = chain(tmp_path, FakeLLM(reply(precision="exact", building=building)))
    [row] = invented.resolve([event(title="Archery training", organisers=["Quokka Archers"])])
    assert row.precision == "unknown" and invented.venue_claims() == []
    read = chain(tmp_path / "b", FakeLLM(reply(precision="exact", building=building)))
    [row] = read.resolve([event(title="Archery training", venueText="Bowmen Hall, CB2 1PZ")])
    assert (row.precision, row.venue_key) == ("building", "ven-bowmen-hall")
    assert {c.field: c.method for c in read.venue_claims()}["name"] == "llm"


def test_a_loose_name_match_is_refused(tmp_path, net: respx.MockRouter) -> None:
    mock_nominatim(net, {})
    mock_photon(net, {"Seminar Room 1": [feature("Lee Room & Seminar Room", 52.209, 0.1035)]})
    fake = FakeLLM(reply(precision="exact", building={"name": "Seminar Room 1"}))
    run = chain(tmp_path, fake)
    [row] = run.resolve([talk(venue="Seminar Room 1")])
    assert row.precision == "unknown" and run.venue_claims() == []
    # A building at the address asked for, by another name: a point near it.
    from camsocs_pipeline.locate.geocode import names_match

    assert names_match("Battcock Centre", Building(name="Battcock Centre for Astrophysics"))
    assert not names_match(
        "Wilberforce Road Sports Ground",
        Building(
            name="Centre for Mathematical Sciences",
            address="Wilberforce Road, Cambridge CB3 0WA",
            osm_query="Centre for Mathematical Sciences, Wilberforce Road, Cambridge",
        ),
    )


@pytest.mark.parametrize(
    "hit, expected",
    [
        # The town itself: an area.
        ({"category": "place", "type": "suburb", "name": "Barnes"}, "area"),
        # Its station, named just as the town: the town, at the station.
        ({"category": "railway", "type": "station", "name": "Barnes"}, "area"),
        # Anything else named after it: not the venue.
        ({"category": "railway", "type": "station", "name": "Barnes Bridge"}, None),
        ({"category": "amenity", "type": "pub", "name": "The Barnes Arms"}, None),
    ],
)
def test_a_bare_town_is_only_ever_an_area(
    net: respx.MockRouter, hit: dict[str, Any], expected: str | None
) -> None:
    found = {
        **osm(hit["name"], lat=51.47, lng=-0.24),
        "category": hit["category"],
        "type": hit["type"],
        "address": {"suburb": "Barnes", "country_code": "gb"},
    }
    mock_nominatim(net, {"Barnes": [found], "Barnes, England": [found]})
    spec = Building(name="Barnes", osm_query="Barnes, England", country="GB")
    located = Geocoder(nominatim()).locate(spec, outside=True)
    assert (located.level if located else None) == expected


def test_marlborough_the_town_is_an_area(tmp_path, net: respx.MockRouter) -> None:
    town = {
        **osm("Marlborough", lat=51.42, lng=-1.73),
        "osm_type": "relation",
        "category": "boundary",
        "type": "administrative",
        "addresstype": "town",
        "address": {"town": "Marlborough", "country_code": "gb"},
    }
    mock_nominatim(net, {"Marlborough": [town]})
    mock_photon(net, {})
    fake = FakeLLM(
        reply(
            precision="exact",
            building={"name": "Marlborough", "country": "GB"},
            outside_cambridge=True,
        )
    )
    [row] = chain(tmp_path, fake).resolve([event(title="Marlborough (away)")])
    assert (row.precision, row.venue_key) == ("area", "ven-area--marlborough")


def test_transport_stops_are_near_a_place_not_a_place() -> None:
    assert level_of("railway", "station") == "street"
    assert level_of("public_transport", "station") == "street"
    assert level_of("highway", "bus_stop") == "street"
    assert level_of("aeroway", "aerodrome") == "street"
    assert level_of("leisure", "sports_centre") == "feature"


def test_generic_words_do_not_keep_a_key_picked_off_the_list(
    tmp_path, net: respx.MockRouter
) -> None:
    from camsocs_pipeline.locate.model import VenueRow

    chapel = VenueRow(
        key="ven-kings-college-chapel", name="King's College Chapel", lat=52.2, lng=0.1
    )
    hall = {**osm("West Road Concert Hall", osm_id=5), "category": "amenity", "type": "theatre"}
    mock_nominatim(net, {"West Road Concert Hall, Cambridge": [hall]})
    fake = FakeLLM(
        reply(
            precision="exact",
            venue_key=chapel.key,
            building={"name": "West Road Concert Hall"},
        )
    )
    run = chain(tmp_path, fake, venues=[*VENUES_, chapel])
    item = event(venueText="West Road Concert Hall", organisers=["Trinity College Music Society"])
    [row] = run.resolve([item])
    assert row.venue_key == "ven-west-road-concert-hall"


def test_places_skips_far_venues_and_areas(tmp_path, net: respx.MockRouter) -> None:
    from camsocs_pipeline.locate.model import VenueRow
    from camsocs_pipeline.locate.places import SEARCH_URL, Places

    route = net.post(SEARCH_URL).respond(200, json={"places": [{"id": "ChIJabcdefghijk"}]})
    far = VenueRow(key="ven-woking-golf-club", name="Woking Golf Club", lat=51.305, lng=-0.585)
    area = VenueRow(key="ven-area--grantchester", name="Grantchester", lat=52.18, lng=0.09)
    run = chain(
        tmp_path,
        None,
        venues=[far, area, ADC],
        places=Places(api_key="k", user_agent=UA),
    )
    run.place_ids()
    assert route.call_count == 1
    assert [c.entity_key for c in run.venue_claims()] == [ADC.key]
