"""Reading a term card or an event poster with the strong model's vision
(source-research §21 "Read", "Dates") — one path for the `termcards` stage
(a `termcardUrl`) and for the cards a society's events page shows as images
(`sources.websites.events`, §14 "Events pages").

1. **Read** (prompt `image_events_v1`, strong tier): PDFs are rendered page
   by page (`extract.images.render_pdf`), four pages a call and at most
   `MAX_CARD_PAGES`, each call with its pages' text layer; images are sent
   as they are (shrunk). Quotes are checked against the PDF's text layer —
   an image-only card has no text to check against, so its values stay
   ``inferred``. Replies are cached by the request: the card's bytes (its
   sha256 is part of the cache key) and the reference date — the week the
   card was published (its upload path or ``Last-Modified``), else the
   Thursday that starts this week — so an unchanged card is asked about once,
   by whichever stage reads it.
2. **Every event needs its date in a quote** (`extract.dating.card_dated_quote`):
   the day number for a calendar date, the week and a weekday for a term
   week; a room booking is no event (`events.checks.is_booking`).
3. **The year** of a yearless date is trusted only with a second signal
   (`extract.dating.year_problem`): the card names its term with the year
   and the date falls in it, the card was published this academic year (its
   upload path or ``Last-Modified``, `sources.termcards.published_on`), its
   weekdays agree with this year, or the page showing it names this year or
   the term; a stated weekday must fall on the date, and a page about an
   earlier season gives no yearless dates at all. The year is then our
   inference: the start is ``inferred``.
4. **Term weeks** ("Week 3 Wednesday") need the term: the card's own words
   ("Michaelmas 2026", "MT26") win, then its URL or file name, then the words
   beside it on the page (its alt text, the heading above it), then the
   card's own calendar-dated rows when they all fall in one verified term
   (`extract.when.term_of_dates`) — dates computed from that inferred term are
   claimed ``inferred``. A card that gives none of these keeps only its events
   with calendar dates: it may be last term's.
5. Events are **public** (the society published the card), or
   ``members_only`` where the card says so, organised by the card's
   organisation, with external ids ``<org key>:<date>:<title slug>``.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta

from camsocs_pipeline.events.checks import is_booking
from camsocs_pipeline.events.common import Tally
from camsocs_pipeline.extract.dating import (
    PageDating,
    card_dated_quote,
    weekdays_agree,
    year_problem,
)
from camsocs_pipeline.extract.events import (
    CallBudget,
    EventContext,
    LlmEvent,
    LlmEvents,
    build_events,
    extract_events,
    load_prompt,
    redact_contacts,
)
from camsocs_pipeline.extract.images import render_pdf, vision_image
from camsocs_pipeline.extract.llm import LLMClient, assert_llm_source_allowed
from camsocs_pipeline.extract.memo import LLMMemo
from camsocs_pipeline.extract.when import TermCalendar, london_date, term_of_dates, week_anchor
from camsocs_pipeline.models.observation import EventObservation, FetchInfo
from camsocs_pipeline.sources.policy import AI_OVERRIDE_NOTE
from camsocs_pipeline.sources.termcards import (
    TermcardFile,
    published_on,
    published_this_year,
    term_hint,
)

SOURCE_TYPE = "termcard"
EVENT_SOURCE = "termcard"
PROMPT = "image_events_v1"
#: Pages of one PDF card read at most (four a model call).
MAX_CARD_PAGES = 12
#: A named term's dates run from its Week 0 to a week after Full Term.
_TERM_TAIL = timedelta(days=7)


@dataclass(frozen=True)
class CardHints:
    """What the page showing a card says about it (§14 "Events pages")."""

    #: Words beside the card that may name its term: its alt text and label,
    #: the heading above it.
    term_text: str = ""
    #: What the page says about its own year (`extract.dating.page_dating`).
    page: PageDating | None = None


def card_fetch_info(card: TermcardFile) -> FetchInfo:
    """The card's `sources` row, with any D3 override on its access note."""
    notes = [note for note in (card.fetch.override,) if note]
    if card.ai_override:
        notes.append(AI_OVERRIDE_NOTE)
    return FetchInfo(
        http_status=card.fetch.status,
        robots_verdict="disallowed" if card.fetch.override else "allowed",
        access_note="; ".join(notes) or None,
    )


def _chunks(card: TermcardFile) -> list[tuple[tuple[bytes, ...], str]]:
    """``(page images, text layer)`` per model call: a PDF four pages at a
    time up to `MAX_CARD_PAGES`; an image whole, without a text layer."""
    if card.kind != "pdf":
        image = vision_image(card.data)
        return [((image,), "")] if image else []
    chunks: list[tuple[tuple[bytes, ...], str]] = []
    first = 0
    while first < MAX_CARD_PAGES:
        rendered = render_pdf(card.data, first_page=first)
        if rendered is None or not rendered.images:
            break
        chunks.append((tuple(rendered.images), redact_contacts(rendered.text)))
        first += len(rendered.images)
        if first >= rendered.pages:
            break
    return chunks


