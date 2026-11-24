"""One `locate` run (docs/locations-and-map.md §2, source-research §23):
pending items in, venue claims and `itemLocations` rows out.

1. An item whose stored row carries its current input hash is skipped.
2. **Deterministic first** (`matching`): online only → `online`; an event's
   own venue key with coordinates → `source`/`exact`; the venue text naming a
   known venue exactly → `alias`/`exact`, with the room it adds.
3. **The model** (`extract/prompts/locate_v2.md`, bulk tier with the
   client's strong fallback, cached by input hash in `LLMMemo`) for the rest,
   shown the item, the organisers' usual places and a shortlist of known
   venues. talks.cam text may be given to it (decision D13); it reads only
   what Convex already stores. Its reply always names the building (name,
   address with postcode, OSM query, country), also when it picks a known
   venue's key: the venue is the key's when the key is known and fits the
   item, else the known venue of that name, else the geocoded building (an
   invalid key never loses the item).
4. **New venues** are looked up first in the committed gazetteer of
   Cambridge's OSM buildings (`gazetteer.py`: the building's name and OSM
   query, curated aliases such as "Faculty of Music" → "11 West Road"; a
   hit posts OSM's own values, so talks may use it), then geocoded
   (`geocode.py`): Nominatim inside Cambridge, then the Cambridge region,
   Photon, Nominatim's structured address search and postcodes.io (also as
   a check of a road it found); a place the model flags as outside
   Cambridge (an away fixture, a tour) is searched for worldwide in its
   country. A miss falls back to the enclosing building it named
   (`building` precision), else to a gazetteer building the venue text
   names (`building`), else the item is `unknown` with a note (its row's
   input hash carries `RESOLVER_VERSION`, so a later resolver looks it up
   again from the cached reply). A street or postcode point makes the item
   `building`, a town or district `area`: a town is posted as an area venue
   (`ven-area--<town>`, never reused as a building), and a venue made from
   a street or postcode point is remembered across runs (`coarse_venues`),
   so neither ever comes back `exact`. A known venue without coordinates
   is looked up the same way. Venues are posted as claims: OpenStreetMap's
   own name, address and coordinates (`osm_nominatim`), or a postcode's
   point (`postcodes_io`). Only when the source has no name for the object
   (a street, a postcode, a nameless building) is the model's building name
   posted, as an `inferred` model claim, and only when it reads as a
   building's name the item's own text gives: never a person's (an
   honorific, a link), never the item's title, never a name the item does
   not contain, and never for a talk or a talks.cam-derived event (G1).
5. **Place ids** (`google_places`): new venues and known ones without an id,
   at most `MAX_PLACES_CALLS` a run, each retried after `PLACES_RETRY_DAYS`;
   never for a venue outside the Cambridge region or an area venue.

An item the run cannot finish (a budget spent, OpenStreetMap or Places
unreachable or answering an error, a model error, a dry run without a cached
reply) gets no row: the next run tries again. Only "nothing is known" (the
model says so, or OpenStreetMap answered and found nothing) is written as
`unknown`.
"""

from __future__ import annotations

import logging
import re
import threading
import time
from collections.abc import Callable, Iterable, Mapping, MutableMapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from string import Template

from camsocs_pipeline.claims import NO_LLM_SOURCE_TYPES, build_claim, parser_field
from camsocs_pipeline.extract.events import redact_contacts
from camsocs_pipeline.extract.llm import LLMClient, LLMValidationError
from camsocs_pipeline.extract.memo import LLMMemo
from camsocs_pipeline.keys import venue_key
from camsocs_pipeline.locate.gazetteer import Gazetteer, GazetteerPlace
from camsocs_pipeline.locate.geocode import GeoBudget, GeocodeDeferred, Geocoder, GeoHit
from camsocs_pipeline.locate.matching import (
    PERSONISH,
    VenueIndex,
    area_venue_key,
    by_overlap,
    clean_room,
    distinctive,
    input_hash,
    is_area_key,
    is_online_only,
    normalise,
    single_line,
    tokens,
)
from camsocs_pipeline.locate.model import (
    CAMBRIDGE_REGION,
    LIMITS,
    VENUE_ADDRESS_MAX,
    VENUE_NAME_MAX,
    Building,
    ItemLocationInput,
    LocateReply,
    PendingItem,
    VenueRow,
)
from camsocs_pipeline.locate.nominatim import Nominatim
from camsocs_pipeline.locate.photon import Photon
from camsocs_pipeline.locate.places import Places, PlacesBlocked, PlacesUnavailable, place_url
from camsocs_pipeline.locate.postcodes import Postcodes, find_postcode
from camsocs_pipeline.locate.venue_class import Coarse
from camsocs_pipeline.locate.venue_name import venue_display_name
from camsocs_pipeline.models.observation import FieldObs
from camsocs_pipeline.models.wire import ClaimInput

logger = logging.getLogger(__name__)

PROMPT_NAME = "locate_v2"
#: The version of the lookups after the model (the gazetteer, the geocoding
#: chain). An `unknown` row records it in its input hash
#: (`row_input_hash`), so a new version looks those items up again from the
#: cached replies, without asking the model again (`stages/locate.due`).
#: r2 (2026-11-24): the Cambridge gazetteer, the postcode cross-check.
#: r3 (2026-11-24): coarse venues (a town, a district, a street: by their
#: OSM class, `venue_class.py`) are never `exact`; rows at one carry the
#: version too, so a later resolver may still find their building.
RESOLVER_VERSION = "r3"
PROMPT_PATH = Path(__file__).parent.parent / "extract" / "prompts" / f"{PROMPT_NAME}.md"

