"""Build the committed Cambridge gazetteer (`locate/data/cambridge_places.json`)
from OpenStreetMap through the Overpass API (source-research §23,
docs/locations-and-map.md §2 step 4).

`pixi run locate-gazetteer` sends **one** Overpass query for the named
University, college and department buildings (and the University's nameless
buildings that carry an `occupier`), research institutes, halls, theatres,
churches, libraries, sports grounds and the named pubs, bars, cafés and
restaurants of Cambridge. It writes each feature's OSM type and id, its
`name` (else the department its `occupier` names, `nameFrom: "occupier"`),
its other names (`alt_name`, `old_name`, `short_name`, `official_name`,
`loc_name`, `name:en` and the `occupier` departments), `operator`, kind,
address and point (a way's or relation's centre). The `locate` stage reads
the file before it asks Nominatim (`locate/gazetteer.py`): a Cambridge
building whose OSM name the model does not write (the Faculty of Music is
"11 West Road") is found without a request.

The data is OpenStreetMap's, under the ODbL ("© OpenStreetMap
contributors", credited on `/map`); the file records where and when it was
read. Overpass's usage policy asks for few, cached queries and an
identifying User-Agent: one query a build, rebuilt by hand now and then.
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx

from camsocs_pipeline.locate.gazetteer import lookup_name
from camsocs_pipeline.locate.model import CAMBRIDGE_BOUNDS, CAMBRIDGE_REGION, Bounds

logger = logging.getLogger(__name__)

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
DATA_DIR = Path(__file__).parent / "data"
PLACES_PATH = DATA_DIR / "cambridge_places.json"
TIMEOUT = 240.0
FALLBACK_USER_AGENT = "camsocs-bot/0.1 (+https://camsocs.uk/about)"

#: OSM tags whose values are other names of the same object.
ALT_NAME_TAGS = ("alt_name", "old_name", "short_name", "official_name", "loc_name", "name:en")
#: The tag that says what a feature is, in this order (`kind`).
KIND_TAGS = (
    "amenity",
    "office",
    "leisure",
    "tourism",
    "club",
    "healthcare",
    "shop",
    "craft",
    "indoor",
    "entrance",
    "highway",
    "barrier",
    "man_made",
    "emergency",
    "natural",
    "place",
    "landuse",
    "historic",
    "building",
)
#: Features that are no place to hold an event (a bin, a car park, a door),
#: by `kind`; and kinds dropped whatever their value.
DROP_KINDS = frozenset(
    f"amenity={value}"
    for value in (
        "recycling",
        "parking",
        "parking_entrance",
        "parking_space",
        "bicycle_parking",
        "bicycle_rental",
        "motorcycle_parking",
        "waste_basket",
        "waste_disposal",
        "bench",
        "vending_machine",
        "post_box",
        "letter_box",
        "atm",
        "toilets",
        "telephone",
        "drinking_water",
        "parcel_locker",
        "charging_station",
        "fountain",
        "clock",
        "shelter",
        "grit_bin",
        "smoking_area",
        "loading_dock",
        "bicycle_repair_station",
        "compressed_air",
    )
)
DROP_KEYS = frozenset(
    {"indoor", "entrance", "highway", "barrier", "man_made", "emergency", "natural", "place"}
)

_AMENITIES = (
    "university|college|research_institute|theatre|arts_centre|community_centre|"
    "place_of_worship|library|conference_centre|events_venue|exhibition_centre|cinema|"
    "concert_hall|music_venue|nightclub|social_centre|social_facility|townhall|hospital|"
    "school|pub|bar|cafe|restaurant|biergarten"
)
_LEISURE = (
    "sports_centre|stadium|pitch|sports_hall|fitness_centre|swimming_pool|golf_course|"
    "track|park|recreation_ground|ice_rink|marina"
)
_BUILDINGS = "university|college|church|chapel|cathedral|civic|public|government|hospital"


def _bbox(bounds: Bounds) -> str:
    """Overpass's ``(south,west,north,east)``."""
    return f"{bounds.south:g},{bounds.west:g},{bounds.north:g},{bounds.east:g}"


