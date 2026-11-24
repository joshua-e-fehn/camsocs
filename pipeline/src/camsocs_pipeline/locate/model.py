"""The shapes the `locate` stage reads and writes (docs/locations-and-map.md
§1b–§1c, §2): the pipeline's half of the validators in
webapp/convex/ingest/locations.ts, and the model's reply.

Read models ignore unknown fields (the server may add one); the row the
stage posts forbids them, like every `WireModel`, so a typo fails here
rather than as a 400.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic.alias_generators import to_camel

from camsocs_pipeline.models.vocab import (
    ITEM_LOCATION_KINDS,
    ITEM_LOCATION_METHODS,
    ITEM_LOCATION_PRECISIONS,
    Vocab,
)
from camsocs_pipeline.models.wire import WireModel

ItemKindStr = Vocab(ITEM_LOCATION_KINDS)
PrecisionStr = Vocab(ITEM_LOCATION_PRECISIONS)
MethodStr = Vocab(ITEM_LOCATION_METHODS)

Precision = Literal["exact", "building", "area", "online", "unknown"]

#: Text limits of an `itemLocations` row (convex/lib/locations.ts `LOCATION_LIMITS`).
LIMITS = {"room": 120, "areaLabel": 120, "note": 200, "model": 100, "promptVersion": 40}
#: Venue text limits (convex/lib/fields.ts `VENUE_SPECS`).
VENUE_NAME_MAX = 200
VENUE_ADDRESS_MAX = 500

_READ = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")


@dataclass(frozen=True)
class Bounds:
    """A latitude/longitude rectangle."""

    south: float
    north: float
    west: float
    east: float

    def contains(self, lat: float, lng: float) -> bool:
        return self.south <= lat <= self.north and self.west <= lng <= self.east

    @property
    def viewbox(self) -> str:
        """Nominatim's ``viewbox=<x1>,<y1>,<x2>,<y2>`` (west, north, east, south)."""
        return f"{self.west:g},{self.north:g},{self.east:g},{self.south:g}"


#: Cambridge (webapp/lib/events.ts `CAMBRIDGE_BOUNDS`): a place the model
#: does not flag as outside Cambridge is searched for here first.
CAMBRIDGE_BOUNDS = Bounds(south=52.15, north=52.26, west=0.03, east=0.22)
#: Cambridge and its villages (Great Shelford, Hinxton, Madingley, Gog
#: Magog): the widest a place not flagged outside Cambridge may be, and the
#: box `/map` draws pins in (webapp/lib/map-style.ts `MAP_PIN_BOUNDS`).
CAMBRIDGE_REGION = Bounds(south=52.05, north=52.35, west=-0.10, east=0.35)


# --- reads ------------------------------------------------------------------------------------


class StoredLocation(BaseModel):
    model_config = _READ
    input_hash: str
    precision: str
    venue_key: str | None = None
    #: The start the row was written with (`itemLocations.startsAt`); a
    #: rescheduled item is due again so the row's coverage window follows it.
    starts_at: int | None = None


class PendingItem(BaseModel):
    """One item `locations/pending` returns (ingest/locations.ts `pendingItemValidator`)."""

    model_config = _READ
    kind: Literal["event", "talk"]
    item_key: str
    starts_at: int
    ends_at: int | None = None
    all_day: bool | None = None
    title: str
    #: ≤ 1,500 characters: an event's description, a talk's abstract.
    description: str | None = None
    #: Events: the (D1-redacted) venue text.
    venue_text: str | None = None
    #: Events: the source's own venue key.
    venue_key: str | None = None
    #: Talks: the venue as the source wrote it.
    venue: str | None = None
    #: Talks: whether the talk is online (it may be hybrid).
    online: bool | None = None
    organisers: list[str] = Field(default_factory=list)
    #: The places the organisers are known to use (≤ 6, optional: an older
    #: deployment does not send it): their college, their regular sessions'
    #: venues, a talk's departments.
    organiser_places: list[str] = Field(default_factory=list)
    source_type: str
    source_url: str | None = None
    stored: StoredLocation | None = None

    @property
    def place_text(self) -> str:
        """The venue as the item's source wrote it ("" when none)."""
        return ((self.venue_text if self.kind == "event" else self.venue) or "").strip()


class PendingPage(BaseModel):
    model_config = _READ
    page: list[PendingItem]
    continue_cursor: str
    is_done: bool


class VenueRow(BaseModel):
    """One venue `venues/all` returns."""

    model_config = _READ
    key: str
    name: str
    aliases: list[str] = Field(default_factory=list)
    address: str | None = None
    lat: float | None = None
    lng: float | None = None
    college_key: str | None = None
    google_place_id: str | None = None

    @property
    def placed(self) -> bool:
        """Whether the venue has coordinates (a pin on the map)."""
        return self.lat is not None and self.lng is not None


class VenuesPage(BaseModel):
    model_config = _READ
    page: list[VenueRow]
    continue_cursor: str
    is_done: bool


# --- writes ---------------------------------------------------------------------------------


class ItemLocationInput(WireModel):
    """One row for `locations/batch` (ingest/locations.ts `itemLocationInputValidator`)."""

    kind: ItemKindStr
    item_key: str
    starts_at: int
    precision: PrecisionStr
    venue_key: str | None = None
    room: str | None = None
    area_label: str | None = None
    note: str | None = None
    method: MethodStr
    model: str | None = None
    prompt_version: str | None = None
    input_hash: str


# --- the model's reply (extract/prompts/locate_v2.md) ------------------------------------