#: Budgets (§2 step 6): items asked of the model (cached replies are free),
#: Nominatim, Photon, postcodes.io and Places requests, and wall-clock seconds.
MAX_LLM_ITEMS = 1_200
MAX_NOMINATIM_CALLS = 500
MAX_PHOTON_CALLS = 200
MAX_POSTCODES_CALLS = 300
MAX_PLACES_CALLS = 100
TIME_BUDGET_S = 30 * 60
#: A venue Places found nothing for is asked again after this long.
PLACES_RETRY_DAYS = 30
#: How much of a description the model sees (the route sends ≤ 1,500).
MAX_DESCRIPTION = 1_500
#: The anchor of "central Cambridge" (§1b).
CENTRAL = Building(
    name="Market Square",
    address="Market Hill, Cambridge CB2 3NJ",
    osm_query="Market Square, Cambridge",
    country="GB",
)
#: Organisers' places the model is shown at most (the route sends ≤ 6).
MAX_ORGANISER_PLACES = 6
#: A model-given building name, when it is posted (no source has a name for
#: the object): at most this many words and characters, and no sentence.
MODEL_NAME_WORDS = 8
MODEL_NAME_CHARS = 80
_MODEL_NAME = re.compile(r"^[\w'’&.,()\- ]+$", re.UNICODE)
_LONG_NUMBER = re.compile(r"\d{5,}")

_LISTINGS = {
    "camdram": "Camdram (student theatre)",
    "talks_cam": "talks.cam (the University's talks listings)",
    "talks_list": "talks.cam (the University's talks listings)",
    "ics": "the organisation's own calendar feed",
    "google_calendar": "the organisation's own Google calendar",
    "luma": "the organisation's own Luma calendar",
    "playwaze": "Playwaze (college and University sport)",
    "uni_events_api": "the University's public events programme",
    "cucbc": "CUCBC (college rowing)",
    "su_whatson": "Cambridge SU What's On",
    "mailing_list": "a mail to the organisation's mailing list",
    "instagram_api": "the organisation's own Instagram post",
    "termcard": "the organisation's own termcard",
    "website": "the organisation's own website",
    "dept_ics": "a department's own calendar feed",
    "dept_rss": "a department's own news feed",
    "dept_json": "a department's own website",
    "dept_jsonld": "a department's own website",
    "dept_drupal": "a department's own website",
}


class Deferred(Exception):
    """This item cannot be finished in this run (budget, outage, dry run)."""


@dataclass
class Plan:
    """What an item's place is before venues are looked up: a reply of the
    model or of a deterministic rule, and how it was made."""

    reply: LocateReply
    method: str
    model: str | None = None


@dataclass
class Metrics:
    pending: int = 0
    unchanged: int = 0
    resolved: int = 0
    unknown: int = 0
    deferred: int = 0
    llm_calls: int = 0
    llm_cache_hits: int = 0
    llm_errors: int = 0
    new_venues: int = 0
    placed_venues: int = 0
    #: Venues named by the model because no source had a name for the object.
    model_named_venues: int = 0
    #: Rows whose venue lies outside the Cambridge region (away fixtures, tours).
    outside: int = 0
    #: Buildings found in the committed gazetteer (no request made).
    gazetteer_hits: int = 0
    #: Items due only because their row is at a coarse venue: re-resolved
    #: from the cached reply or the stored venue, never a new model call.
    revisited: int = 0
    by_method: dict[str, int] = field(default_factory=dict)
    by_precision: dict[str, int] = field(default_factory=dict)


@dataclass
class Budget:
    llm_items: int = MAX_LLM_ITEMS
    nominatim_calls: int = MAX_NOMINATIM_CALLS
    photon_calls: int = MAX_PHOTON_CALLS
    postcodes_calls: int = MAX_POSTCODES_CALLS
    places_calls: int = MAX_PLACES_CALLS
    seconds: float = TIME_BUDGET_S


