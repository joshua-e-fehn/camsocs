"""Coarse venues (docs/locations-and-map.md §2 step 4, "Coarse venues"):
venues earlier runs made of a town, a region or a street are classified by
their OpenStreetMap object (Nominatim `/lookup`, mocked; the gazetteer for
the objects it holds), never place an item `exact`, are left out of the
shortlist and of matching by name, and the rows at them are resolved again
from the cached reply. Rooms carry no building name, address or postcode.

The resolver cases are the production rows of the second run (2026-11-24).
No network is reached (respx).
"""

from __future__ import annotations

import json
from datetime import timedelta
from typing import Any

import httpx
import pytest
import respx

from camsocs_pipeline.extract.memo import LLMMemo
from camsocs_pipeline.locate.gazetteer import Gazetteer
from camsocs_pipeline.locate.matching import VenueIndex, clean_room, input_hash
from camsocs_pipeline.locate.model import LocateReply, PendingItem, VenueRow
from camsocs_pipeline.locate.nominatim import (
    LOOKUP_BATCH,
    Nominatim,
    NominatimBlocked,
    NominatimUnavailable,
)
from camsocs_pipeline.locate.resolver import PROMPT_NAME, RESOLVER_VERSION
from camsocs_pipeline.locate.venue_class import (
    RECHECK_DAYS,
    Coarse,
    classify_venues,
    coarse_level,
    is_itself,
)
from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.pipeline.load import ConvexLoader
from camsocs_pipeline.pipeline.report import RunReport
from camsocs_pipeline.pipeline.state import SyncState
from camsocs_pipeline.stages import locate as stage
from camsocs_pipeline.staging.store import StagingStore
from tests.fakes import FakeLLM
from tests.test_locate import (
    NOMINATIM,
    NOW,
    SITE,
    STARTS,
    UA,
    convex,
    event,
    mock_nominatim,
    osm,
    reply,
    talk,
    wire,
)
from tests.test_locate import VENUES as KNOWN
from tests.test_locate_coverage import chain, mock_photon, mock_postcodes

GAZETTEER = Gazetteer.default()
TRINITY_HALL = "way/151180818"
CMS = "way/4195915"


def osm_url(ident: str) -> str:
    return f"https://www.openstreetmap.org/{ident}"


CAMBRIDGE = VenueRow(
    key="ven-cambridge",
    name="Cambridge",
    lat=52.2055,
    lng=0.1186,
    osm_url=osm_url("relation/295355"),
)
WILBERFORCE = VenueRow(
    key="ven-wilberforce-road",
    name="Wilberforce Road",
    lat=52.2097,
    lng=0.1018,
    osm_url=osm_url("way/4005061"),
)
DOWNING_STREET = VenueRow(
    key="ven-downing-street",
    name="Downing Street",
    address="Downing Street, Cambridge CB2 3EB",
    lat=52.2030,
    lng=0.1215,
    osm_url=osm_url("way/4250301"),
)
TOPSHAM = VenueRow(
    key="ven-topsham-road",
    name="Topsham Road",
    lat=50.7085,
    lng=-3.5110,
    osm_url=osm_url("way/2265331"),
)
GREATER_LONDON = VenueRow(
    key="ven-greater-london",
    name="Greater London",
    lat=51.5,
    lng=-0.12,
    osm_url=osm_url("relation/175342"),
)
#: A building the model named, placed at its street's point (round 2): it
#: keeps its name for matching, and is `building` at most.
HIDDEN_ROOMS = VenueRow(
    key="ven-hidden-rooms",
    name="Hidden Rooms",
    lat=52.2088,
    lng=0.1239,
    osm_url=osm_url("way/4002277"),
)
COARSE_VENUES = [CAMBRIDGE, WILBERFORCE, DOWNING_STREET, TOPSHAM, GREATER_LONDON, HIDDEN_ROOMS]