def _dated(events: Sequence[LlmEvent]) -> list[date]:
    """The calendar dates the card itself prints."""
    days: list[date] = []
    for event in events:
        try:
            days.append(date.fromisoformat((event.date or "").strip()[:10]))
        except ValueError:
            continue
    return days


def _dropped(reason: str) -> str:
    """`build_events`' reasons as the stages count them."""
    if "long before" in reason:
        return "past"
    if "implausibly far" in reason:
        return "more than nine months ahead"
    return "undated or term-less"


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
    hints: CardHints | None = None,
    budget: CallBudget | None = None,
    drops: Tally | None = None,
) -> list[EventObservation]:
    """The events on one card file (module docstring). What it leaves out is
    counted in `drops` when given, else summed up in `notes`. Raises
    `extract.events.OverBudget` when `budget` has no room for a call."""
    today = london_date(now)
    anchor = week_anchor(today)
    chunks = _chunks(card)
    if not chunks:
        notes.append(f"  unreadable termcard file for {org_key}")
        return []

    # The host guard in front of the model call: never talks.cam (§6), even
    # if a card's URL got past the fetch-time checks.
    assert_llm_source_allowed(listed_url)
    assert_llm_source_allowed(card.url)
    prompt, version = load_prompt(PROMPT)
    # The model fills a yearless date's year from the reference date: the week
    # the card was published when its upload path or server says (so an
    # unchanged card is asked about once, whichever stage reads it), else this
    # week.
    published = published_on(card.url, card.fetch.last_modified, card.fetch.fetched_at)
    reference = week_anchor(published) if published is not None and published <= today else anchor
    replies: list[LlmEvents] = []
    model = ""
    for images, chunk_text in chunks:
        request = calendar.context(reference)
        if chunk_text:
            request += f"\n\n--- TEXT LAYER ---\n{chunk_text}"
        result = extract_events(
            llm,
            memo,
            prompt=prompt,
            prompt_version=version,
            text=request,
            tier="strong",
            images=images,
            budget=budget,
        )
        replies.append(result.value)
        model = result.model
    extracted = LlmEvents(
        society_name=next((r.society_name for r in replies if r.society_name), None),
        term=next((r.term for r in replies if r.term), None),
        term_year=next((r.term_year for r in replies if r.term), None),
        events=[event for reply in replies for event in reply.events],
    )
    text_layer = "\n".join(chunk_text for _images, chunk_text in chunks if chunk_text)
    term_name, term_year = extracted.term, extracted.term_year
    if term_name is None:
        term_name, term_year = term_hint(f"{listed_url} {card.url}")
    if term_name is None and hints is not None:
        term_name, term_year = term_hint(hints.term_text)
    term = calendar.term_named(term_name, term_year, anchor)

    # A page about an earlier season has decided already which of its cards
    # are read (those that date themselves this year): its staleness is not
    # the card's.
    page = hints.page if hints is not None else None
    dating = PageDating(
        current=page.current if page else False,
        term=term is not None,
        weekdays=weekdays_agree(extracted.events),
        fresh=published_this_year(published, today),
        term_span=(term.week_start(0), term.end + _TERM_TAIL)
        if term is not None and term_year is not None
        else None,
    )
    left_out: list[str] = []
    kept: list[LlmEvent] = []
    for event in extracted.events:
        if is_booking(event.title):
            left_out.append("a room booking, not an event")
        elif not card_dated_quote(event):
            left_out.append("no dated quote on the card")
        elif (problem := year_problem(event, today, dating)) is not None:
            left_out.append(problem)
        else:
            kept.append(event)
    term_inferred = False
    if term is None:
        # The card's own dated rows (those kept) may say which term it is for.
        term = term_of_dates(_dated(kept), calendar)
        term_inferred = term is not None
    context = EventContext(
        source_type=SOURCE_TYPE,
        event_source=EVENT_SOURCE,
        source_url=card.url,
        retrieved_at=now,
        source_text=text_layer,
        model=model,
        prompt_version=version,
        evidence="primary",
        visibility="public",
        # Undated weekdays and yearless dates are read from the card's own
        # term when it names one.
        anchor=term.week_start(0) if term else anchor,
        calendar=calendar,
        term=term,
        require_term=True,
        term_inferred=term_inferred,
        scope=org_key,
        organiser_key=org_key,
        organiser_name=org_name,
        content_sha256=card.content_sha256 or None,
        fetch=card_fetch_info(card),
    )
    events, dropped = build_events(
        LlmEvents(term=extracted.term, term_year=extracted.term_year, events=kept), context
    )
    left_out += [_dropped(reason) for reason in dropped]
    if drops is not None:
        for reason in left_out:
            drops.drop(reason)
    elif left_out:
        counts: dict[str, int] = {}
        for reason in left_out:
            counts[reason] = counts.get(reason, 0) + 1
        notes.append(
            f"  {len(left_out)} event(s) left out of a card of {org_key}: "
            + ", ".join(f"{n} {why}" for why, n in sorted(counts.items()))
        )
    return events


__all__ = [
    "EVENT_SOURCE",
    "MAX_CARD_PAGES",
    "SOURCE_TYPE",
    "CardHints",
    "card_events",
    "card_fetch_info",
]
