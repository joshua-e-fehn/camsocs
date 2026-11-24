"""Stage `locate`: where every event and talk takes place
(docs/locations-and-map.md §2, source-research §23, decision D13).

Reads Convex, not staging: the events and talks starting from a day ago to
120 days ahead (`locations/pending`), with the text Convex already stores —
events' D1-redacted venue text, talks as their source lists them — and every
known venue (`venues/all`). The rules, the model, OpenStreetMap and Google
Places are `locate/resolver.py`'s; this module wires them to the run:

- the model through the run's `LLMClient` (bulk, strong fallback) and the
  reply cache; without a configured model, cached replies only;
- the committed gazetteer of Cambridge's OSM buildings
  (`locate/gazetteer.py`, read before any request), then the geocoding
  chain (`locate/geocode.py`): Nominatim and Photon at one request a second
  each, postcodes.io paced, all with the crawler's User-Agent;
- Places only with `GOOGLE_PLACES_API_KEY` (a note otherwise), for place ids;
- venue claims first (`claims`), then the rows (`locations/batch`), then the
  14-day coverage (`locations/summary`) for the run report.

A **dry run** posts nothing and makes no request: Convex is not read (the
loader's read methods return nothing), the model is not asked and no venue is
looked up — cached replies only.

talks.cam text may reach the model here (D13: Joshua's permission as a
University student). That permission covers location resolution only; the
rules for *fetching* talks.cam (§6) and the G1 render boundary are unchanged,
and the fetch and claim guards (`claims.NO_LLM_SOURCE_TYPES`,
`extract.llm.assert_llm_source_allowed`) still apply to every other path.
The venue claims this stage posts carry OpenStreetMap's, postcodes.io's and
Google's own values (name, address, coordinates, place id), never the
item's text. The model's wording becomes a claim only as a building's name
(and address) for an object its source does not name, posted `inferred`,
only when it reads as a building's name the item's own text gives
(`resolver.model_building_name`) and never for a talk or a talks.cam-derived
event (`resolver.model_names_allowed`): venues are public site-wide.
"""

from __future__ import annotations

import logging
from collections.abc import Collection
from datetime import UTC, datetime, timedelta

from camsocs_pipeline.config import ConfigError
from camsocs_pipeline.extract.llm import LLMClient
from camsocs_pipeline.extract.memo import LLMMemo
from camsocs_pipeline.locate.gazetteer import Gazetteer
from camsocs_pipeline.locate.matching import input_hash, is_area_key
from camsocs_pipeline.locate.model import PendingItem
from camsocs_pipeline.locate.nominatim import Nominatim
from camsocs_pipeline.locate.photon import Photon
from camsocs_pipeline.locate.places import Places
from camsocs_pipeline.locate.postcodes import Postcodes
from camsocs_pipeline.locate.resolver import PROMPT_NAME, Locator, row_input_hash
from camsocs_pipeline.locate.venue_class import classify_venues
from camsocs_pipeline.pipeline.context import StageContext

logger = logging.getLogger(__name__)

#: The window (§2): from a day ago (an ongoing item) to 120 days ahead.
WINDOW_BEFORE = timedelta(days=1)
WINDOW_AFTER = timedelta(days=120)
#: The share of upcoming items that may stay unresolved (owner decision 1).
UNRESOLVED_TARGET = 0.02
#: Rejected rows named in the notes (keys and reasons only).
MAX_REJECTIONS_NOTED = 5


def due(items: list[PendingItem], coarse: Collection[str] = ()) -> tuple[list[PendingItem], int]:
    """The items whose stored row is missing, was made from other input, is
    `unknown` or at a coarse venue (`coarse`: a town, a district or a
    street by its OSM class, or an area venue) from an earlier resolver
    version (`resolver.RESOLVER_VERSION`: looked up again with the new
    lookups, from the cached reply, asking no model), or carries another
    start (a rescheduled item: the row's `startsAt` drives the 14-day
    coverage and the prune; the reply cache is keyed by input hash, so
    re-posting it asks no model), and how many are unchanged."""

    def at_coarse(key: str | None) -> bool:
        return bool(key) and (is_area_key(key) or key in coarse)

    todo = [
        item
        for item in items
        if item.stored is None
        or item.stored.input_hash
        != row_input_hash(
            input_hash(item, PROMPT_NAME),
            item.stored.precision,
            coarse=at_coarse(item.stored.venue_key),
        )
        or (item.stored.starts_at is not None and item.stored.starts_at != item.starts_at)
    ]
    return todo, len(items) - len(todo)