#: What `/lookup` says these objects are.
LOOKUP: dict[str, dict[str, Any]] = {
    "R295355": {"category": "boundary", "type": "administrative", "name": "Cambridge"},
    "W4005061": {"category": "highway", "type": "residential", "name": "Wilberforce Road"},
    "W4250301": {"category": "highway", "type": "tertiary", "name": "Downing Street"},
    "W2265331": {"category": "highway", "type": "primary", "name": "Topsham Road"},
    "R175342": {"category": "boundary", "type": "ceremonial", "name": "Greater London"},
    "W4002277": {"category": "highway", "type": "unclassified", "name": "Jesus Lane"},
}
CLASSES = {
    CAMBRIDGE.key: Coarse("area", itself=True),
    WILBERFORCE.key: Coarse("street", itself=True),
    DOWNING_STREET.key: Coarse("street", itself=True),
    TOPSHAM.key: Coarse("street", itself=True),
    GREATER_LONDON.key: Coarse("area", itself=True),
    HIDDEN_ROOMS.key: Coarse("street", itself=False),
}


def lookup_result(code: str) -> dict[str, Any]:
    types = {"N": "node", "W": "way", "R": "relation"}
    return {
        "osm_type": types[code[0]],
        "osm_id": int(code[1:]),
        "lat": "52.2",
        "lon": "0.12",
        **LOOKUP[code],
    }


def mock_lookup(net: respx.MockRouter, answers: dict[str, dict[str, Any]] | None = None):
    def answer(request: httpx.Request) -> httpx.Response:
        codes = request.url.params["osm_ids"].split(",")
        known = answers if answers is not None else LOOKUP
        return httpx.Response(200, json=[lookup_result(code) for code in codes if code in known])

    return net.get(f"{NOMINATIM}/lookup").mock(side_effect=answer)


def nominatim(waits: list[float] | None = None) -> Nominatim:
    ticks = iter(range(1_000))
    return Nominatim(
        user_agent=UA,
        base_url=NOMINATIM,
        clock=lambda: next(ticks) * 0.1,
        sleep=(waits.append if waits is not None else lambda _s: None),
    )


# --- Nominatim /lookup -------------------------------------------------------------------------


def test_lookup_asks_for_fifty_objects_a_request_politely(net: respx.MockRouter) -> None:
    route = mock_lookup(net, {})
    waits: list[float] = []
    client = nominatim(waits)
    idents = [f"way/{n}" for n in range(1, 61)] + ["node/2", "relation/3", "not-an-id"]
    assert client.lookup(idents) == {}
    assert route.call_count == 2 and client.calls == 2
    first = route.calls[0].request
    assert first.url.params["format"] == "jsonv2"
    assert first.headers["User-Agent"] == UA
    assert len(first.url.params["osm_ids"].split(",")) == LOOKUP_BATCH
    assert route.calls[1].request.url.params["osm_ids"].split(",")[-2:] == ["N2", "R3"]
    assert waits and all(wait > 0 for wait in waits)  # one request a second


def test_lookup_reads_each_objects_class(net: respx.MockRouter) -> None:
    mock_lookup(net)
    found = nominatim().lookup(["relation/295355", "way/4005061", "way/999"])
    assert set(found) == {"relation/295355", "way/4005061"}
    assert (found["relation/295355"].category, found["relation/295355"].kind) == (
        "boundary",
        "administrative",
    )
    assert found["way/4005061"].name == "Wilberforce Road"


@pytest.mark.parametrize("status, error", [(429, NominatimBlocked), (503, NominatimUnavailable)])
def test_lookup_without_an_answer_raises(net: respx.MockRouter, status: int, error) -> None:
    net.get(f"{NOMINATIM}/lookup").respond(status)
    with pytest.raises(error):
        nominatim().lookup(["way/1"])


# --- classification ----------------------------------------------------------------------------


@pytest.mark.parametrize(
    "category, kind, addresstype, level",
    [
        ("boundary", "administrative", "city", "area"),
        ("place", "city", None, "area"),
        ("place", "town", None, "area"),
        ("highway", "residential", "road", "street"),
        ("highway", "pedestrian", None, "street"),
        ("railway", "station", None, "street"),
        ("place", "square", None, None),
        ("building", "university", None, None),
        ("amenity", "pub", None, None),
        ("leisure", "park", None, None),
    ],
)
def test_an_osm_class_says_whether_a_venue_is_a_place_to_go(
    category: str, kind: str, addresstype: str | None, level: str | None
) -> None:
    assert coarse_level(category, kind, addresstype) == level