class Locator:
    """Resolves pending items against the known venues.

    `llm` None: cached replies only (a dry run, or no model configured).
    `nominatim` None: no venue is looked up (new ones defer the item);
    `photon` / `postcodes` None: those steps of the chain are skipped.
    `places` None: no place ids (no key, or a dry run)."""

    def __init__(
        self,
        venues: Iterable[VenueRow],
        *,
        memo: LLMMemo,
        llm: LLMClient | None,
        nominatim: Nominatim | None,
        places: Places | None,
        now: datetime,
        photon: Photon | None = None,
        postcodes: Postcodes | None = None,
        places_tried: MutableMapping[str, str] | None = None,
        coarse_venues: MutableMapping[str, str] | None = None,
        budget: Budget | None = None,
        workers: int = 4,
        clock: Callable[[], float] = time.monotonic,
        gazetteer: Gazetteer | None = None,
        venue_classes: Mapping[str, Coarse] | None = None,
    ) -> None:
        #: Venue key → how a known venue is a town, a district or a street,
        #: by its OSM class (`venue_class.classify_venues`). One that *is*
        #: the town or street is reached by key only (`VenueIndex.hidden`).
        self.venue_classes: dict[str, Coarse] = dict(venue_classes or {})
        self.index = VenueIndex.of(
            venues, hidden=(key for key, found in self.venue_classes.items() if found.itself)
        )
        #: Cambridge's OSM buildings, looked up before Nominatim (None: skipped).
        self.gazetteer = gazetteer
        self.memo = memo
        self.llm = llm
        self.nominatim = nominatim
        self.places = places
        self.now = now
        self.places_tried = places_tried if places_tried is not None else {}
        #: Venue key → "street" / "postcode": venues this stage created (or
        #: placed) from a point near the building, not the building itself.
        #: Kept across runs (stage state), so an item reaching such a venue
        #: by key or name later is still `building`, never `exact`.
        self.coarse_venues = coarse_venues if coarse_venues is not None else {}
        self.budget = budget or Budget()
        self.workers = max(1, workers)
        self._clock = clock
        self._started = clock()
        self.geocoder = (
            Geocoder(
                nominatim,
                photon,
                postcodes,
                budget=GeoBudget(
                    nominatim=self.budget.nominatim_calls,
                    photon=self.budget.photon_calls,
                    postcodes=self.budget.postcodes_calls,
                ),
                out_of_time=self.out_of_time,
            )
            if nominatim is not None
            else None
        )
        self.template = Template(PROMPT_PATH.read_text(encoding="utf-8"))
        self.metrics = Metrics()
        self.notes: list[str] = []
        #: Venue key → claims to post (new venues, coordinates, place ids).
        self._claims: dict[str, list[ClaimInput]] = {}
        #: Lookups this run has a real geocoding answer for, by the building's
        #: venue key and how it was searched (outside Cambridge, an area
        #: wanted): the venue it gave and how much the hit pins down (None:
        #: nothing found). An unanswered lookup is not here.
        self._looked_up: dict[tuple[str, bool, bool], tuple[VenueRow, str] | None] = {}
        #: Known venues without coordinates looked up this run.
        self._placing: set[str] = set()
        #: Venue keys the rows of this run point at.
        self._used: set[str] = set()
        self._budget_notes: set[str] = set()
        self._outage_notes: set[str] = set()
        self._lock = threading.Lock()

    # -- the run -------------------------------------------------------------------------

    def out_of_time(self) -> bool:
        return self._clock() - self._started > self.budget.seconds

    def resolve(self, items: Sequence[PendingItem]) -> list[ItemLocationInput]:
        """Rows for `items` (already filtered: their stored hash differs)."""
        hashes = {id(item): input_hash(item, PROMPT_NAME) for item in items}
        plans: dict[int, Plan] = {}
        ask: list[PendingItem] = []
        for item in items:
            plan = deterministic(item, self.index)
            if plan is None and self._revisit(item, hashes[id(item)]):
                # Due only because its row sits at a coarse venue: the
                # cached reply, else the stored venue (set aside by `_row`
                # for a better building the venue text names, else `area`
                # or `building`). Never a new model call (the item never
                # had one: it matched the venue by name before).
                plan = self._cached(item, hashes[id(item)]) or Plan(
                    LocateReply(decision="existing", venue_key=item.stored.venue_key),  # type: ignore[union-attr]
                    "source" if item.stored.venue_key == item.venue_key else "alias",  # type: ignore[union-attr]
                )
                self.metrics.revisited += 1
            if plan is not None:
                plans[id(item)] = plan
            else:
                ask.append(item)
        for item, plan in zip(ask, self._ask(ask, hashes), strict=True):
            if plan is not None:
                plans[id(item)] = plan
        rows: list[ItemLocationInput] = []
        for item in items:
            plan = plans.get(id(item))
            if plan is None:
                self.metrics.deferred += 1
                continue
            try:
                row = self._row(item, plan, hashes[id(item)])
            except Deferred:
                self.metrics.deferred += 1
                continue
            if row.precision == "unknown" or self.classified_coarse(row.venue_key):
                row = row.model_copy(
                    update={
                        "input_hash": row_input_hash(
                            hashes[id(item)],
                            row.precision,
                            coarse=self.classified_coarse(row.venue_key),
                        )
                    }
                )
            rows.append(row)
            self._count(row)
        return rows

    def _count(self, row: ItemLocationInput) -> None:
        if row.precision == "unknown":
            self.metrics.unknown += 1
        else:
            self.metrics.resolved += 1
        self.metrics.by_method[row.method] = self.metrics.by_method.get(row.method, 0) + 1
        self.metrics.by_precision[row.precision] = (
            self.metrics.by_precision.get(row.precision, 0) + 1
        )
        if row.venue_key:
            self._used.add(row.venue_key)

    # -- the model -----------------------------------------------------------------------

    def _revisit(self, item: PendingItem, digest: str) -> bool:
        """Whether `item` is due only because its stored row is at a coarse
        venue still known (`classified_coarse`): the row was made from this
        very input (its hash is `digest`, with or without a version)."""
        stored = item.stored
        if stored is None or not self.classified_coarse(stored.venue_key):
            return False
        if self.index.get(stored.venue_key) is None:
            return False
        return _VERSION_SUFFIX.sub("", stored.input_hash) == digest

    def _cached(self, item: PendingItem, digest: str) -> Plan | None:
        cached = self.memo.get(PROMPT_NAME, digest, LocateReply)
        if cached is None:
            return None
        self.metrics.llm_cache_hits += 1
        return Plan(cached[0], "llm", cached[1])

    def _ask(self, items: Sequence[PendingItem], hashes: dict[int, str]) -> list[Plan | None]:
        """A plan per item from the memo or the model, in order; None when the
        item must wait (no reply cached and no model, a budget, an error)."""
        plans: list[Plan | None] = [None] * len(items)
        todo: list[int] = []
        for position, item in enumerate(items):
            cached = self.memo.get(PROMPT_NAME, hashes[id(item)], LocateReply)
            if cached is not None:
                self.metrics.llm_cache_hits += 1
                plans[position] = Plan(cached[0], "llm", cached[1])
            elif self.llm is not None:
                todo.append(position)
        if self.llm is None:
            return plans
        if len(todo) > self.budget.llm_items:
            self.notes.append(
                f"model budget: {len(todo) - self.budget.llm_items} items wait for the next run"
            )
            todo = todo[: self.budget.llm_items]

        def one(position: int) -> Plan | None:
            if self.out_of_time():
                return None
            item = items[position]
            messages = [{"role": "user", "content": self.render(item)}]
            try:
                try:
                    call = self.llm.complete_json(  # type: ignore[union-attr]
                        schema=LocateReply,
                        messages=messages,
                        prompt_version=PROMPT_NAME,
                        tier="bulk",
                    )
                except LLMValidationError as error:
                    # The client asks the strong model itself when it has a
                    # fallback (its error then carries a note); else once here.
                    if any("Fallback" in note for note in getattr(error, "__notes__", [])):
                        raise
                    call = self.llm.complete_json(  # type: ignore[union-attr]
                        schema=LocateReply,
                        messages=messages,
                        prompt_version=PROMPT_NAME,
                        tier="strong",
                    )
            except Exception as error:  # one item's failure never fails the run
                logger.warning(
                    "locate: model failed for %s (%s)", item.item_key, type(error).__name__
                )
                with self._lock:
                    self.metrics.llm_errors += 1
                return None
            with self._lock:
                self.metrics.llm_calls += 1
            self.memo.put(PROMPT_NAME, hashes[id(item)], call.value, call.model)
            return Plan(call.value, "llm", call.model)

        with ThreadPoolExecutor(max_workers=self.workers) as pool:
            for position, plan in zip(todo, pool.map(one, todo), strict=True):
                plans[position] = plan
        return plans

    def render(self, item: PendingItem) -> str:
        """The prompt for one item: the shortlist and the item."""
        venues = "\n".join(_venue_line(row) for row in self.index.shortlist(item)) or "(none yet)"
        description = redact_contacts((item.description or "")[:MAX_DESCRIPTION]).strip()
        when = datetime.fromtimestamp(item.starts_at / 1000, UTC).strftime("%Y-%m-%d")
        lines = [
            f"Kind: {'academic talk' if item.kind == 'talk' else 'event'}",
            f"Listed by: {', '.join(item.organisers[:4]) or '(not known)'}",
            f"Listing: {_LISTINGS.get(item.source_type, item.source_type)}",
            f"Date: {when}",
            f"Title: {item.title}",
            f"Venue as listed: {item.place_text or '(none)'}",
            "Organiser's usual places: "
            + ("; ".join(item.organiser_places[:MAX_ORGANISER_PLACES]) or "(not known)"),
        ]
        if item.kind == "talk":
            lines.append(f"Listed as online: {'yes' if item.online else 'no'}")
        known = self.index.get(item.venue_key)
        if known is not None:
            lines.append(f"The listing's own venue: {known.key} ({known.name})")
        lines.append(f"Description: {description or '(none)'}")
        return self.template.safe_substitute(venues=venues, item="\n".join(lines))

    # -- rows ----------------------------------------------------------------------------

    def _row(self, item: PendingItem, plan: Plan, digest: str) -> ItemLocationInput:
        reply = plan.reply
        base = {
            "kind": item.kind,
            "item_key": item.item_key,
            "starts_at": item.starts_at,
            "method": plan.method,
            "input_hash": digest,
        }
        if plan.method == "llm":
            base["model"] = single_line(plan.model, LIMITS["model"])
            base["prompt_version"] = PROMPT_NAME
        decision = reply.decision
        if decision == "online":
            return ItemLocationInput(precision="online", **base)
        if decision == "unknown":
            note = single_line(reply.note, LIMITS["note"]) or "nothing about the place is known"
            return ItemLocationInput(precision="unknown", note=note, **base)

        precision = reply.precision if reply.precision in ("exact", "building", "area") else "exact"
        outside = reply.outside_cambridge
        spec = reply.building if reply.building is not None and reply.building.given else None
        parent = reply.parent if reply.parent is not None and reply.parent.given else None
        # 1. The key, when it is a known venue that fits the item.
        venue = self.index.get(reply.venue_key)
        if (
            venue is not None
            and plan.method == "llm"
            and (spec or parent)
            and _unrelated(venue, item, [spec, parent])
        ):
            # A known venue that shares nothing with the item's place text nor
            # with the buildings the model names ("MR15, CMS" → the ADC
            # Theatre, building the Centre for Mathematical Sciences): the
            # named building is the place.
            venue = None
        if spec is not None and parent is not None and _names_a_room(spec, reply.room):
            # "Angevin Room, Queens' College" as a building: the room is in
            # `room`, so the building is the parent.
            spec, parent = parent, None
        if venue is None and spec is None and parent is None and precision == "area":
            spec = CENTRAL
        level: str | None = None
        #: A town, a district or a street the item may be put at when no
        #: building is found (never `exact`): set aside while the reply's
        #: buildings and the venue text are tried.
        fallback: tuple[VenueRow, str] | None = None
        venue, level, fallback = self._set_aside(venue, None, fallback)
        # 2. The building by name or alias, 3. geocoded.
        if venue is None and spec is not None:
            found, found_level = self._venue_for(
                spec, item, plan, outside=outside, area=precision == "area"
            )
            venue, level, fallback = self._set_aside(found, found_level, fallback)
        room = reply.room
        if venue is None and parent is not None:
            found, found_level = self._venue_for(
                parent, item, plan, outside=outside, area=precision == "area"
            )
            found, found_level, fallback = self._set_aside(found, found_level, fallback)
            if found is not None:
                venue, level = found, found_level
                precision = "area" if precision == "area" else "building"
                room = room or (spec.name if spec else None)
        if (
            venue is None
            and not outside
            and item.place_text
            and (precision != "area" or fallback is not None)
        ):
            # Neither building was found (or only a town or a street was): a
            # Cambridge building the listing's own venue text names. As the
            # building the item is in when the model named another one; at
            # the reply's precision when it named only a town or a street
            # ("Bridgetower Room, Trinity Hall Cambridge, Trinity Ln").
            found = self._from_gazetteer([item.place_text])
            found, _found_level, fallback = self._set_aside(found, None, fallback)
            if found is not None:
                venue = found
                if fallback is None:
                    precision = "building"
        if venue is None and fallback is not None:
            venue, level = fallback
        if venue is None:
            named = spec.name if spec and spec.name else (parent.name if parent else None)
            note = single_line(
                f"not found on OpenStreetMap or by postcode: {named}"
                if named
                else "no building named",
                LIMITS["note"],
            )
            return ItemLocationInput(precision="unknown", note=note, **base)
        venue = self._ensure_placed(venue, item, plan, outside=outside)
        if level is None:
            # Reached by key or name: how much its own lookup pinned down,
            # in this run or an earlier one, or what its OSM object is.
            level = self._coarse(venue.key)
        if venue.placed and not CAMBRIDGE_REGION.contains(venue.lat, venue.lng):  # type: ignore[arg-type]
            with self._lock:
                self.metrics.outside += 1
        area_label = None
        if level == "area" and precision != "area":
            # Only the town or district was found: say so rather than pin a
            # building that is not there.
            precision = "area"
            area_label = single_line(
                reply.area_label or f"{venue.name} (exact place not known)", LIMITS["areaLabel"]
            )
        elif level in ("street", "postcode") and precision == "exact":
            precision = "building"
        if precision == "area" and area_label is None:
            area_label = single_line(reply.area_label, LIMITS["areaLabel"]) or single_line(
                venue.name, LIMITS["areaLabel"]
            )
        return ItemLocationInput(
            precision=precision,
            venue_key=venue.key,
            room=clean_room(room, venue.name) if precision != "area" else None,
            area_label=area_label,
            **base,
        )

    def _coarse(self, key: str | None) -> str | None:
        """How little a known venue pins down: "area" (a town or district:
        an area venue, or one whose OSM object is a place or boundary),
        "street" (a road, a station: its OSM object, or a street's point
        this stage placed it by) or "postcode"; None for a place to go."""
        if not key:
            return None
        if is_area_key(key):
            return "area"
        found = self.venue_classes.get(key)
        if found is not None:
            return found.level
        return self.coarse_venues.get(key)

    def classified_coarse(self, key: str | None) -> bool:
        """Whether a row at this venue carries the resolver version
        (`row_input_hash`): an area venue, or one whose OSM object is a
        town or a street. The same test as `stages/locate.due`."""
        return bool(key) and (is_area_key(key) or key in self.venue_classes)  # type: ignore[arg-type]

    def _set_aside(
        self,
        venue: VenueRow | None,
        level: str | None,
        fallback: tuple[VenueRow, str] | None,
    ) -> tuple[VenueRow | None, str | None, tuple[VenueRow, str] | None]:
        """`venue` when it is a place to go; else (None, None) and it becomes
        the fallback (the first one found stays): a town or district, or a
        venue that is a street itself. A building only placed at a street's
        or postcode's point is kept (`building` at most)."""
        if venue is None:
            return None, None, fallback
        coarse = level or self._coarse(venue.key)
        if coarse == "area" or (coarse is not None and not self.index.nameable(venue.key)):
            return None, None, fallback or (venue, coarse)
        return venue, level, fallback

    # -- venues --------------------------------------------------------------------------

    def _venue_for(
        self, spec: Building, item: PendingItem, plan: Plan, *, outside: bool, area: bool = False
    ) -> tuple[VenueRow | None, str | None]:
        """The venue `spec` names and how much its geocoding pinned down
        (None for a known venue): a known one (by key, name or alias), else
        the one the geocoding chain finds (posted as a new venue), else
        (None, None). Raises `Deferred` when it cannot be looked up in this
        run (nothing is remembered then)."""
        name = single_line(spec.name, VENUE_NAME_MAX) or single_line(spec.osm_query, VENUE_NAME_MAX)
        if not name:
            return None, None
        try:
            key = venue_key(name)
        except ValueError:
            return None, None
        known = self._known(key, name)
        if known is not None and self._coarse(known.key) is None:
            return known, None
        if not outside:
            found = self._from_gazetteer([spec.name, spec.osm_query])
            if found is not None and self._coarse(found.key) is None:
                return found, None
        if known is not None and not _says_more(spec, known):
            # A town or a street by its own name ("Cambridge", "Downing
            # Street"): looking it up again finds it again.
            return known, None
        lookup = (key, outside, area)
        if lookup in self._looked_up:
            found_before = self._looked_up[lookup]
            if found_before:
                return found_before[0], found_before[1]
            return known, None
        hit = self._geocode(spec, outside=outside, area=area)
        row = self._hit_venue(hit, spec, item, plan) if hit is not None else None
        self._looked_up[lookup] = (row, hit.level) if row is not None and hit is not None else None
        if row is None:
            return known, None
        return row, hit.level if hit else None

    def _known(self, key: str, name: str) -> VenueRow | None:
        return (
            self.index.get(key) or self.index.by_name(name) or by_overlap(self.index.named(), name)
        )

    def _hit_venue(
        self, hit: GeoHit, spec: Building, item: PendingItem, plan: Plan
    ) -> VenueRow | None:
        """The venue a geocoding hit is: a town or district as an area venue
        (`area_venue_key`, never reused as a building), a known one by the
        source's name, a new one posted from the source's own values, or —
        when the source has no name for the object — a new one under the
        model's building name, if that reads as a building's name the item's
        own text gives and the item is no talk (G1: talks.cam wording never
        becomes a venue). None otherwise."""
        source_name = single_line(hit.name, VENUE_NAME_MAX)
        if source_name and PERSONISH.search(source_name):
            return None
        if hit.level == "area":
            if not source_name:
                return None
            try:
                key = area_venue_key(source_name)
            except ValueError:
                return None
            known = self.index.get(key)
            if known is not None:
                return known
            model_name = None
            name = source_name
        else:
            model_name = (
                None
                if source_name or not model_names_allowed(item)
                else model_building_name(spec.name, item)
            )
            name = source_name or model_name
            if not name:
                return None
            try:
                key = venue_key(name)
            except ValueError:
                return None
            known = self._known(key, name)
            if known is not None:
                return known
        # Posted without OpenStreetMap's "(University of Cambridge)" /
        # ", Cambridge" suffix (venue_name.py); the key stays minted from the
        # source's own name, so the same hit finds this venue again.
        name = venue_display_name(name)
        address = single_line(hit.address, VENUE_ADDRESS_MAX)
        model_address = None
        if address is None and model_name is not None:
            model_address = model_building_address(spec.address, hit)
        row = VenueRow(
            key=key,
            name=name,
            aliases=[],
            address=address or model_address,
            lat=hit.lat,
            lng=hit.lng,
        )
        self.index.add(row)
        if hit.level in ("street", "postcode"):
            self.coarse_venues[key] = hit.level
            if model_name is None:
                # Named after the road itself ("Wilberforce Road"): a street,
                # never a name another item's building may match.
                self.index.hide(key)
        with self._lock:
            self.metrics.new_venues += 1
            if model_name is not None:
                self.metrics.model_named_venues += 1
        if model_name is not None:
            claims = [self._model_claim(key, "name", name, hit, plan)]
        else:
            claims = [self._hit_claim(key, "name", name, hit)]
        if address:
            claims.append(self._hit_claim(key, "address", address, hit))
        elif model_address:
            claims.append(self._model_claim(key, "address", model_address, hit, plan))
        claims += [
            self._hit_claim(key, "lat", hit.lat, hit),
            self._hit_claim(key, "lng", hit.lng, hit),
        ]
        self._claims.setdefault(key, []).extend(claims)
        return row

    def _ensure_placed(
        self, venue: VenueRow, item: PendingItem, plan: Plan, *, outside: bool = False
    ) -> VenueRow:
        """`venue` with coordinates, looking it up once when it has none. A
        venue no source places stays unplaced and is still the item's venue
        (no pin); a town found for it is no place for its pin. Raises
        `Deferred` when the lookup got no answer (an outage, a budget
        spent): the item gets no row, so the next run, which retries it,
        looks the venue up again."""
        if venue.placed or venue.key in self._placing:
            return venue
        if not outside and self.gazetteer is not None:
            found = self.gazetteer.find([venue.name, *venue.aliases])
            if found is not None:
                with self._lock:
                    self.metrics.gazetteer_hits += 1
                return self._place_from(venue, found.place)
        if self.geocoder is None:
            return venue
        hit = self._geocode(
            Building(name=venue.name, address=venue.address, osm_query=None), outside=outside
        )
        self._placing.add(venue.key)
        if hit is None or hit.level == "area":
            return venue
        if hit.level in ("street", "postcode"):
            self.coarse_venues[venue.key] = hit.level
        placed = venue.model_copy(
            update={"lat": hit.lat, "lng": hit.lng, "address": venue.address or hit.address}
        )
        self.index.add(placed)
        with self._lock:
            self.metrics.placed_venues += 1
        claims = [
            self._hit_claim(venue.key, "lat", hit.lat, hit),
            self._hit_claim(venue.key, "lng", hit.lng, hit),
        ]
        if not venue.address and hit.address:
            claims.append(self._hit_claim(venue.key, "address", hit.address, hit))
        self._claims.setdefault(venue.key, []).extend(claims)
        return placed

    # -- the gazetteer -------------------------------------------------------------------

    def _from_gazetteer(self, texts: Sequence[str | None]) -> VenueRow | None:
        """The venue of the Cambridge building one of `texts` names in the
        committed gazetteer (`locate/gazetteer.py`): a known venue of its
        name (placed by it when it has no point yet), else a new venue
        posted from OSM's own name, address and point. None when no text
        names one (or the gazetteer is off)."""
        if self.gazetteer is None:
            return None
        hit = self.gazetteer.find(texts)
        if hit is None:
            return None
        venue = self._gazetteer_venue(hit.place)
        if venue is not None:
            with self._lock:
                self.metrics.gazetteer_hits += 1
        return venue

    def _gazetteer_venue(self, place: GazetteerPlace) -> VenueRow | None:
        name = single_line(gazetteer_name(place.name), VENUE_NAME_MAX)
        if not name or PERSONISH.search(name):
            return None
        try:
            key = venue_key(name)
        except ValueError:
            return None
        known = self._known(key, name)
        if known is None and normalise(place.name) != normalise(name):
            try:
                known = self._known(venue_key(place.name), place.name)
            except ValueError:
                known = None
        if known is not None:
            return known if known.placed else self._place_from(known, place)
        address = _gazetteer_address(place)
        row = VenueRow(
            key=key, name=name, aliases=[], address=address, lat=place.lat, lng=place.lng
        )
        self.index.add(row)
        with self._lock:
            self.metrics.new_venues += 1
        claims = [self._place_claim(key, "name", name, place)]
        if address:
            claims.append(self._place_claim(key, "address", address, place))
        claims += [
            self._place_claim(key, "lat", place.lat, place),
            self._place_claim(key, "lng", place.lng, place),
        ]
        self._claims.setdefault(key, []).extend(claims)
        return row

    def _place_from(self, venue: VenueRow, place: GazetteerPlace) -> VenueRow:
        """A known venue without a point, placed at the gazetteer's building."""
        address = venue.address or _gazetteer_address(place)
        placed = venue.model_copy(update={"lat": place.lat, "lng": place.lng, "address": address})
        self.index.add(placed)
        self._placing.add(venue.key)
        self.coarse_venues.pop(venue.key, None)
        self.venue_classes.pop(venue.key, None)
        with self._lock:
            self.metrics.placed_venues += 1
        claims = [
            self._place_claim(venue.key, "lat", place.lat, place),
            self._place_claim(venue.key, "lng", place.lng, place),
        ]
        if not venue.address and address:
            claims.append(self._place_claim(venue.key, "address", address, place))
        self._claims.setdefault(venue.key, []).extend(claims)
        return placed

    def _place_claim(self, key: str, name: str, value: object, place: GazetteerPlace) -> ClaimInput:
        """A value of the OSM object the gazetteer read (OSM's own), cited to
        its OSM page and dated when it was read from OpenStreetMap."""
        assert self.gazetteer is not None
        return build_claim(
            parser_field(name, value, extractor=f"locate.gazetteer.{name}", evidence="secondary"),
            entity_type="venue",
            entity_key=key,
            source_url=place.url,
            source_type="osm_nominatim",
            retrieved_at=self.gazetteer.retrieved_at,
        )

    def _geocode(self, spec: Building, *, outside: bool, area: bool = False) -> GeoHit | None:
        if self.geocoder is None:
            raise Deferred("no geocoder in this run")
        try:
            return self.geocoder.locate(spec, outside=outside, area=area)
        except GeocodeDeferred as error:
            with self._lock:
                if error.budget:
                    if error.service not in self._budget_notes:
                        self._budget_notes.add(error.service)
                        self.notes.append(
                            f"{error.service} budget spent: some items wait for the next run"
                        )
                elif error.service not in self._outage_notes:
                    self._outage_notes.add(error.service)
                    self.notes.append(
                        f"{error.service} did not answer ({error.reason}); "
                        "those items wait for the next run"
                    )
            raise Deferred(str(error)) from error

    def _hit_claim(self, key: str, name: str, value: object, hit: GeoHit) -> ClaimInput:
        """A value the geocoding source itself gave (OSM's or postcodes.io's)."""
        prefix = {"nominatim": "osm", "photon": "photon", "postcodes_io": "postcodes"}[hit.service]
        return build_claim(
            parser_field(name, value, extractor=f"locate.{prefix}.{name}", evidence="secondary"),
            entity_type="venue",
            entity_key=key,
            source_url=hit.source_url,
            source_type=hit.source_type,
            retrieved_at=self.now,
        )

    def _model_claim(self, key: str, name: str, value: str, hit: GeoHit, plan: Plan) -> ClaimInput:
        """The model's building name (or address) for an object its source
        does not name: an `inferred` model claim, cited to the source that
        placed it."""
        return build_claim(
            FieldObs(
                field=name,
                value=value,
                method="llm",
                evidence="secondary",
                extractor=plan.model or "locate",
                prompt_version=PROMPT_NAME,
                status="inferred",
            ),
            entity_type="venue",
            entity_key=key,
            source_url=hit.source_url,
            source_type=hit.source_type,
            retrieved_at=self.now,
        )

    # -- place ids -----------------------------------------------------------------------

    def place_ids(self) -> None:
        """Place ids for new venues and known ones without one (used by this
        run's rows first), within `MAX_PLACES_CALLS`; a venue Places found
        nothing for waits `PLACES_RETRY_DAYS`. A venue Places gave no answer
        for (an outage, an error status) is not stamped: the next run asks
        again."""
        if self.places is None:
            return
        failed = 0
        retry_before = self.now - timedelta(days=PLACES_RETRY_DAYS)
        due = [
            row
            for row in self.index.venues.values()
            if not row.google_place_id
            and not _recent(self.places_tried.get(row.key), retry_before)
            # Places searches inside the Cambridge rectangle: a far venue
            # (an away ground) would get a Cambridge place's id, and a town
            # has no place to give.
            and not is_area_key(row.key)
            and self._coarse(row.key) != "area"
            and not (row.placed and not CAMBRIDGE_REGION.contains(row.lat, row.lng))  # type: ignore[arg-type]
        ]
        due.sort(key=lambda row: (row.key not in self._used, row.key not in self._claims, row.key))
        for row in due:
            if self.places.calls >= self.budget.places_calls or self.out_of_time():
                break
            query = f"{row.name}, {row.address}" if row.address else f"{row.name}, Cambridge"
            try:
                found = self.places.place_id(query)
            except PlacesBlocked as error:
                self.notes.append(f"Google Places: {error}; no more place ids this run")
                break
            except PlacesUnavailable:
                failed += 1
                continue
            self.places_tried[row.key] = self.now.date().isoformat()
            if found is None:
                continue
            self.index.add(row.model_copy(update={"google_place_id": found}))
            self._claims.setdefault(row.key, []).append(
                build_claim(
                    parser_field(
                        "googlePlaceId", found, extractor="locate.places.id", evidence="secondary"
                    ),
                    entity_type="venue",
                    entity_key=row.key,
                    source_url=place_url(found),
                    source_type="google_places",
                    retrieved_at=self.now,
                )
            )
        if failed:
            self.notes.append(
                f"Google Places did not answer for {failed} venues; they are asked again next run"
            )

    def venue_claims(self) -> list[ClaimInput]:
        """Every venue claim of this run, grouped by venue (a new venue's
        `name` travels with the rest of its claims)."""
        return [claim for claims in self._claims.values() for claim in claims]


