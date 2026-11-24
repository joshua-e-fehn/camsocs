"""The committed Cambridge gazetteer (docs/locations-and-map.md §2 step 4,
source-research §23): its build from Overpass (mocked), the committed data
and curated aliases, matching against the real committed data, its place in
the resolver (before Nominatim, OSM values only, talks included), the
resolver version that re-tries `unknown` rows from the cached reply, and the
postcode check of a road the structured search found.

No network is reached (respx); the matching tests read the committed files.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest
import respx

from camsocs_pipeline.locate import gazetteer_build as build
from camsocs_pipeline.locate.gazetteer import (
    ALIASES_PATH,
    PLACES_PATH,
    Gazetteer,
    GazetteerPlace,
    address_free,
    addressish,
    core_words,
    lookup_name,
    operator_phrase,
)
from camsocs_pipeline.locate.matching import input_hash
from camsocs_pipeline.locate.model import PendingItem, VenueRow
from camsocs_pipeline.locate.resolver import (
    PROMPT_NAME,
    RESOLVER_VERSION,
    gazetteer_name,
    row_input_hash,
)
from camsocs_pipeline.stages import locate as stage
from tests.fakes import FakeLLM
from tests.test_locate import INI, NOMINATIM, STARTS, UA, event, mock_nominatim, reply, talk
from tests.test_locate import VENUES as VENUES_
from tests.test_locate_coverage import POSTCODES, chain, mock_photon, mock_postcodes

GAZETTEER = Gazetteer.default()
FACULTY_OF_MUSIC = "way/132558230"
LAND_ECONOMY = "way/136330930"
PHYSIOLOGY = "way/28364543"
RAY_DOLBY = "relation/17935287"
AUSTIN_ROBINSON = "way/26378137"
CMS = "way/4195915"
WILLIAM_GATES = "relation/8388"
ROBINSON = "way/3997908"
PEMBROKE = "way/31773719"
DARWIN = "way/29202801"
MURRAY_EDWARDS = "way/139485561"
CLARE_HALL = "way/112682568"
DOWNING = "way/3993119"
GIRTON = "way/155223748"
GIRTON_MAIN_HALL = "way/155223757"
FITZWILLIAM_CHAPEL = "way/112374493"


def wire(item: PendingItem) -> dict[str, Any]:
    return item.model_dump(by_alias=True, exclude_none=True)


# --- the build (Overpass, mocked) -----------------------------------------------------------------


def _elements() -> list[dict[str, Any]]:
    return [
        {
            "type": "way",
            "id": 1,
            "center": {"lat": 52.2023856, "lon": 0.1078436},
            "tags": {
                "building": "university",
                "name": "11 Quokka Road",
                "occupier": "Faculty of Burrows (Admin Offices; Custodian's Office)",
                "operator": "University of Cambridge",
                "addr:housenumber": "11",
                "addr:street": "Quokka Road",
                "addr:postcode": "CB3 9DP",
            },
        },
        {
            "type": "way",
            "id": 2,
            "center": {"lat": 52.2020845, "lon": 0.116233},
            "tags": {
                "building": "university",
                "occupier": "Department of Pouches",
                "ref": "B037",
                "operator": "University of Cambridge",
            },
        },
        # A bin, a door, a label node and a nameless building: no venues.
        {
            "type": "node",
            "id": 3,
            "lat": 52.2,
            "lon": 0.1,
            "tags": {"amenity": "recycling", "name": "Burrow Building"},
        },
        {
            "type": "node",
            "id": 4,
            "lat": 52.2,
            "lon": 0.1,
            "tags": {"entrance": "main", "name": "Burrow Building"},
        },
        {"type": "node", "id": 5, "lat": 52.2, "lon": 0.1, "tags": {"name": "Label"}},
        {"type": "way", "id": 6, "center": {"lat": 52.2, "lon": 0.1}, "tags": {"building": "yes"}},
        {
            "type": "node",
            "id": 7,
            "lat": 52.2044,
            "lon": 0.1201,
            "tags": {"amenity": "pub", "name": "The Quokka", "alt_name": "Quokka Arms;Q"},
        },
        # The same object twice (two clauses of the query): once in the file.
        {
            "type": "node",
            "id": 7,
            "lat": 52.2044,
            "lon": 0.1201,
            "tags": {"amenity": "pub", "name": "The Quokka"},
        },
    ]


def test_the_query_asks_for_cambridges_buildings_in_one_request() -> None:
    query = build.overpass_query()
    assert query.startswith("[out:json]") and query.endswith("out center tags;")
    assert "(52.15,0.03,52.26,0.22)" in query and "(52.05,-0.1,52.35,0.35)" in query
    assert '"operator"~"University of Cambridge' in query
    assert 'nwr["building"]["occupier"]' in query


def test_the_build_writes_named_places_from_overpass(tmp_path, net: respx.MockRouter) -> None:
    route = net.post("https://overpass.example.org/api/interpreter").mock(
        return_value=httpx.Response(200, json={"elements": _elements()})
    )
    elements = build.fetch(UA, url="https://overpass.example.org/api/interpreter")
    assert route.calls.last.request.headers["User-Agent"] == UA
    assert b"data=" in route.calls.last.request.content
    content = build.build(elements, retrieved_at=datetime(2026, 11, 24, 7, tzinfo=UTC))
    path = tmp_path / "places.json"
    size = build.write(content, path)
    data = json.loads(path.read_text(encoding="utf-8"))
    assert size == path.stat().st_size
    assert data["retrievedAt"] == "2026-11-24T07:00:00Z" and "ODbL" in data["licence"]
    places = {(p["osmType"], p["osmId"]): p for p in data["places"]}
    assert set(places) == {("way", 1), ("way", 2), ("node", 7)}
    music = places[("way", 1)]
    assert music["name"] == "11 Quokka Road" and music["altNames"] == ["Faculty of Burrows"]
    assert music["address"] == "11 Quokka Road, Cambridge CB3 9DP"
    assert (music["lat"], music["lng"]) == (52.202386, 0.107844)
    pouches = places[("way", 2)]
    assert pouches["name"] == "Department of Pouches" and pouches["nameFrom"] == "occupier"
    # "Q" is too short a name to look up (`gazetteer.lookup_name`).
    assert places[("node", 7)]["altNames"] == ["Quokka Arms"]
    assert places[("node", 7)]["kind"] == "amenity=pub"


def test_an_overpass_answer_without_elements_fails(net: respx.MockRouter) -> None:
    net.post("https://overpass.example.org/api/interpreter").mock(
        return_value=httpx.Response(200, json={"remark": "timeout"})
    )
    with pytest.raises(RuntimeError):
        build.fetch(UA, url="https://overpass.example.org/api/interpreter")


# --- the committed data ---------------------------------------------------------------------------


def test_the_committed_gazetteer_is_small_dated_and_credited() -> None:
    assert PLACES_PATH.stat().st_size < 2_000_000
    data = json.loads(PLACES_PATH.read_text(encoding="utf-8"))
    assert "OpenStreetMap" in data["licence"] and "ODbL" in data["licence"]
    assert datetime.fromisoformat(data["retrievedAt"].replace("Z", "+00:00")).year >= 2026
    assert len(data["places"]) > 1_000
    for place in data["places"]:
        assert 52.05 <= place["lat"] <= 52.35 and -0.10 <= place["lng"] <= 0.35
        assert place["osmType"] in ("node", "way", "relation") and place["name"]


def test_every_alias_points_at_the_building_it_names() -> None:
    aliases = json.loads(ALIASES_PATH.read_text(encoding="utf-8"))["aliases"]
    for entry in aliases:
        place = GAZETTEER.get(entry["osm"])
        assert place is not None, f"{entry['osm']} is not in cambridge_places.json"
        assert place.name == entry["building"], entry["osm"]
        assert entry["names"]


def test_an_alias_to_a_missing_place_is_refused() -> None:
    with pytest.raises(ValueError):
        Gazetteer.of({}, [("Faculty of Burrows", "way/1")])


# --- matching (the committed data) ----------------------------------------------------------------


@pytest.mark.parametrize(
    "texts, ident",
    [
        (["Faculty of Music"], FACULTY_OF_MUSIC),
        (["Recital Room, Faculty of Music"], FACULTY_OF_MUSIC),
        (["5:00pm to 7:00pm • Faculty of Music"], FACULTY_OF_MUSIC),
        (["Department of Land Economy, University of Cambridge"], LAND_ECONOMY),
        (["Lecture Theatre A, Department of Land Economy"], LAND_ECONOMY),
        (["Hodgkin-Huxley Seminar Room"], PHYSIOLOGY),
        (["Physiology Building, Downing Site"], PHYSIOLOGY),
        (["Seminar Room West RDC (A0.015)"], RAY_DOLBY),
        (["Ray Dolby Centre"], RAY_DOLBY),
        (["Keynes Room"], AUSTIN_ROBINSON),
        (["Faculty of Economics"], AUSTIN_ROBINSON),
        (["MR12 CMS"], CMS),
        (["MR12, Centre for Mathematical Sciences"], CMS),
        (["William Gates Building"], WILLIAM_GATES),
        (["Lecture Theatre 1, Computer Laboratory"], WILLIAM_GATES),
        (["Department of Computer Science and Technology"], WILLIAM_GATES),
        # The first text that names a place wins.
        ([None, "", "Somewhere", "Keynes Room"], AUSTIN_ROBINSON),
    ],
)
def test_the_gazetteer_finds_cambridge_buildings(texts: list[str | None], ident: str) -> None:
    hit = GAZETTEER.find(texts)
    assert hit is not None and hit.place.ident == ident


@pytest.mark.parametrize(
    "text",
    [
        "Kiki's",  # OSM has no Kiki's in Cambridge (a nightclub "KiKi" is another name)
        "De Koelisse",  # Leuven
        "Seminar Room 1",
        "Hall",
        "Mill Lane Lecture Rooms",  # not "Mill Lane (Pembroke College)"
        "Quokka House, 16 Mill Lane, Cambridge",  # an address is no building's name
        "Eagle Labs",  # not The Eagle (a pub's name must be the whole text)
    ],
)
def test_the_gazetteer_does_not_guess(text: str) -> None:
    assert GAZETTEER.find([text]) is None


#: Texts that once matched the wrong place (the review of 2026-11-24): a
#: room of another college, a street's name, one shared word, an OSM
#: placeholder, a restaurant named like a college.
FALSE_FRIENDS = [
    # A room's name alone is every college's room.
    "Chapel",
    "Library",
    "The Bar",
    "Main Hall",
    "Great Hall",
    "Theatre",
    "Buttery",
    "Combination Room",
    # A street in the text is no building on it.
    "Emmanuel United Reformed Church, Trumpington Street, Cambridge",
    "Hidden Rooms, Jesus Lane, Cambridge",
    "Meeting room, 2 Jesus Lane",
    "Lola Lo, Corn Exchange Street",
    "Room 1, 12 St Andrew's Street",
    "Pembroke Street lecture",
    # One shared word is not a name.
    "Council Chamber, Guildhall",
    "Committee Room, Council Offices",
    "Conservation Society talk",
    "Union Chapel",
    "The Fountain",
    "Physics",
    "Fen",
    # OSM placeholders, the University itself, too-short names.
    "TBA",
    "Location TBA",
    "Cambridge University",
    "Room TBA, Cambridge University",
    "University of Cambridge",
    "E",
    "Chi",
    "Fu",
    # A restaurant called Trinity is not Trinity (two colleges share the word).
    "Trinity",
    "Junior Parlour, Trinity",
]


@pytest.mark.parametrize("text", FALSE_FRIENDS)
def test_the_gazetteer_does_not_match_false_friends(text: str) -> None:
    hit = GAZETTEER.find([text])
    assert hit is None, (text, hit and (hit.place.name, hit.place.ident, hit.how))


@pytest.mark.parametrize(
    "text, ident",
    [
        # The room's segment comes first, the college's names the building.
        ("Chapel, Robinson College", ROBINSON),
        ("Theatre, Robinson College", ROBINSON),
        ("Library, Pembroke College", PEMBROKE),
        ("The Bar, Darwin College", DARWIN),
        ("Main Hall, Murray Edwards", MURRAY_EDWARDS),
        ("College Library, Murray Edwards", MURRAY_EDWARDS),
        ("Great Hall, Clare Hall", CLARE_HALL),
        ("Combination Room, Downing College", DOWNING),
        # A room with its own college is that college's room.
        ("Main Hall, Girton College", GIRTON_MAIN_HALL),
        ("Chapel, Fitzwilliam College", FITZWILLIAM_CHAPEL),
        ("Fitzwilliam College Chapel", FITZWILLIAM_CHAPEL),
        # A college's short name is the college, not a building in it.
        ("Robinson", ROBINSON),
        ("Pembroke", PEMBROKE),
        ("Girton", GIRTON),
        ("Talk at Girton College tonight", GIRTON),
    ],
)
def test_a_room_or_short_name_is_the_college_it_names(text: str, ident: str) -> None:
    hit = GAZETTEER.find([text])
    assert hit is not None and hit.place.ident == ident, (text, hit and hit.place.name)


def test_the_bar_of_another_college_is_not_trinitys() -> None:
    hit = GAZETTEER.find(["The Hall, Westminster College"])
    assert hit is not None and "Westminster" in hit.place.name
    hit = GAZETTEER.find(["The Bar, Trinity Hall"])
    assert hit is not None and hit.place.name.startswith("Trinity Hall")


def test_a_street_in_the_osm_query_never_replaces_the_geocode() -> None:
    # The building the model names, then its OSM query (the resolver's order).
    assert (
        GAZETTEER.find(
            ["Emmanuel United Reformed Church", "Emmanuel URC, Trumpington Street, Cambridge"]
        )
        is None
    )
    assert GAZETTEER.find(["Lola Lo", "Lola Lo, Corn Exchange Street, Cambridge"]) is None


def test_a_pubs_one_word_name_is_only_the_whole_text() -> None:
    hit = GAZETTEER.find(["Galleria"])
    assert hit is not None and hit.place.kind == "amenity=restaurant"
    assert GAZETTEER.find(["Upstairs, Galleria"]) is None


def test_names_that_are_never_looked_up() -> None:
    for name in ("TBA", "tbc", "Cambridge University", "University of Cambridge", "E", "Chi"):
        assert not lookup_name(name), name
    assert lookup_name("Heycock Wing") and lookup_name("Ray Dolby Centre")
    assert core_words("main hall") == set() and core_words("the bar") == set()
    assert core_words("fitzwilliam college chapel") == {"fitzwilliam"}
    assert operator_phrase("Newnham College, University of Cambridge") == "newnham college"
    assert operator_phrase("University of Cambridge") is None
    assert address_free("Hidden Rooms, Jesus Lane, Cambridge CB5 8BQ") == ["hidden rooms"]
    assert address_free("Pembroke Street lecture, 2 Jesus Lane") == ["lecture"]


def test_names_that_read_as_addresses() -> None:
    assert addressish("11 west road") and addressish("mill lane")
    assert not addressish("austin robinson building")


def test_a_shared_name_counts_only_when_its_places_are_close() -> None:
    def place(ident: int, lat: float, address: str | None = None) -> GazetteerPlace:
        return GazetteerPlace("way", ident, "Burrow Building", (), None, None, address, lat, 0.12)

    near = Gazetteer.of({p.ident: p for p in (place(1, 52.2), place(2, 52.2005, "1 Lane"))})
    hit = near.find(["Burrow Building"])
    assert hit is not None and hit.place.ident == "way/2"  # the one with an address
    far = Gazetteer.of({p.ident: p for p in (place(1, 52.2), place(2, 52.25))})
    assert far.find(["Burrow Building"]) is None


def test_a_venue_name_drops_the_university_qualifier() -> None:
    assert (
        gazetteer_name("Centre for Mathematical Sciences (University of Cambridge)")
        == "Centre for Mathematical Sciences"
    )
    assert gazetteer_name("Ray Dolby Centre (Cavendish Laboratory)") == (
        "Ray Dolby Centre (Cavendish Laboratory)"
    )


# --- the resolver ---------------------------------------------------------------------------------


def music_reply():
    return reply(
        precision="exact",
        building={
            "name": "Faculty of Music",
            "address": "West Road, Cambridge CB3 9DP",
            "osm_query": "Faculty of Music, West Road, Cambridge",
        },
        room="Recital Room",
    )


def test_a_talk_in_a_building_osm_names_otherwise_is_placed_without_a_request(
    tmp_path, net: respx.MockRouter
) -> None:
    nominatim = mock_nominatim(net, {})
    mock_photon(net, {})
    mock_postcodes(net, {})
    run = chain(tmp_path, FakeLLM(music_reply()), gazetteer=GAZETTEER)
    [row] = run.resolve([talk(venue="Recital Room, Faculty of Music")])
    assert (row.precision, row.venue_key, row.room) == ("exact", "ven-11-west-road", "Recital Room")
    assert not nominatim.called
    claims = {c.field: c for c in run.venue_claims()}
    assert set(claims) == {"name", "address", "lat", "lng"}
    # OSM's own values (G1: never the talk's wording), cited to the object.
    assert claims["name"].value == "11 West Road" and claims["name"].method == "parser"
    assert claims["name"].source_type == "osm_nominatim"
    assert claims["name"].source_url == "https://www.openstreetmap.org/way/132558230"
    assert claims["name"].extractor == "locate.gazetteer.name"
    assert claims["address"].value == "11 West Road, Cambridge CB3 9DP"
    assert claims["lat"].retrieved_at == int(GAZETTEER.retrieved_at.timestamp() * 1000)
    assert run.metrics.gazetteer_hits == 1 and run.metrics.new_venues == 1


@pytest.mark.parametrize(
    "building, venue, key",
    [
        (
            {"name": "Department of Land Economy, University of Cambridge"},
            "",
            "ven-department-of-land-economy",
        ),
        (
            {"name": "Hodgkin-Huxley Seminar Room", "osm_query": "Physiology, Downing Site"},
            "Hodgkin-Huxley Seminar Room",
            "ven-physiology-building",
        ),
        (
            {"name": "Seminar Room West RDC (A0.015)"},
            "",
            "ven-ray-dolby-centre-cavendish-laboratory",
        ),
        (
            {"name": "Centre for Mathematical Sciences"},
            "MR12 CMS",
            "ven-centre-for-mathematical-sciences",
        ),
    ],
)
def test_the_production_misses_are_found(
    tmp_path, net: respx.MockRouter, building: dict[str, str], venue: str, key: str
) -> None:
    nominatim = mock_nominatim(net, {})
    run = chain(tmp_path, FakeLLM(reply(precision="exact", building=building)), gazetteer=GAZETTEER)
    [row] = run.resolve([talk(venue=venue)])
    assert (row.precision, row.venue_key) == ("exact", key)
    assert not nominatim.called


def test_a_known_venue_without_a_point_is_placed_by_the_gazetteer(
    tmp_path, net: respx.MockRouter
) -> None:
    nominatim = mock_nominatim(net, {})
    known = VenueRow(key="ven-faculty-of-music", name="Faculty of Music")
    run = chain(tmp_path, FakeLLM(music_reply()), venues=[*VENUES_, known], gazetteer=GAZETTEER)
    [row] = run.resolve([talk(venue="Recital Room, Faculty of Music")])
    assert row.venue_key == "ven-faculty-of-music" and row.precision == "exact"
    assert not nominatim.called
    claims = {c.field: c for c in run.venue_claims()}
    assert set(claims) == {"lat", "lng", "address"}  # the known venue keeps its name
    assert claims["lat"].source_url == "https://www.openstreetmap.org/way/132558230"
    assert run.index.get("ven-faculty-of-music").placed  # type: ignore[union-attr]


def test_the_venue_text_is_the_last_resort(tmp_path, net: respx.MockRouter) -> None:
    mock_nominatim(net, {})
    mock_photon(net, {})
    mock_postcodes(net, {})
    unknown_building = {"name": "Quokka Recital Suite", "address": "Cambridge"}
    run = chain(
        tmp_path,
        FakeLLM(reply(precision="exact", building=unknown_building)),
        gazetteer=GAZETTEER,
    )
    [row] = run.resolve([talk(venue="5:00pm to 7:00pm • Faculty of Music")])
    assert (row.precision, row.venue_key) == ("building", "ven-11-west-road")


def test_a_place_outside_cambridge_never_uses_the_gazetteer(
    tmp_path, net: respx.MockRouter
) -> None:
    mock_nominatim(net, {})
    mock_photon(net, {})
    building = {
        "name": "Faculty of Music",
        "osm_query": "Faculty of Music, Leuven",
        "country": "BE",
    }
    run = chain(
        tmp_path,
        FakeLLM(reply(precision="exact", building=building, outside_cambridge=True)),
        gazetteer=GAZETTEER,
    )
    [row] = run.resolve([event(venueText="Faculty of Music, Leuven")])
    assert row.precision == "unknown" and run.metrics.gazetteer_hits == 0


# --- the resolver version -------------------------------------------------------------------------


def test_an_unknown_row_carries_the_resolver_version(tmp_path, net: respx.MockRouter) -> None:
    mock_nominatim(net, {})
    mock_photon(net, {})
    mock_postcodes(net, {})
    run = chain(tmp_path, FakeLLM(reply(precision="unknown", note="nothing given")))
    item = talk(venue="TBC")
    [row] = run.resolve([item])
    digest = input_hash(item, PROMPT_NAME)
    assert row.precision == "unknown" and row.input_hash == f"{digest}:{RESOLVER_VERSION}"
    assert row_input_hash(digest, "exact") == digest
    assert len(row.input_hash) <= 128


def test_an_older_unknown_row_is_due_and_resolved_from_the_cached_reply(
    tmp_path, net: respx.MockRouter
) -> None:
    item = talk(venue="Recital Room, Faculty of Music")
    digest = input_hash(item, PROMPT_NAME)

    def stored(precision: str, hash_: str) -> PendingItem:
        return PendingItem.model_validate(
            {
                **wire(item),
                "stored": {"inputHash": hash_, "precision": precision, "startsAt": STARTS},
            }
        )

    old_unknown = stored("unknown", digest)
    new_unknown = stored("unknown", f"{digest}:{RESOLVER_VERSION}")
    placed = stored("exact", digest)
    assert stage.due([old_unknown, new_unknown, placed]) == ([old_unknown], 2)

    # The first run's reply is cached; the next run asks no model.
    mock_nominatim(net, {})
    mock_photon(net, {})
    mock_postcodes(net, {})
    first = FakeLLM(music_reply())
    chain(tmp_path, first).resolve([item])
    again = FakeLLM(music_reply())
    [row] = chain(tmp_path, again, gazetteer=GAZETTEER).resolve([old_unknown])
    assert len(first.calls) == 1 and again.calls == []
    assert row.precision == "exact" and row.input_hash == digest


# --- the postcode check ---------------------------------------------------------------------------


def _road(lat: float, lng: float) -> dict[str, Any]:
    return {
        "osm_type": "way",
        "osm_id": 9,
        "lat": str(lat),
        "lon": str(lng),
        "name": "Burrow Road",
        "category": "highway",
        "type": "residential",
        "address": {"road": "Burrow Road", "city": "Cambridge", "postcode": "CB2 1QA"},
    }


@pytest.mark.parametrize(
    "road, by_postcode",
    [((52.2100, 0.1203), True), ((52.2036, 0.1205), False)],
)
def test_a_road_far_from_the_postcode_gives_way_to_the_postcodes_point(
    tmp_path, net: respx.MockRouter, road: tuple[float, float], by_postcode: bool
) -> None:
    mock_nominatim(net, {"street=Burrow Road|postalcode=CB2 1QA": [_road(*road)]})
    mock_photon(net, {})
    postcodes = mock_postcodes(net, {"CB2 1QA": (52.2035, 0.1203)})
    building = {"name": "Quokka Research Centre", "address": "Burrow Road, Cambridge CB2 1QA"}
    run = chain(tmp_path, FakeLLM(reply(precision="exact", building=building)))
    [row] = run.resolve([event(venueText="Quokka Research Centre, Burrow Road")])
    assert postcodes.called  # asked whenever a road answers and a postcode is known
    assert row.precision == "building"
    source = {c.field: c.source_type for c in run.venue_claims()}["lat"]
    assert source == ("postcodes_io" if by_postcode else "osm_nominatim")
    assert run.geocoder is not None
    assert run.geocoder.postcode_points == (1 if by_postcode else 0)
    assert POSTCODES and NOMINATIM and INI  # fixtures shared with the other locate suites


def test_a_road_stands_when_postcodes_io_gives_no_answer(tmp_path, net: respx.MockRouter) -> None:
    mock_nominatim(net, {"street=Burrow Road|postalcode=CB2 1QA": [_road(52.2100, 0.1203)]})
    mock_photon(net, {})
    postcodes = net.get(url__startswith=f"{POSTCODES}/postcodes/").mock(
        return_value=httpx.Response(503)
    )
    building = {"name": "Quokka Research Centre", "address": "Burrow Road, Cambridge CB2 1QA"}
    run = chain(tmp_path, FakeLLM(reply(precision="exact", building=building)))
    [row] = run.resolve([event(venueText="Quokka Research Centre, Burrow Road")])
    assert postcodes.called
    # The road is the answer (never a deferral that leaves the item without a row).
    assert row.precision == "building"
    assert {c.field: c.source_type for c in run.venue_claims()}["lat"] == "osm_nominatim"