def test_a_venue_is_the_street_itself_only_by_its_name() -> None:
    assert is_itself(WILBERFORCE, "Wilberforce Road")
    assert is_itself(CAMBRIDGE, "Cambridge")
    assert not is_itself(HIDDEN_ROOMS, "Jesus Lane")
    assert not is_itself(HIDDEN_ROOMS, None)


def test_venues_are_classified_by_lookup_and_the_answers_kept(net: respx.MockRouter) -> None:
    route = mock_lookup(net)
    trinity_hall = VenueRow(
        key="ven-trinity-hall",
        name="Trinity Hall",
        lat=52.2056,
        lng=0.1144,
        osm_url=osm_url(TRINITY_HALL),
    )
    camdram = VenueRow(key="ven-adc-theatre", name="ADC Theatre", lat=52.2079, lng=0.1203)
    state: dict[str, Any] = {}
    out = classify_venues(
        [*COARSE_VENUES, trinity_hall, camdram],
        state=state,
        now=NOW,
        nominatim=nominatim(),
        gazetteer=GAZETTEER,
    )
    assert out.coarse == CLASSES
    # One request; the gazetteer's object and a venue with no OSM object
    # are never asked for.
    assert route.call_count == 1 and out.calls == 1
    asked = route.calls.last.request.url.params["osm_ids"].split(",")
    assert sorted(asked) == sorted(LOOKUP)
    assert out.from_gazetteer == 1 and out.looked_up == len(COARSE_VENUES)
    assert state[CAMBRIDGE.key] == {
        "osm": "relation/295355",
        "class": "boundary",
        "type": "administrative",
        "addresstype": None,
        "name": "Cambridge",
        "checkedAt": "2026-11-24",
    }

    # The next run asks nothing; after RECHECK_DAYS it asks again.
    again = classify_venues(COARSE_VENUES, state=state, now=NOW, nominatim=nominatim())
    assert again.coarse == CLASSES and again.calls == 0 and route.call_count == 1
    later = NOW + timedelta(days=RECHECK_DAYS + 1)
    classify_venues(COARSE_VENUES, state=state, now=later, nominatim=nominatim())
    assert route.call_count == 2


def test_an_unanswered_lookup_leaves_the_venues_trusted_and_uncached(
    net: respx.MockRouter,
) -> None:
    net.get(f"{NOMINATIM}/lookup").respond(503)
    state: dict[str, Any] = {}
    out = classify_venues([CAMBRIDGE], state=state, now=NOW, nominatim=nominatim())
    assert out.coarse == {} and state == {}
    assert any("did not answer" in note for note in out.notes)
    # A dry run (no Nominatim): the cache only, never a request.
    dry = classify_venues([CAMBRIDGE], state=state, now=NOW, nominatim=None)
    assert dry.coarse == {} and "not classified" in dry.notes[0]


# --- the resolver: the production rows ---------------------------------------------------------


def run_with(tmp_path, net: respx.MockRouter, fake, *, answers=None, **kwargs: Any):
    mock_nominatim(net, answers or {})
    mock_photon(net, {})
    mock_postcodes(net, {})
    return chain(
        tmp_path,
        fake,
        venues=kwargs.pop("venues", [*KNOWN, *COARSE_VENUES]),
        venue_classes=kwargs.pop("venue_classes", CLASSES),
        gazetteer=kwargs.pop("gazetteer", GAZETTEER),
        **kwargs,
    )


def test_the_city_itself_is_an_area_never_exact(tmp_path, net: respx.MockRouter) -> None:
    fake = FakeLLM(
        reply(precision="exact", venue_key="ven-cambridge", building={"name": "Cambridge"})
    )
    run = run_with(tmp_path, net, fake)
    item = event(venueText="Cambridge, UK")
    [row] = run.resolve([item])
    assert (row.precision, row.venue_key) == ("area", "ven-cambridge")
    assert row.area_label == "Cambridge (exact place not known)" and row.room is None
    # Rows at a coarse venue carry the resolver version (`due`).
    assert row.input_hash == f"{input_hash(item, PROMPT_NAME)}:{RESOLVER_VERSION}"