def overpass_query(city: Bounds = CAMBRIDGE_BOUNDS, region: Bounds = CAMBRIDGE_REGION) -> str:
    """The one Overpass QL query: University-operated features in the
    Cambridge region (Madingley, Hinxton, the West Cambridge site), every
    other kind inside the city box."""
    town = _bbox(city)
    wide = _bbox(region)
    parts = [
        f'nwr["name"]["operator"~"University of Cambridge|Cambridge University",i]({wide});',
        f'nwr["name"]["amenity"~"^(university|college|research_institute)$"]({wide});',
        f'nwr["name"]["office"~"^(educational_institution|research|university)$"]({wide});',
        f'nwr["name"]["amenity"~"^({_AMENITIES})$"]({town});',
        f'nwr["name"]["building"~"^({_BUILDINGS})$"]({town});',
        f'nwr["name"]["leisure"~"^({_LEISURE})$"]({town});',
        f'nwr["name"]["tourism"~"^(museum|gallery|hotel|attraction)$"]({town});',
        f'nwr["name"]["club"]({town});',
        f'nwr["name"]["landuse"="education"]({wide});',
        # University buildings often carry no `name`, only the department
        # that occupies them ("occupier=Department of Land Economy").
        f'nwr["building"]["occupier"]({wide});',
    ]
    body = "\n  ".join(parts)
    return f"[out:json][timeout:{int(TIMEOUT) - 30}];\n(\n  {body}\n);\nout center tags;"


def _address(tags: dict[str, str]) -> str | None:
    """ "11 West Road, Cambridge CB3 9DP" from the `addr:*` tags."""
    street = " ".join(
        part for part in (tags.get("addr:housenumber"), tags.get("addr:street")) if part
    )
    if not street:
        street = tags.get("addr:place") or ""
    town = tags.get("addr:city") or ("Cambridge" if street else "")
    tail = " ".join(part for part in (town, tags.get("addr:postcode")) if part)
    out = ", ".join(part for part in (street, tail) if part)
    return out or None


def _kind(tags: dict[str, str]) -> str | None:
    for key in KIND_TAGS:
        value = tags.get(key)
        if value and not (key == "building" and value == "yes"):
            return f"{key}={value}"
    return "building=yes" if tags.get("building") else None


def _names(tags: dict[str, str], name: str) -> list[str]:
    out: list[str] = []
    for tag in ALT_NAME_TAGS:
        for value in (tags.get(tag) or "").split(";"):
            value = " ".join(value.split())
            # Not a placeholder or the University itself ("TBA" on Heycock
            # Wing, "Cambridge University"): `gazetteer.lookup_name`.
            if value and value != name and value not in out and lookup_name(value):
                out.append(value)
    return out


def occupiers(tags: dict[str, str]) -> list[str]:
    """The departments an OSM `occupier` tag names, without the parts of the
    building they use: "Faculty of Music (Admin Offices; Custodian's
    Office)" → ["Faculty of Music"]."""
    text = re.sub(r"\([^)]*\)", " ", tags.get("occupier") or "")
    out: list[str] = []
    for part in text.split(";"):
        part = " ".join(part.split()).strip(" ,-")
        if part and part not in out:
            out.append(part)
    return out