def run(ctx: StageContext, *, now: datetime | None = None) -> None:
    settings = ctx.settings
    now = now or datetime.now(UTC)
    if ctx.dry_run:
        ctx.report.notes.append(
            "dry run: Convex not read, no model asked, no venue looked up (cached replies only)"
        )
    window = (
        int((now - WINDOW_BEFORE).timestamp() * 1000),
        int((now + WINDOW_AFTER).timestamp() * 1000),
    )
    items = ctx.loader.location_pending(*window)
    venues = ctx.loader.venues_all()
    state = ctx.state.data("locate")

    gazetteer: Gazetteer | None = None
    try:
        gazetteer = Gazetteer.default()
    except (OSError, ValueError, KeyError) as error:
        ctx.report.notes.append(f"gazetteer not read ({type(error).__name__}): Nominatim only")

    memo = LLMMemo(settings.cache_dir / "llm")
    llm: LLMClient | None = None
    nominatim: Nominatim | None = None
    photon: Photon | None = None
    postcodes: Postcodes | None = None
    places: Places | None = None
    user_agent = settings.require_user_agent() if not ctx.dry_run and venues else None
    if user_agent is not None:
        nominatim = Nominatim(
            user_agent=user_agent,
            base_url=settings.nominatim_url,
            interval=settings.nominatim_interval,
        )
    try:
        # Which known venues are a town, a district or a street (their OSM
        # class): never an exact place, and their rows are looked at again.
        classes = classify_venues(
            venues,
            state=state.setdefault("venueClass", {}),
            now=now,
            nominatim=nominatim,
            gazetteer=gazetteer,
        )
        ctx.report.notes.extend(classes.notes)
        todo, unchanged = due(items, classes.coarse)
        if ctx.limit is not None:
            todo = todo[: ctx.limit]

        if not ctx.dry_run and todo:
            try:
                llm = LLMClient(settings.require_llm())
            except ConfigError as error:
                ctx.report.notes.append(f"no model ({error}): cached replies only")
            user_agent = user_agent or settings.require_user_agent()
            if nominatim is None:
                nominatim = Nominatim(
                    user_agent=user_agent,
                    base_url=settings.nominatim_url,
                    interval=settings.nominatim_interval,
                )
            photon = Photon(user_agent=user_agent)
            postcodes = Postcodes(user_agent=user_agent)
            if settings.places_configured:
                places = Places(
                    api_key=settings.google_places_api_key.get_secret_value(),
                    user_agent=user_agent,
                )
            else:
                ctx.report.notes.append("place ids skipped: GOOGLE_PLACES_API_KEY is not set")

        locator = Locator(
            venues,
            memo=memo,
            llm=llm,
            nominatim=nominatim if todo else None,
            photon=photon,
            postcodes=postcodes,
            places=places,
            now=now,
            places_tried=state.setdefault("placesTried", {}),
            coarse_venues=state.setdefault("coarseVenues", {}),
            workers=settings.llm_concurrency,
            gazetteer=gazetteer,
            venue_classes=classes.coarse,
        )
        rows = locator.resolve(todo)
        locator.place_ids()
    finally:
        for client in (nominatim, photon, postcodes, places):
            if client is not None:
                client.close()

    claims = locator.venue_claims()
    if claims:
        posted = ctx.loader.post_claims(claims, run_key=ctx.run.run_key)
        if posted.rejected:
            ctx.report.notes.append(f"{len(posted.rejected)} venue claims refused")
    result = ctx.loader.post_locations(rows) if rows else None
    if result is not None:
        ctx.report.inserted += result.inserted
        ctx.report.updated += result.updated
        ctx.report.unchanged += result.unchanged
        if result.rejected:
            shown = "; ".join(
                f"{r.get('itemKey')}: {r.get('reason')}"
                for r in result.rejected[:MAX_REJECTIONS_NOTED]
                if isinstance(r, dict)
            )
            ctx.report.notes.append(f"{len(result.rejected)} rows refused ({shown})")
    ctx.report.unchanged += unchanged
    ctx.report.skipped += locator.metrics.deferred
    ctx.report.notes.extend(locator.notes)

    metrics = locator.metrics
    share = _unresolved_share(ctx, metrics.resolved, metrics.unknown)
    ctx.report.metrics.update(
        {
            "pending": len(items),
            "resolved": metrics.resolved,
            "unknown": metrics.unknown,
            "deferred": metrics.deferred,
            "llmCalls": metrics.llm_calls,
            "llmErrors": metrics.llm_errors,
            "nominatimCalls": nominatim.calls if nominatim else 0,
            "photonCalls": photon.calls if photon else 0,
            "postcodesCalls": postcodes.calls if postcodes else 0,
            "postcodePoints": locator.geocoder.postcode_points if locator.geocoder else 0,
            "gazetteerHits": metrics.gazetteer_hits,
            "coarseVenues": len(classes.coarse),
            "venueClassLookups": classes.calls,
            "placesCalls": places.calls if places else 0,
            "newVenues": metrics.new_venues,
            "modelNamedVenues": metrics.model_named_venues,
            "outsideCambridge": metrics.outside,
            "venueClaims": len(claims),
            "unresolvedShare": share,
        }
    )
    ctx.report.notes.append(
        f"{len(items)} items in the window, {unchanged} unchanged; "
        f"{metrics.resolved} placed, {metrics.unknown} unknown, {metrics.deferred} left for "
        f"the next run; {metrics.new_venues} new venues"
    )
    if share > UNRESOLVED_TARGET:
        ctx.report.notes.append(
            f"unresolved share {share:.1%} is above the {UNRESOLVED_TARGET:.0%} target"
        )


def _unresolved_share(ctx: StageContext, resolved: int, unknown: int) -> float:
    """The next 14 days' unresolved share as Convex counts it after this run
    (`locations/summary`, items with no row included); this run's own share
    when the summary cannot be read (a dry run, an older deployment)."""
    try:
        summary = ctx.loader.location_summary()
    except Exception as error:  # the report must not fail the stage
        logger.warning("locate: locations/summary failed (%s)", type(error).__name__)
        summary = {}
    share = summary.get("unresolvedShare")
    if isinstance(share, int | float) and not isinstance(share, bool):
        return round(float(share), 4)
    total = resolved + unknown
    return round(unknown / total, 4) if total else 0.0
