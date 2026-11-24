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

from pydantic import BaseModel, ConfigDict, Field
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


#: Cambridge (webapp/lib/events.ts `CAMBRIDGE_BOUNDS`): a geocoded result
#: outside it is refused, whatever its name.
CAMBRIDGE_BOUNDS = Bounds(south=52.15, north=52.26, west=0.03, east=0.22)


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


# --- the model's reply (extract/prompts/locate_v1.md) ------------------------------------


class NewVenue(BaseModel):
    model_config = ConfigDict(extra="ignore")

    #: The building's canonical name ("Faculty of Economics").
    name: str | None = None
    #: Its street address with a postcode, where known.
    address: str | None = None
    #: What to search OpenStreetMap for ("Austin Robinson Building, Sidgwick Avenue, Cambridge").
    osm_query: str | None = None


class LocateReply(BaseModel):
    """Where one event or talk takes place, as the model reads it."""

    model_config = ConfigDict(extra="ignore")

    decision: Literal["existing", "new", "online", "unknown"]
    #: `existing`: the key of one of the listed known venues.
    venue_key: str | None = None
    #: `new`: the building, to look up on OpenStreetMap.
    new_venue: NewVenue | None = None
    #: The enclosing building (a college, a department) when the room's own
    #: building may not be on the map: the fallback, at `building` precision.
    parent: NewVenue | None = None
    #: A room inside the building ("Seminar Room 1"); never a person's name.
    room: str | None = None
    #: Read as `exact` when left out.
    precision: Precision | None = None
    #: `area`: the area as the listing states it.
    area_label: str | None = None
    #: `unknown`: why, in a few words.
    note: str | None = None


__all__ = [
    "CAMBRIDGE_BOUNDS",
    "LIMITS",
    "VENUE_ADDRESS_MAX",
    "VENUE_NAME_MAX",
    "Bounds",
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