def deterministic(item: PendingItem, index: VenueIndex) -> Plan | None:
    """The rules of §2 step 2, or None when the model must read the item."""
    text = item.place_text
    if item.kind == "talk":
        if (item.online and (not text or is_online_only(text))) or (text and is_online_only(text)):
            return Plan(LocateReply(decision="online"), "source")
    elif not item.venue_key and text and is_online_only(text):
        return Plan(LocateReply(decision="online"), "source")
    own = index.get(item.venue_key)
    if own is not None and own.placed:
        room = index.room_beyond(own, text) if text else None
        return Plan(LocateReply(decision="existing", venue_key=own.key, room=room), "source")
    if text:
        found = index.match(text)
        if found is not None:
            venue, room = found
            return Plan(LocateReply(decision="existing", venue_key=venue.key, room=room), "alias")
    if own is not None:
        # The source's own venue, still without coordinates: look it up.
        return Plan(LocateReply(decision="existing", venue_key=own.key), "source")
    return None


#: The resolver version a row's input hash may end with (`row_input_hash`).
_VERSION_SUFFIX = re.compile(r":r\d+$")


def row_input_hash(digest: str, precision: str, *, coarse: bool = False) -> str:
    """The input hash a row is posted with: the item's (`input_hash`, also
    the reply cache's key), and for an `unknown` row or one at a coarse
    venue (`Locator.classified_coarse`: a town, a district, a street) the
    resolver version after it, so a later version tries that item again
    (`stages/locate.due`), from the cached reply."""
    return f"{digest}:{RESOLVER_VERSION}" if precision == "unknown" or coarse else digest