def place_of(element: dict[str, Any]) -> dict[str, Any] | None:
    """One gazetteer entry from an Overpass element, or None (no name, no
    point, no venue). A building with no `name` is named by the first
    department its `occupier` tag gives (`nameFrom: "occupier"`)."""
    tags = element.get("tags")
    if not isinstance(tags, dict):
        return None
    name = " ".join(str(tags.get("name") or "").split())
    held = occupiers(tags)
    name_from = "name"
    if not name and held:
        name, name_from = held[0], "occupier"
    if not name:
        return None
    osm_type = element.get("type")
    if osm_type not in ("node", "way", "relation"):
        return None
    if osm_type == "node":
        lat, lng = element.get("lat"), element.get("lon")
    else:
        center = element.get("center") or {}
        lat, lng = center.get("lat"), center.get("lon")
    if not isinstance(lat, int | float) or not isinstance(lng, int | float):
        return None
    kind = _kind(tags)
    if kind is None or kind in DROP_KINDS or kind.split("=", 1)[0] in DROP_KEYS:
        # No tag saying what it is (a label node, a door) or no venue.
        return None
    entry: dict[str, Any] = {
        "osmType": osm_type,
        "osmId": int(element["id"]),
        "name": name,
        "altNames": [*_names(tags, name), *(o for o in held if o != name and lookup_name(o))],
        "operator": tags.get("operator") or None,
        "kind": kind,
        "address": _address(tags),
        "lat": round(float(lat), 6),
        "lng": round(float(lng), 6),
    }
    if name_from != "name":
        entry["nameFrom"] = name_from
    return entry


def build(elements: Iterable[dict[str, Any]], *, retrieved_at: datetime) -> dict[str, Any]:
    """The file's content: metadata and the places, sorted and de-duplicated."""
    seen: set[tuple[str, int]] = set()
    places: list[dict[str, Any]] = []
    for element in elements:
        entry = place_of(element)
        if entry is None:
            continue
        ident = (entry["osmType"], entry["osmId"])
        if ident in seen:
            continue
        seen.add(ident)
        places.append(entry)
    places.sort(key=lambda p: (p["name"].lower(), p["osmType"], p["osmId"]))
    return {
        "source": "OpenStreetMap via the Overpass API (" + OVERPASS_URL + ")",
        "licence": "ODbL 1.0, © OpenStreetMap contributors",
        "retrievedAt": retrieved_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "bounds": {
            "city": _bbox(CAMBRIDGE_BOUNDS),
            "region": _bbox(CAMBRIDGE_REGION),
        },
        "places": places,
    }


def fetch(user_agent: str, *, url: str = OVERPASS_URL, client: httpx.Client | None = None) -> Any:
    """The Overpass answer's elements (one POST)."""
    own = client is None
    http = client or httpx.Client(timeout=TIMEOUT)
    try:
        response = http.post(
            url, data={"data": overpass_query()}, headers={"User-Agent": user_agent}
        )
        response.raise_for_status()
        payload = response.json()
    finally:
        if own:
            http.close()
    elements = payload.get("elements") if isinstance(payload, dict) else None
    if not isinstance(elements, list):
        raise RuntimeError("Overpass answered without an `elements` list")
    return elements


def write(content: dict[str, Any], path: Path = PLACES_PATH) -> int:
    """Write one entry per line (a reviewable diff); the byte size."""
    lines = [json.dumps(place, ensure_ascii=False, sort_keys=True) for place in content["places"]]
    head = {key: value for key, value in content.items() if key != "places"}
    text = json.dumps(head, ensure_ascii=False, indent=2, sort_keys=True)[:-2]
    text += ',\n  "places": [\n    ' + ",\n    ".join(lines) + "\n  ]\n}\n"
    json.loads(text)  # the file must stay valid JSON
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return len(text.encode("utf-8"))


def _user_agent() -> str:
    try:
        from camsocs_pipeline.config import get_settings

        return get_settings().require_user_agent()
    except Exception:  # no env file: the documented crawler's identity
        return FALLBACK_USER_AGENT


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, default=PLACES_PATH)
    parser.add_argument("--url", default=OVERPASS_URL)
    parser.add_argument("--print-query", action="store_true")
    args = parser.parse_args(argv)
    if args.print_query:
        print(overpass_query())
        return 0
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    elements = fetch(_user_agent(), url=args.url)
    content = build(elements, retrieved_at=datetime.now(UTC))
    size = write(content, args.out)
    logger.info("gazetteer: %d places, %d bytes → %s", len(content["places"]), size, args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
