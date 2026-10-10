"""Stage `termcards`: a term's events from societies' termcards (source-research §21).

1. **Inputs**: every `termcardUrl` an organisation has in staging
   (`OrgLookup.termcards`; the SU, website and enrichment harvesters claim it).
2. **Fetch** politely (`sources.termcards.fetch_termcard`) with the society
   purpose (`sources/policy.py`, D3; ``society_website`` when the card is on
   the society's own domain): the file, or the first termcard file a page
   links or embeds. talks.cam, tbc.xyz and social networks are never
   fetched. Login-walled cards (the SU's ``/file/`` links redirect to its
   login page), 401/403 and 404 cards, robots-blocked cards no override
   covers, and cards from a host that keeps AI out where no override lifts
   it (§14), are skipped with the reason — never "found", never sent to the
   model. A card read under an override says so in its events' access note.
3. **Read** with the strong model's vision (`image_events_v1`) through the
   one card-reading path, `extract.cards.card_events` (also used for the
   cards society events pages show, §14): PDFs four pages a call (at most
   twelve) with their text layer, images as they are; every event needs its
   date in a quote, a yearless date's year a second signal, term weeks the
   term (the card's words, its URL or file name, else its own dated rows —
   then ``inferred``). Replies are cached by the request (the card's bytes
   and the reference date, the Thursday that starts the week), so an
   unchanged card costs nothing again that week. A card whose URL names an
   earlier academic year's term or only earlier years, or whose dated path
   or ``Last-Modified`` dates it before this year
   (`sources.termcards.stale_reason`, `modified_reason`), is not read.
   A termcard URL that is an HTML page with no card file on it (a "Term
   card" page that lists the events as text) is read like a society's
   events page (`sources.websites.events`, bulk model, prompt
   `website_events_v1`: every event needs a dated quote on the page).
4. Events are **public** (the society published the card), or `members_only`
   where the card says so, organised by the card's organisation, and dropped
   when another source already has them (`extract.dedupe`).

The stage writes `var/staging/termcard/<run>.jsonl` with the full current set:
cards read this run plus the previous file's events for cards not reached
(the `--limit` budget), because `load` posts only the latest file.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from camsocs_pipeline.extract.cards import EVENT_SOURCE, SOURCE_TYPE, card_events
from camsocs_pipeline.extract.dedupe import EventIndex
from camsocs_pipeline.extract.llm import LLMClient, LLMValidationError
from camsocs_pipeline.extract.memo import LLMMemo
from camsocs_pipeline.extract.when import TermCalendar, london_date
from camsocs_pipeline.models.observation import EventObservation
from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.resolve.lookup import OrgLookup, domain_of
from camsocs_pipeline.sources.base import PoliteClient
from camsocs_pipeline.sources.policy import SOCIETY, SOCIETY_WEBSITE, FetchPurpose
from camsocs_pipeline.sources.termcards import (
    NO_CARD_FILE,
    Skipped,
    TermcardFile,
    fetch_termcard,
    modified_reason,
    stale_reason,
)
from camsocs_pipeline.sources.websites import events as website_events
from camsocs_pipeline.sources.websites.page import parse_page

logger = logging.getLogger(__name__)

MAX_TERMCARDS_PER_RUN = 60


def run(ctx: StageContext) -> None:
    known = OrgLookup.for_stage(ctx)
    cards = known.termcards()
    if not cards:
        ctx.report.notes.append("no organisation in staging has a termcard URL yet")
        return
    budget = ctx.limit or MAX_TERMCARDS_PER_RUN
    if ctx.dry_run:
        ctx.report.notes.append(f"dry run: {min(len(cards), budget)} termcards would be read")
        return
    settings = ctx.settings
    llm = LLMClient(settings.require_llm())
    memo = LLMMemo(settings.cache_dir / "llm")
    calendar = TermCalendar.default()
    index = EventIndex.from_staging(
        ctx.staging,
        # Never defer a public event to a cam_only copy from list mail.
        exclude=[SOURCE_TYPE, "mailing_list_email"],
    )
    now = datetime.now(UTC)
    today = london_date(now)

    events: list[EventObservation] = []
    reached: set[str] = set()  # organisations whose cards this run reached
    skipped: dict[str, int] = {}
    read = 0
    with PoliteClient(
        user_agent=settings.require_user_agent(),
        cache_dir=settings.cache_dir,
        min_interval=settings.min_host_interval,
    ) as client:
        for org_key, url in cards[:budget]:
            reached.add(org_key)
            purpose = _purpose(known, org_key, url)
            org = known.get(org_key)
            org_name = org.display_name if org else org_key
            stale = stale_reason(url, today)
            fetched = fetch_termcard(client, url, purpose) if stale is None else Skipped(url, stale)
            if isinstance(fetched, TermcardFile):
                stale = stale_reason(fetched.url, today) or modified_reason(
                    fetched.fetch.last_modified, today
                )
            try:
                if stale is not None:
                    found = None
                    fetched = Skipped(url, stale)
                elif isinstance(fetched, Skipped):
                    found = None
                    if fetched.reason == NO_CARD_FILE:
                        found = page_events(
                            client,
                            url,
                            purpose,
                            org_key=org_key,
                            org_name=org_name,
                            now=now,
                            llm=llm,
                            memo=memo,
                            calendar=calendar,
                        )
                else:
                    found = card_events(
                        fetched,
                        org_key=org_key,
                        org_name=org_name,
                        listed_url=url,
                        now=now,
                        llm=llm,
                        memo=memo,
                        calendar=calendar,
                        notes=ctx.report.notes,
                    )
            except LLMValidationError:
                skipped["reply did not validate"] = skipped.get("reply did not validate", 0) + 1
                continue
            if found is None:
                assert isinstance(fetched, Skipped)
                reason = fetched.reason.split(" (", 1)[0]
                skipped[reason] = skipped.get(reason, 0) + 1
                continue
            read += 1
            events.extend(event for event in found if not index.is_duplicate_record(event))

    with_cards = {org_key for org_key, _url in cards}
    carried = [
        record
        for record in ctx.staging.read_latest(SOURCE_TYPE)
        if isinstance(record, EventObservation)
        and (organiser := _organiser(record)) in with_cards
        and organiser not in reached
    ]
    current = [*carried, *events]
    if current:
        ctx.staging.write(SOURCE_TYPE, ctx.run.run_key, current)
    # Staged: the events read this run are new; carried ones are unchanged.
    ctx.report.inserted += len(events)
    ctx.report.unchanged += len(carried)
    ctx.report.skipped += sum(skipped.values())
    ctx.report.notes.append(
        f"{len(cards)} termcards known, {read} read, {len(events)} events"
        + (f", {len(carried)} carried forward" if carried else "")
    )
    for reason, count in sorted(skipped.items()):
        ctx.report.notes.append(f"  skipped {count}: {reason}")


def _purpose(known: OrgLookup, org_key: str, url: str) -> FetchPurpose:
    """The society purpose for a card: on the society's own domain it is its
    website (D3 ``society_website``); elsewhere only the URL classes the
    policy recognises by shape (an SU ``/asset/`` file) may be overridden."""
    org = known.get(org_key)
    domain = domain_of(url)
    if org is not None and domain is not None and domain in org.domains:
        return SOCIETY_WEBSITE
    return SOCIETY


def page_events(
    client: PoliteClient,
    url: str,
    purpose: FetchPurpose,
    *,
    org_key: str,
    org_name: str,
    now: datetime,
    llm: LLMClient,
    memo: LLMMemo | None,
    calendar: TermCalendar,
) -> list[EventObservation] | None:
    """The events a termcard URL lists as HTML text when it links no card
    file: read like a society's events page (`sources.websites.events`), from
    the copy `fetch_termcard` just cached. None when there is no such page."""
    cached = client.cached(url, purpose)
    if cached is None or "html" not in (cached.content_type or "").lower():
        return None
    page = parse_page(cached.final_url or url, cached.text)
    if {"noindex", "none"} & page.robots:
        return None
    site = website_events.Site(org_key, org_name, page.url)
    out = website_events.SiteResult(site)
    found = website_events.llm_events(
        page,
        cached,
        site,
        llm=llm,
        memo=memo,
        calendar=calendar,
        out=out,
        source_type=SOURCE_TYPE,
        event_source=EVENT_SOURCE,
    )
    return website_events.current(found, website_events.window_from(now), out.tally)


def _organiser(record: EventObservation) -> str | None:
    keys = [o.identity.known_key for o in record.organisers if o.identity.known_key]
    return keys[0] if keys else None


__all__ = ["page_events", "run"]