#: A qualifier OSM names carry that says nothing about the building.
_UNIVERSITY_SUFFIX = re.compile(r"\s*\(University of Cambridge\)\s*$", re.IGNORECASE)


def gazetteer_name(name: str) -> str:
    """A gazetteer place's name as a venue's: OSM's, without a trailing
    "(University of Cambridge)" ("Centre for Mathematical Sciences (University
    of Cambridge)" → "Centre for Mathematical Sciences")."""
    return _UNIVERSITY_SUFFIX.sub("", name).strip() or name


def _gazetteer_address(place: GazetteerPlace) -> str | None:
    """OSM's address of a place, when it says more than the town."""
    address = single_line(place.address, VENUE_ADDRESS_MAX)
    if address and ("," in address or find_postcode(address)):
        return address
    return None


def _unrelated(venue: VenueRow, item: PendingItem, named: Sequence[Building | None]) -> bool:
    """Whether a chosen known venue has no word in common with the item's
    place text, the buildings the model named, its organisers or their usual
    places (and is not one of the buildings, nor at its postcode): a key
    picked off the list rather than read. With neither place
    text nor a named building the key is all there is, and it stands."""
    buildings = [spec for spec in named if spec is not None and spec.given]
    if not buildings:
        return False
    names = _distinct(" ".join([venue.name, *venue.aliases]))
    spec_names = [spec.name or spec.osm_query or "" for spec in buildings]
    if any(normalise(name) == normalise(venue.name) for name in spec_names):
        return False
    postcode = find_postcode(venue.address)
    if postcode and any(find_postcode(spec.address) == postcode for spec in buildings):
        return False
    said = (
        distinctive(item.place_text)
        | distinctive(" ".join(spec_names))
        | distinctive(" ".join([*item.organisers, *item.organiser_places]))
    )
    return not (names & said)