def test_a_venue_text_naming_the_city_never_matches_it_by_name(
    tmp_path, net: respx.MockRouter
) -> None:
    fake = FakeLLM(reply(precision="area", area_label="Central Cambridge"))
    run = run_with(tmp_path, net, fake)
    [row] = run.resolve([event(venueText="Cambridge")])
    assert row.method == "llm", "not an alias match on ven-cambridge"
    assert len(fake.calls) == 1


def test_a_named_building_wins_over_the_city(tmp_path, net: respx.MockRouter) -> None:
    fake = FakeLLM(
        reply(
            precision="exact",
            venue_key="ven-cambridge",
            building={
                "name": "BrewBoard",
                "address": "4-5 Peas Hill, Cambridge CB2 3PN",
                "osm_query": "BrewBoard, Peas Hill, Cambridge",
            },
            room="BrewBoard, 4-5 Peas Hill",
        )
    )
    answers = {"BrewBoard, Peas Hill, Cambridge": [osm("BrewBoard", 52.2042, 0.1183, 77)]}
    run = run_with(tmp_path, net, fake, answers=answers)
    item = event(venueText="BrewBoard, 4-5 Peas Hill, Cambridge CB2 3P")
    [row] = run.resolve([item])
    assert (row.precision, row.venue_key, row.room) == ("exact", "ven-brewboard", None)
    assert row.input_hash == input_hash(item, PROMPT_NAME)  # a fine venue: no version


def test_the_venue_text_names_the_college_when_the_model_named_the_city(
    tmp_path, net: respx.MockRouter
) -> None:
    text = "Bridgetower Room, Trinity Hall Cambridge, Trinity Ln"
    fake = FakeLLM(
        reply(
            precision="exact",
            venue_key="ven-cambridge",
            building={"name": "Cambridge"},
            room=text,
        )
    )
    run = run_with(tmp_path, net, fake)
    [row] = run.resolve([event(venueText=text)])
    assert (row.precision, row.venue_key) == ("exact", "ven-trinity-hall")
    assert row.room == "Bridgetower Room"


@pytest.mark.parametrize(
    "building",
    [
        {"name": "Centre for Mathematical Sciences", "address": "Wilberforce Road, CB3 0WA"},
        {"name": "Wilberforce Road"},
    ],
)
def test_a_room_at_cms_is_not_at_wilberforce_road(
    tmp_path, net: respx.MockRouter, building: dict[str, str]
) -> None:
    fake = FakeLLM(
        reply(
            precision="exact",
            venue_key="ven-wilberforce-road",
            building=building,
            room="MR15, CMS, Wilberforce Road",
        )
    )
    run = run_with(tmp_path, net, fake)
    [row] = run.resolve([talk(venue="MR15, CMS, Wilberforce Road")])
    assert (row.precision, row.venue_key) == ("exact", "ven-centre-for-mathematical-sciences")
    assert row.room == "MR15"


def test_the_osm_query_finds_the_building_on_a_street(tmp_path, net: respx.MockRouter) -> None:
    query = "McDonald Institute for Archaeological Research, Downing Street, Cambridge"
    fake = FakeLLM(
        reply(
            precision="exact",
            venue_key="ven-downing-street",
            building={
                "name": "Downing Street",
                "address": "Downing Street, Cambridge CB2 3ER",
                "osm_query": query,
            },
            room="Seminar Room",
        )
    )
    institute = osm("McDonald Institute for Archaeological Research", 52.2027, 0.1207, 88)
    run = run_with(tmp_path, net, fake, answers={query: [institute]})
    [row] = run.resolve([talk(venue="Seminar Room, McDonald Institute")])
    assert row.precision == "exact"
    assert row.venue_key == "ven-mcdonald-institute-for-archaeological-research"
    assert row.room == "Seminar Room"


def test_a_street_with_nothing_better_is_a_building_at_most(
    tmp_path, net: respx.MockRouter
) -> None:
    fake = FakeLLM(
        reply(
            precision="exact",
            venue_key="ven-topsham-road",
            building={"name": "Topsham Road", "country": "GB"},
            outside_cambridge=True,
        )
    )
    run = run_with(tmp_path, net, fake)
    [row] = run.resolve([event(venueText="Topsham Road")])
    assert (row.precision, row.venue_key) == ("building", "ven-topsham-road")


