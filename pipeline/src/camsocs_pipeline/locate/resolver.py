"""One `locate` run (docs/locations-and-map.md §2, source-research §23):
pending items in, venue claims and `itemLocations` rows out.

1. An item whose stored row carries its current input hash is skipped.
2. **Deterministic first** (`matching`): online only → `online`; an event's
   own venue key with coordinates → `source`/`exact`; the venue text naming a
   known venue exactly → `alias`/`exact`, with the room it adds.
3. **The model** (`extract/prompts/locate_v1.md`, bulk tier with the
   client's strong fallback, cached by input hash in `LLMMemo`) for the rest,
   shown the item and a shortlist of known venues. talks.cam text may be
   given to it (decision D13); it reads only what Convex already stores.
4. **New venues** are looked up on OpenStreetMap (Nominatim): the model's
   query, then "<name>, Cambridge", then the address; a miss falls back to
   the enclosing building it named (`building` precision), else the item is
   `unknown` with a note. A known venue without coordinates is looked up the
   same way. Venues are posted as claims (`osm_nominatim`) whose values are
   all OpenStreetMap's own: its name, address, lat and lng. The model's
   name and address are only the query and the match key, never a claimed
   value, and a name that reads as a person's (an honorific, a link) is
   never posted.
5. **Place ids** (`google_places`): new venues and known ones without an id,
   at most `MAX_PLACES_CALLS` a run, each retried after `PLACES_RETRY_DAYS`.

An item the run cannot finish (a budget spent, OpenStreetMap or Places
unreachable or answering an error, a model error, a dry run without a cached
reply) gets no row: the next run tries again. Only "nothing is known" (the
model says so, or OpenStreetMap answered and found nothing) is written as
`unknown`.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable, Iterable, MutableMapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from string import Template

from camsocs_pipeline.claims import build_claim, parser_field
from camsocs_pipeline.extract.events import redact_contacts
from camsocs_pipeline.extract.llm import LLMClient
from camsocs_pipeline.extract.memo import LLMMemo
from camsocs_pipeline.keys import venue_key
from camsocs_pipeline.locate.matching import (
    PERSONISH,
    VenueIndex,
    by_overlap,
    clean_room,
    input_hash,
    is_online_only,
    normalise,
    single_line,
    tokens,
)
from camsocs_pipeline.locate.model import (
    LIMITS,
    VENUE_ADDRESS_MAX,
    VENUE_NAME_MAX,
    ItemLocationInput,
    LocateReply,
    NewVenue,
    PendingItem,
    VenueRow,
)
from camsocs_pipeline.locate.nominatim import (
    Nominatim,
    NominatimBlocked,
    NominatimUnavailable,
    OsmPlace,
)
from camsocs_pipeline.locate.places import Places, PlacesBlocked, PlacesUnavailable, place_url
from camsocs_pipeline.models.wire import ClaimInput

logger = logging.getLogger(__name__)

PROMPT_NAME = "locate_v1"
PROMPT_PATH = Path(__file__).parent.parent / "extract" / "prompts" / f"{PROMPT_NAME}.md"

#: Budgets (§2 step 6): items asked of the model (cached replies are free),
#: Nominatim requests, Places requests, and wall-clock seconds.
MAX_LLM_ITEMS = 900
MAX_NOMINATIM_CALLS = 300
MAX_PLACES_CALLS = 100
TIME_BUDGET_S = 25 * 60
#: A venue Places found nothing for is asked again after this long.
PLACES_RETRY_DAYS = 30
#: How much of a description the model sees (the route sends ≤ 1,500).
MAX_DESCRIPTION = 1_500
#: The anchor of "central Cambridge" (§1b).
CENTRAL = NewVenue(
    name="Market Square",
    address="Market Hill, Cambridge CB2 3NJ",
    osm_query="Market Square, Cambridge",
)

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
    by_method: dict[str, int] = field(default_factory=dict)
    by_precision: dict[str, int] = field(default_factory=dict)


@dataclass
class Budget:
    llm_items: int = MAX_LLM_ITEMS
    nominatim_calls: int = MAX_NOMINATIM_CALLS
    places_calls: int = MAX_PLACES_CALLS
    seconds: float = TIME_BUDGET_S


class Locator:
    """Resolves pending items against the known venues.

    `llm` None: cached replies only (a dry run, or no model configured).
    `nominatim` None: no venue is looked up (new ones defer the item).
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
        places_tried: MutableMapping[str, str] | None = None,
        budget: Budget | None = None,
        workers: int = 4,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.index = VenueIndex.of(venues)
        self.memo = memo
        self.llm = llm
        self.nominatim = nominatim
        self.places = places
        self.now = now
        self.places_tried = places_tried if places_tried is not None else {}
        self.budget = budget or Budget()
        self.workers = max(1, workers)
        self._clock = clock
        self._started = clock()
        self.template = Template(PROMPT_PATH.read_text(encoding="utf-8"))
        self.metrics = Metrics()
        self.notes: list[str] = []
        #: Venue key → claims to post (new venues, coordinates, place ids).
        self._claims: dict[str, list[ClaimInput]] = {}
        #: Venue keys this run has a real OpenStreetMap answer for: the venue
        #: it gave (None: nothing found). An unanswered lookup is not here.
        self._looked_up: dict[str, VenueRow | None] = {}
        #: Venue keys the rows of this run point at.
        self._used: set[str] = set()
        self._nominatim_note = False
        self._outage_note = False
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
            try:
                call = self.llm.complete_json(  # type: ignore[union-attr]
                    schema=LocateReply,
                    messages=[{"role": "user", "content": self.render(item)}],
                    prompt_version=PROMPT_NAME,
                    tier="bulk",
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
        if reply.decision == "online":
            return ItemLocationInput(precision="online", **base)
        if reply.decision == "unknown":
            note = single_line(reply.note, LIMITS["note"]) or "nothing about the place is known"
            return ItemLocationInput(precision="unknown", note=note, **base)

        precision = (
            reply.precision
            if reply.precision in ("exact", "building", "area")
            else "exact"
            if reply.precision is None
            else "building"
        )
        venue = self.index.get(reply.venue_key) if reply.decision == "existing" else None
        spec = reply.new_venue
        parent = reply.parent
        if venue is not None and parent is not None and _unrelated(venue, item, parent):
            # A known venue that shares nothing with the item's place text nor
            # with the building the model says encloses it ("MR15, CMS" → the
            # ADC Theatre, parent the Centre for Mathematical Sciences): the
            # parent is the place.
            venue, spec, parent = None, parent, None
        if spec is not None and parent is not None and _names_a_room(spec, reply.room):
            # "Angevin Room, Queens' College" as a building: the room is in
            # `room`, so the building is the parent.
            spec, parent = parent, None
        if venue is None and spec is None and precision == "area":
            spec = CENTRAL
        if venue is None and spec is not None:
            venue = self._venue_for(spec)
        room = reply.room
        if venue is None and parent is not None:
            venue = self._venue_for(parent)
            if venue is not None:
                precision = "area" if precision == "area" else "building"
                room = room or (spec.name if spec else None)
        if venue is None:
            note = single_line(
                f"not found on OpenStreetMap: {spec.name}"
                if spec and spec.name
                else "no venue named",
                LIMITS["note"],
            )
            return ItemLocationInput(precision="unknown", note=note, **base)
        venue = self._ensure_placed(venue)
        area_label = None
        if precision == "area":
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

    # -- venues --------------------------------------------------------------------------

    def _venue_for(self, spec: NewVenue) -> VenueRow | None:
        """The venue `spec` names: a known one (by key, name or alias), else
        the one OpenStreetMap finds for it (posted as a new venue under
        OpenStreetMap's own name), else None. Raises `Deferred` when it cannot
        be looked up in this run (nothing is remembered then).

        The model's name and address only query OpenStreetMap and match known
        venues; every claimed value is OpenStreetMap's (D1, §1a)."""
        name = single_line(spec.name, VENUE_NAME_MAX)
        if not name:
            return None
        try:
            key = venue_key(name)
        except ValueError:
            return None
        known = self._known(key, name)
        if known is not None:
            return known
        if key in self._looked_up:
            return self._looked_up[key]
        address = single_line(spec.address, VENUE_ADDRESS_MAX)
        place = self._lookup([spec.osm_query, f"{name}, Cambridge", address])
        row = self._osm_venue(place) if place is not None else None
        self._looked_up[key] = row
        return row

    def _known(self, key: str, name: str) -> VenueRow | None:
        return (
            self.index.get(key)
            or self.index.by_name(name)
            or by_overlap(list(self.index.venues.values()), name)
        )

    def _osm_venue(self, place: OsmPlace) -> VenueRow | None:
        """The venue OpenStreetMap's `place` is: a known one by its name, or a
        new one posted from OpenStreetMap's own values. None when the object
        has no usable name (an address without a building) or its name reads
        as a person's."""
        name = single_line(place.name, VENUE_NAME_MAX)
        if not name or PERSONISH.search(name):
            return None
        try:
            key = venue_key(name)
        except ValueError:
            return None
        known = self._known(key, name)
        if known is not None:
            return known
        row = VenueRow(
            key=key,
            name=name,
            aliases=[],
            address=single_line(place.address, VENUE_ADDRESS_MAX),
            lat=place.lat,
            lng=place.lng,
        )
        self.index.add(row)
        self.metrics.new_venues += 1
        claims = [self._osm_claim(key, "name", name, place)]
        if row.address:
            claims.append(self._osm_claim(key, "address", row.address, place))
        claims += [
            self._osm_claim(key, "lat", place.lat, place),
            self._osm_claim(key, "lng", place.lng, place),
        ]
        self._claims.setdefault(key, []).extend(claims)
        return row

    def _ensure_placed(self, venue: VenueRow) -> VenueRow:
        """`venue` with coordinates, looking it up once when it has none. A
        venue OpenStreetMap does not know stays unplaced and is still the
        item's venue (no pin). Raises `Deferred` when the lookup got no
        answer (an outage, a budget spent): the item gets no row, so the next
        run, which retries it, looks the venue up again."""
        if venue.placed or venue.key in self._looked_up or self.nominatim is None:
            return venue
        place = self._lookup([f"{venue.name}, Cambridge", venue.address])
        self._looked_up[venue.key] = None if place is None else venue
        if place is None:
            return venue
        placed = venue.model_copy(
            update={"lat": place.lat, "lng": place.lng, "address": venue.address or place.address}
        )
        self.index.add(placed)
        self.metrics.placed_venues += 1
        claims = [
            self._osm_claim(venue.key, "lat", place.lat, place),
            self._osm_claim(venue.key, "lng", place.lng, place),
        ]
        if not venue.address and place.address:
            claims.append(self._osm_claim(venue.key, "address", place.address, place))
        self._claims.setdefault(venue.key, []).extend(claims)
        return placed

    def _lookup(self, queries: Sequence[str | None]) -> OsmPlace | None:
        if self.nominatim is None:
            raise Deferred("no geocoder in this run")
        if self.nominatim.blocked:
            raise Deferred("Nominatim refused this run")
        if self.nominatim.calls >= self.budget.nominatim_calls or self.out_of_time():
            if not self._nominatim_note:
                self.notes.append("geocoding budget spent: some items wait for the next run")
                self._nominatim_note = True
            raise Deferred("budget")
        try:
            return self.nominatim.find(queries)
        except NominatimBlocked as error:
            self.notes.append(f"OpenStreetMap: {error}; remaining items wait for the next run")
            raise Deferred(str(error)) from error
        except NominatimUnavailable as error:
            if not self._outage_note:
                self.notes.append(
                    f"OpenStreetMap did not answer ({error}); those items wait for the next run"
                )
                self._outage_note = True
            raise Deferred(str(error)) from error

    def _osm_claim(self, key: str, name: str, value: object, place: OsmPlace) -> ClaimInput:
        return build_claim(
            parser_field(name, value, extractor=f"locate.osm.{name}", evidence="secondary"),
            entity_type="venue",
            entity_key=key,
            source_url=place.url,
            source_type="osm_nominatim",
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
            if not row.google_place_id and not _recent(self.places_tried.get(row.key), retry_before)
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


def _unrelated(venue: VenueRow, item: PendingItem, parent: NewVenue) -> bool:
    """Whether a chosen known venue has no word in common with the item's
    place text or with the enclosing building the model named (and is not
    that building): a key picked off the list rather than read."""
    if not item.place_text:
        return False
    names = tokens(" ".join([venue.name, *venue.aliases]))
    parent_name = parent.name or ""
    if normalise(parent_name) == normalise(venue.name):
        return False
    return not (names & tokens(item.place_text)) and not (names & tokens(parent_name))


def _names_a_room(spec: NewVenue, room: str | None) -> bool:
    """Whether a "new venue" is the room itself ("Angevin Room, Queens'
    College" with room "Angevin Room")."""
    return bool(room and spec.name) and normalise(spec.name or "").startswith(normalise(room or ""))


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
    "MAX_PLACES_CALLS",
    "PLACES_RETRY_DAYS",
    "PROMPT_NAME",
    "TIME_BUDGET_S",
    "Budget",
    "Deferred",
    "Locator",
    "Metrics",
    "Plan",
    "deterministic",
]