def _says_more(spec: Building, known: VenueRow) -> bool:
    """Whether the model's building says more than a coarse venue's own
    name (a building's name in its OSM query: "McDonald Institute, Downing
    Street" for "Downing Street"), so looking it up may find the building."""
    own = distinctive(" ".join([known.name, spec.address or ""]))
    said = distinctive(" ".join([spec.name or "", spec.osm_query or ""]))
    return bool(said - own)


def _distinct(text: str) -> set[str]:
    """`distinctive`, or every word when all are generic ("The Chapel")."""
    return distinctive(text) or tokens(text)


def _names_a_room(spec: Building, room: str | None) -> bool:
    """Whether a "building" is the room itself ("Angevin Room, Queens'
    College" with room "Angevin Room")."""
    return bool(room and spec.name) and normalise(spec.name or "").startswith(normalise(room or ""))


def model_building_name(name: str | None, item: PendingItem) -> str | None:
    """The model's building name, when it may be posted as a venue's name
    (no source has one for the object): one short line that reads as a
    building's name, never a person's (an honorific, a link, an address),
    and not a phrase of the item's own text beyond a place's name (the
    item's title, a sentence). None otherwise."""
    out = single_line(name, MODEL_NAME_CHARS)
    if out is None or out.endswith("…"):
        return None
    if PERSONISH.search(out) or find_postcode(out) or _LONG_NUMBER.search(out):
        return None
    if not _MODEL_NAME.fullmatch(out) or len(out.split()) > MODEL_NAME_WORDS:
        return None
    words = tokens(out)
    if not words:
        return None
    title = normalise(item.title)
    if title and normalise(out) == title and len(title.split()) > 3:
        # An event's title written back as its building.
        return None
    # Grounded: every distinctive word of it is in what the item says (its
    # venue text, title, description, organisers and their usual places),
    # so the model read the name rather than made it up.
    own = distinctive(out)
    if not own:
        return None
    said = tokens(
        " ".join(
            [
                item.place_text,
                item.title,
                item.description or "",
                *item.organisers,
                *item.organiser_places,
            ]
        )
    )
    if not own <= said:
        return None
    return out