#: What a reply's `precision` may say, and the words a model uses for them.
_PRECISION_WORDS: dict[str, Precision] = {
    "exact": "exact",
    "existing": "exact",
    "new": "exact",
    "room": "exact",
    "building": "building",
    "inferred": "building",
    "approximate": "building",
    "area": "area",
    "region": "area",
    "town": "area",
    "city": "area",
    "online": "online",
    "virtual": "online",
    "remote": "online",
    "unknown": "unknown",
    "none": "unknown",
    "tbc": "unknown",
    "tba": "unknown",
}


def _blank_to_none(value: object) -> object:
    if isinstance(value, str) and not value.strip():
        return None
    return value


class Building(BaseModel):
    """A building as the model names it: what to look up, never a claimed
    value by itself (resolver.py)."""

    model_config = ConfigDict(extra="ignore")

    #: The building's name as it is known on a map ("William Gates Building").
    name: str | None = None
    #: Its street address with a postcode ("15 JJ Thomson Avenue, Cambridge CB3 0FD").
    address: str | None = None
    #: What to search OpenStreetMap for ("William Gates Building, JJ Thomson Avenue, Cambridge").
    osm_query: str | None = None
    #: The country, an ISO 3166-1 alpha-2 code or a name ("GB", "Belgium").
    country: str | None = None

    @model_validator(mode="before")
    @classmethod
    def _from_text(cls, data: object) -> object:
        # A bare string is the building's name.
        if isinstance(data, str):
            return {"name": data}
        if isinstance(data, dict):
            out = {key: _blank_to_none(value) for key, value in data.items()}
            for camel, snake in (("osmQuery", "osm_query"), ("query", "osm_query")):
                if camel in out and snake not in out:
                    out[snake] = out.pop(camel)
            return out
        return data

    @field_validator("name", "address", "osm_query", "country", mode="before")
    @classmethod
    def _text(cls, value: object) -> object:
        if value is None or isinstance(value, str):
            return value
        if isinstance(value, int | float):
            return str(value)
        return None

    @property
    def given(self) -> bool:
        return bool((self.name or "").strip() or (self.osm_query or "").strip())


#: The v1 name of a building (kept so the rest of the stage reads one shape).
NewVenue = Building


class LocateReply(BaseModel):
    """Where one event or talk takes place, as the model reads it
    (extract/prompts/locate_v2.md). Lenient on purpose: an unknown word, a
    string for a building, a camelCase key or a blank field is read rather
    than refused, so a usable reply never fails validation."""

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    #: exact | building | area | online | unknown (None: read from the rest).
    precision: Precision | None = None
    #: The building the item is in, always given unless online or unknown,
    #: even when `venue_key` names a known venue.
    building: Building | None = None
    #: One of the listed known venues, when the building is one of them.
    venue_key: str | None = None
    #: The enclosing building (a college, a department) when the building
    #: itself may not be on the map: the fallback, at `building` precision.
    parent: Building | None = None
    #: A room inside the building ("Seminar Room 1"); never a person's name.
    room: str | None = None
    #: `area` (and a `building` guess): the area as the listing states it.
    area_label: str | None = None
    #: The place is outside Cambridge (an away fixture, a tour, a conference):
    #: it is searched for worldwide.
    outside_cambridge: bool = False
    #: `unknown`: why, in a few words.
    note: str | None = None

    @model_validator(mode="before")
    @classmethod
    def _read(cls, data: object) -> object:
        if not isinstance(data, dict):
            return data
        out = {key: _blank_to_none(value) for key, value in data.items()}
        for camel, snake in (
            ("venueKey", "venue_key"),
            ("areaLabel", "area_label"),
            ("outsideCambridge", "outside_cambridge"),
            ("new_venue", "building"),
            ("newVenue", "building"),
        ):
            if camel in out and out.get(snake) is None:
                out[snake] = out.pop(camel)
        # v1's `decision`: online / unknown are precisions now.
        decision = out.pop("decision", None)
        if out.get("precision") is None and decision in ("online", "unknown"):
            out["precision"] = decision
        return out

    @field_validator("precision", mode="before")
    @classmethod
    def _precision(cls, value: object) -> object:
        if not isinstance(value, str):
            return None
        return _PRECISION_WORDS.get(value.strip().lower())

    @field_validator("outside_cambridge", mode="before")
    @classmethod
    def _flag(cls, value: object) -> bool:
        if isinstance(value, str):
            return value.strip().lower() in ("true", "yes", "1", "y")
        return bool(value)

    @field_validator("venue_key", "room", "area_label", "note", mode="before")
    @classmethod
    def _text(cls, value: object) -> object:
        return value if value is None or isinstance(value, str) else None

    @property
    def decision(self) -> Literal["existing", "new", "online", "unknown"]:
        """What the reply amounts to: online, unknown, a known venue's key, or a building."""
        if self.precision in ("online", "unknown"):
            return self.precision  # type: ignore[return-value]
        if self.venue_key:
            return "existing"
        if (self.building and self.building.given) or (self.parent and self.parent.given):
            return "new"
        return "new" if self.precision == "area" else "unknown"


__all__ = [
    "CAMBRIDGE_BOUNDS",
    "CAMBRIDGE_REGION",
    "LIMITS",
    "VENUE_ADDRESS_MAX",
    "VENUE_NAME_MAX",
    "Bounds",
    "Building",
    "ItemLocationInput",
    "LocateReply",
    "NewVenue",
    "PendingItem",
    "PendingPage",
    "Precision",
    "StoredLocation",
    "VenueRow",
    "VenuesPage",
]
