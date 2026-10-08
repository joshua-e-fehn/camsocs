"""Stage `termcards`: a term's events from societies' termcards (source-research §21).

1. **Inputs**: every `termcardUrl` an organisation has in staging
   (`KnownOrgs.termcards`; the SU, website and enrichment harvesters claim it).
2. **Fetch** politely (`sources.termcards.fetch_termcard`): the file, or the
   first termcard file a page links or embeds. SU-hosted cards (§21),
   talks.cam and social networks are never fetched; robots-blocked, 401/403
   and 404 cards, and cards from a host that keeps AI out (§14: an AI crawler
   disallowed by name, `Content-Signal: ai-input=no`, a `noai` page), are
   skipped with the reason — never "found", never sent to the model.
3. **Read** with the strong model's vision (`image_events_v1`): PDFs are
   rendered page by page (`extract.images.render_pdf`, at most four pages) and
   their text layer goes along; images are sent as they are (shrunk). Quotes
   are checked against the PDF's text layer — an image-only card has no text
   to check against, so its values stay `inferred`. Replies are cached by the
   file's content hash, so an unchanged card costs nothing on later runs.
4. **Dates**: "Week 3 Wednesday" needs to know the term. The card's own words
   ("Michaelmas 2026", "MT26") win, then the URL or file name; a card that
   says neither keeps only its events with calendar dates — it may be last
   term's.
5. Events are **public** (the society published the card), or `members_only`
   where the card says so, organised by the card's organisation, and dropped
   when another source already has them (`extract.dedupe`).

The stage writes `var/staging/termcard/<run>.jsonl` with the full current set:
cards read this run plus the previous file's events for cards not reached
(the `--limit` budget), because `load` posts only the latest file.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from camsocs_pipeline.extract.dedupe import EventIndex
from camsocs_pipeline.extract.events import (
    EventContext,
    build_events,
    extract_events,
    load_prompt,
    redact_contacts,
)
from camsocs_pipeline.extract.images import render_pdf, vision_image
from camsocs_pipeline.extract.llm import LLMClient, LLMValidationError, assert_llm_source_allowed
from camsocs_pipeline.extract.memo import LLMMemo
from camsocs_pipeline.extract.when import TermCalendar, london_date
from camsocs_pipeline.known_orgs import KnownOrgs
from camsocs_pipeline.models.observation import EventObservation, FetchInfo
from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.sources.base import PoliteClient
from camsocs_pipeline.sources.termcards import Skipped, TermcardFile, fetch_termcard, term_hint

logger = logging.getLogger(__name__)

SOURCE_TYPE = "termcard"
EVENT_SOURCE = "termcard"
MAX_TERMCARDS_PER_RUN = 60


def run(ctx: StageContext) -> None:
    known = KnownOrgs.from_staging(ctx.staging)
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
            fetched = fetch_termcard(client, url)
            if isinstance(fetched, Skipped):
                reason = fetched.reason.split(" (", 1)[0]
                skipped[reason] = skipped.get(reason, 0) + 1
                continue
            org = known.get(org_key)
            try:
                found = card_events(
                    fetched,
                    org_key=org_key,
                    org_name=org.display_name if org else org_key,
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
    ctx.report.skipped += sum(skipped.values())
    ctx.report.notes.append(
        f"{len(cards)} termcards known, {read} read, {len(events)} events"
        + (f", {len(carried)} carried forward" if carried else "")
    )
    for reason, count in sorted(skipped.items()):
        ctx.report.notes.append(f"  skipped {count}: {reason}")


def _organiser(record: EventObservation) -> str | None:
    keys = [o.identity.known_key for o in record.organisers if o.identity.known_key]
    return keys[0] if keys else None


def card_events(
    card: TermcardFile,
    *,
    org_key: str,
    org_name: str,
    listed_url: str,
    now: datetime,
    llm: LLMClient,
    memo: LLMMemo | None,
    calendar: TermCalendar,
    notes: list[str],
) -> list[EventObservation]:
    """The events on one termcard file."""
    anchor = london_date(now)
    text_layer = ""
    if card.kind == "pdf":
        rendered = render_pdf(card.data)
        images = tuple(rendered.images) if rendered else ()
        text_layer = redact_contacts(rendered.text) if rendered else ""
    else:
        image = vision_image(card.data)
        images = (image,) if image else ()
    if not images:
        notes.append(f"  unreadable termcard file for {org_key}")
        return []

    # The host guard in front of the model call: never talks.cam (§6), even
    # if a card's URL got past the fetch-time checks.
    assert_llm_source_allowed(listed_url)
    assert_llm_source_allowed(card.url)
    prompt, version = load_prompt("image_events_v1")
    request = calendar.context(anchor)
    if text_layer:
        request += f"\n\n--- TEXT LAYER ---\n{text_layer}"
    result = extract_events(
        llm,
        memo,
        prompt=prompt,
        prompt_version=version,
        text=request,
        tier="strong",
        images=images,
    )
    extracted = result.value
    term_name, term_year = extracted.term, extracted.term_year
    if term_name is None:
        term_name, term_year = term_hint(f"{listed_url} {card.url}")
    term = calendar.term_named(term_name, term_year, anchor)
    context = EventContext(
        source_type=SOURCE_TYPE,
        event_source=EVENT_SOURCE,
        source_url=card.url,
        retrieved_at=now,
        source_text=text_layer,
        model=result.model,
        prompt_version=version,
        evidence="primary",
        visibility="public",
        # Undated weekdays and yearless dates are read from the card's own
        # term when it names one.
        anchor=term.week_start(0) if term else anchor,
        calendar=calendar,
        term=term,
        require_term=True,
        scope=org_key,
        organiser_key=org_key,
        organiser_name=org_name,
        content_sha256=card.content_sha256 or None,
        fetch=FetchInfo(http_status=card.fetch.status),
    )
    events, dropped = build_events(extracted, context)
    if dropped:
        notes.append(f"  {len(dropped)} undated or term-less event(s) on a card of {org_key}")
    return events


__all__ = ["card_events", "run"]