def model_names_allowed(item: PendingItem) -> bool:
    """Whether the model's wording may name a venue for `item`: never for a
    talk or a talks.cam-derived event (G1, D13: their text reaches the model
    for resolution only, and venues are public site-wide)."""
    return item.kind != "talk" and item.source_type not in NO_LLM_SOURCE_TYPES


def model_building_address(address: str | None, hit: GeoHit) -> str | None:
    """The model's address for a venue placed by its street or postcode,
    when it carries the postcode the source placed it by (a check that it
    is an address) and reads as one: else None."""
    out = single_line(address, VENUE_ADDRESS_MAX)
    if out is None or PERSONISH.search(out) or len(out) > 160:
        return None
    postcode = find_postcode(out)
    if postcode is None:
        return None
    placed_by = hit.source_url.replace("%20", "")
    if hit.source_type == "postcodes_io" and postcode.replace(" ", "") not in placed_by:
        return None
    return out


def _venue_line(row: VenueRow) -> str:
    line = f"- {row.key}: {row.name}"
    aliases = [alias for alias in row.aliases if normalise(alias) != normalise(row.name)][:3]
    if aliases:
        line += f" (also {', '.join(aliases)})"
    if row.address:
        line += f" — {row.address}"
    return line


def _recent(stamp: str | None, before: datetime) -> bool:
    if not stamp:
        return False
    try:
        return datetime.fromisoformat(stamp).replace(tzinfo=UTC) > before
    except ValueError:
        return False


__all__ = [
    "MAX_LLM_ITEMS",
    "MAX_NOMINATIM_CALLS",
    "MAX_PHOTON_CALLS",
    "MAX_PLACES_CALLS",
    "MAX_POSTCODES_CALLS",
    "PLACES_RETRY_DAYS",
    "PROMPT_NAME",
    "RESOLVER_VERSION",
    "TIME_BUDGET_S",
    "Budget",
    "Deferred",
    "Locator",
    "Metrics",
    "Plan",
    "deterministic",
    "gazetteer_name",
    "model_building_address",
    "model_building_name",
    "model_names_allowed",
    "row_input_hash",
]