def test_a_region_is_an_area(tmp_path, net: respx.MockRouter) -> None:
    fake = FakeLLM(reply(precision="exact", venue_key="ven-greater-london"))
    run = run_with(tmp_path, net, fake)
    [row] = run.resolve([event(venueText="London")])
    assert (row.precision, row.venue_key) == ("area", "ven-greater-london")
    assert row.area_label == "Greater London (exact place not known)"


def test_a_building_placed_at_its_streets_point_keeps_its_name(
    tmp_path, net: respx.MockRouter
) -> None:
    run = run_with(tmp_path, net, FakeLLM(reply(precision="unknown")))
    [row] = run.resolve([event(venueText="Hidden Rooms")])
    assert (row.method, row.venue_key, row.precision) == ("alias", "ven-hidden-rooms", "building")


def test_coarse_venues_are_left_out_of_the_shortlist_and_matching() -> None:
    hidden = [key for key, found in CLASSES.items() if found.itself]
    index = VenueIndex.of([*KNOWN, *COARSE_VENUES], hidden=hidden)
    shortlist = {row.key for row in index.shortlist(event(venueText="Wilberforce Road, Cambridge"))}
    assert not shortlist & set(hidden)
    assert index.by_name("Downing Street") is None and index.match("Cambridge") is None
    assert index.get("ven-cambridge") is CAMBRIDGE  # by key still
    assert index.by_name("Hidden Rooms") is HIDDEN_ROOMS


def test_places_skips_an_area(tmp_path, net: respx.MockRouter) -> None:
    from camsocs_pipeline.locate.places import Places

    route = net.post(url__startswith="https://places.googleapis.com/").respond(
        200, json={"places": []}
    )
    places = Places(api_key="test-key", user_agent=UA)
    run = run_with(tmp_path, net, None, venues=[CAMBRIDGE, GREATER_LONDON], places=places)
    run.place_ids()
    assert not route.called


# --- re-resolution ------------------------------------------------------------------------------


def stored(item: PendingItem, **row: Any) -> PendingItem:
    return PendingItem.model_validate({**wire(item), "stored": {"startsAt": STARTS, **row}})


def test_rows_at_coarse_venues_are_due_and_fixed_from_the_cached_reply(
    tmp_path, net: respx.MockRouter
) -> None:
    text = "Bridgetower Room, Trinity Hall Cambridge, Trinity Ln"
    item = event(venueText=text)
    digest = input_hash(item, PROMPT_NAME)
    model_reply = reply(
        precision="exact", venue_key="ven-cambridge", building={"name": "Cambridge"}, room=text
    )
    # Run 2 answered and cached the reply, and posted the row at Cambridge.
    first = FakeLLM(model_reply)
    run_with(tmp_path, net, first, venue_classes={}).resolve([item])
    assert len(first.calls) == 1
    wrong = stored(item, inputHash=digest, precision="exact", venueKey="ven-cambridge")
    fine = stored(
        event("evt-fine", venueText="ADC Theatre"),
        inputHash=input_hash(event("evt-fine", venueText="ADC Theatre"), PROMPT_NAME),
        precision="exact",
        venueKey="ven-adc-theatre",
    )
    assert stage.due([wrong, fine], CLASSES) == ([wrong], 1)
    # Without the classification it would look fine.
    assert stage.due([wrong, fine]) == ([], 2)

    again = FakeLLM(model_reply)
    [row] = run_with(tmp_path, net, again).resolve([wrong])
    assert again.calls == [], "no new model call"
    assert (row.venue_key, row.precision, row.room) == (
        "ven-trinity-hall",
        "exact",
        "Bridgetower Room",
    )
    # Posted at a fine venue: it is no longer due.
    fixed = stored(item, inputHash=row.input_hash, precision="exact", venueKey="ven-trinity-hall")
    assert stage.due([fixed], CLASSES) == ([], 1)


def test_a_row_that_stays_at_an_area_is_not_due_again(tmp_path, net: respx.MockRouter) -> None:
    item = event(venueText="Cambridge, UK")
    fake = FakeLLM(
        reply(precision="exact", venue_key="ven-cambridge", building={"name": "Cambridge"})
    )
    [row] = run_with(tmp_path, net, fake).resolve([item])
    posted = stored(item, inputHash=row.input_hash, precision="area", venueKey="ven-cambridge")
    assert stage.due([posted], CLASSES) == ([], 1)


def test_the_stage_classifies_venues_and_fixes_their_rows(
    make_settings, tmp_path, net: respx.MockRouter, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = FakeLLM(reply(precision="unknown"))
    monkeypatch.setattr(stage, "LLMClient", lambda _settings: fake)
    monkeypatch.setattr(type(make_settings()), "require_llm", lambda _self: None)
    item = event(venueText="Cambridge, UK")
    digest = input_hash(item, PROMPT_NAME)
    settings = make_settings(nominatim_url=NOMINATIM)
    LLMMemo(settings.cache_dir / "llm").put(
        PROMPT_NAME,
        digest,
        LocateReply(precision="exact", venue_key="ven-cambridge", building={"name": "Cambridge"}),
        "gpt-6-luna",
    )
    items = [
        {
            **wire(item),
            "stored": {
                "inputHash": digest,
                "precision": "exact",
                "venueKey": "ven-cambridge",
                "startsAt": STARTS,
            },
        }
    ]
    venues = [v.model_dump(by_alias=True, exclude_none=True) for v in [*KNOWN, CAMBRIDGE]]
    routes = convex(net, items, venues)
    lookup = mock_lookup(net)
    mock_nominatim(net, {})
    report = RunReport(run_key="20261124T090000Z-abcdef", command="sync", dry_run=False)
    state = SyncState()
    ctx = StageContext(
        settings=settings,
        report=report.stage("locate"),
        run=report,
        loader=ConvexLoader(SITE, "test-key", dry_run=False),
        state=state,
        staging=StagingStore(tmp_path / "staging"),
        dry_run=False,
        limit=None,
    )
    stage.run(ctx, now=NOW)
    assert lookup.call_count == 1
    assert lookup.calls.last.request.url.params["osm_ids"] == "R295355"
    [row] = json.loads(routes["batch"].calls.last.request.content)["locations"]
    assert (row["precision"], row["venueKey"]) == ("area", "ven-cambridge")
    assert row["areaLabel"] == "Cambridge (exact place not known)"
    assert row["inputHash"] == f"{digest}:{RESOLVER_VERSION}"
    assert fake.calls == [], "the cached reply, no model call"
    assert ctx.report.metrics["coarseVenues"] == 1
    assert state.data("locate")["venueClass"]["ven-cambridge"]["class"] == "boundary"


# --- rooms ----------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "room, venue, cleaned",
    [
        ("BrewBoard, 4-5 Peas Hill", "BrewBoard", None),
        (
            "Bridgetower Room, Trinity Hall Cambridge, Trinity Ln",
            "Trinity Hall",
            "Bridgetower Room",
        ),
        ("MR15, CMS, Wilberforce Road", "Centre for Mathematical Sciences", "MR15"),
        ("Room G.15, Cambridge CB2 3P", "Quokka Building", "Room G.15"),
        ("Old Library, CB2 1RF", "Pembroke College", "Old Library"),
        ("Upper Hall, Jesus Lane", "Jesus College", "Upper Hall"),
        ("Seminar Room 1, Isaac Newton Institute", "Isaac Newton Institute", "Seminar Room 1"),
        ("LT1", "Mill Lane Lecture Rooms", "LT1"),
        ("Fellows' Garden", "Clare College", "Fellows' Garden"),
        ("1st Floor Seminar Room", "Quokka Building", "1st Floor Seminar Room"),
        ("ADC", "ADC Theatre", None),
        ("Cambridge, UK", "Quokka Building", None),
    ],
)
def test_a_room_is_never_the_building_an_address_or_a_postcode(
    room: str, venue: str, cleaned: str | None
) -> None:
    assert clean_room(room, venue) == cleaned
