"""Events extracted by the LLM from free text or images, and how they become
`EventObservation`s — shared by the `inbox`, `instagram` and `termcards`
stages (source-research §16, §17, §21).

The model reports what the text says (`LlmEvent`): the title, the date words
("Wednesday of Week 3", "Thu 15 Oct", "tonight") as structured parts plus the
verbatim `when_quote`, times as HH:MM, the venue, price, booking link and a
verbatim description excerpt. `extract.when` resolves the date
deterministically; every value then becomes an `llm_field`, whose quote is
checked against the exact text the model was given (`claims.llm_field`), so
an unquoted or paraphrased value is `inferred`, never `found`.

Honesty rules enforced here, not left to prompts:

- a booking URL is kept only if it appears verbatim in the source text (the
  model may not invent or "fix" links);
- an event whose date cannot be resolved is dropped with a reason, never
  guessed;
- `members_only` wins over the stage's default visibility whenever the model
  says so — when in doubt, show less;
- classifications (`eventType`, `signupRequired`) carry no quote and are
  `inferred`;
- nothing about people except published speakers (name, affiliation).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from camsocs_pipeline.claims import epoch_ms, llm_field, parser_field
from camsocs_pipeline.extract.evidence import EvidenceMatch, check_quote, normalise_text
from camsocs_pipeline.extract.llm import LLMClient, Tier, vision_message
from camsocs_pipeline.extract.memo import LLMMemo, memo_key
from camsocs_pipeline.extract.when import (
    Term,
    TermCalendar,
    Unresolvable,
    When,
    WhenSpec,
    resolve_when,
)
from camsocs_pipeline.keys import sha1_hex, slugify
from camsocs_pipeline.models.observation import (
    EventObservation,
    FetchInfo,
    FieldObs,
    IdentityHints,
    OrganiserObs,
)
from camsocs_pipeline.models.vocab import EVENT_TYPES

PROMPTS_DIR = Path(__file__).parent / "prompts"

_URL = re.compile(r"https?://[^\s<>()\"']+", re.I)
_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_PHONE = re.compile(
    r"(?<![\d/])(?:\+44\s?\(?0?\)?\s?\d{2,4}|\(?0\d{2,4}\)?)[\s-]?\d{3,4}[\s-]?\d{3,4}(?!\d)"
)


def load_prompt(name: str) -> tuple[str, str]:
    """`(text, version)` of `extract/prompts/<name>.md`; the file name is the
    prompt version stored beside every claim it produced."""
    return (PROMPTS_DIR / f"{name}.md").read_text(encoding="utf-8"), name


def redact_contacts(text: str) -> str:
    """Email addresses and phone numbers → `[email]` / `[phone]` before text is
    sent to the LLM: events need neither, and list mail carries the
    subscriber's and committee members' addresses. Quotes are then checked
    against this same redacted text."""
    return _PHONE.sub("[phone]", _EMAIL.sub("[email]", text))


# --- what the model returns --------------------------------------------------------


class LlmSpeaker(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str
    affiliation: str | None = None


class LlmEvent(BaseModel):
    """One event as the text states it. Field descriptions are the contract the
    model sees (they are part of the JSON schema sent with every request)."""

    model_config = ConfigDict(extra="ignore")

    title: str = Field(description="The event's name, as written.")
    title_quote: str | None = Field(
        None, description="Verbatim words from the text that name the event."
    )
    description: str | None = Field(
        None,
        description="1-3 sentences copied VERBATIM from the text about this event; never "
        "paraphrase.",
    )
    date: str | None = Field(
        None,
        description="YYYY-MM-DD, only when the text gives a calendar date (day and month); "
        "fill the year from the reference date.",
    )
    term_week: int | None = Field(
        None, description="Term week number when the text says e.g. 'Week 3' / 'Wk 3' / '3rd week'."
    )
    weekday: str | None = Field(None, description="Weekday name, e.g. 'wednesday'.")
    relative_day: str | None = Field(
        None, description="'today', 'tonight' or 'tomorrow' when the text says so."
    )
    start_time: str | None = Field(None, description="24-hour HH:MM, only if stated.")
    end_time: str | None = Field(None, description="24-hour HH:MM, only if stated.")
    when_quote: str | None = Field(
        None, description="Verbatim words from the text that give the date and time."
    )
    venue: str | None = Field(None, description="Where, as written.")
    venue_quote: str | None = Field(None, description="Verbatim words giving the venue.")
    event_type: str | None = Field(None, description="One of: " + ", ".join(EVENT_TYPES))
    price_text: str | None = Field(
        None, description="Verbatim price words, e.g. '£5 members, £7 non-members'."
    )
    free: bool | None = Field(None, description="True only if the text says it is free.")
    min_price_pence: int | None = None
    max_price_pence: int | None = None
    booking_url: str | None = Field(
        None, description="A ticket/sign-up link exactly as it appears in the text; never invent."
    )
    signup_required: bool | None = None
    members_only: bool = Field(
        False, description="True if the text says the event is for members only."
    )
    members_only_quote: str | None = None
    cancelled: bool = Field(False, description="True if the text says it is cancelled.")
    cancelled_quote: str | None = None
    tbc: bool = Field(False, description="True if the date or details are 'TBC'.")
    tbc_quote: str | None = Field(
        None, description="Verbatim words from the text that say it is TBC / to be confirmed."
    )
    speakers: list[LlmSpeaker] = Field(default_factory=list)
    speakers_quote: str | None = None


class LlmEvents(BaseModel):
    """The whole reply for one text (an email, a caption, a termcard)."""

    model_config = ConfigDict(extra="ignore")

    society_name: str | None = Field(
        None, description="The organising society or club as it names itself, if stated."
    )
    society_name_quote: str | None = None
    term: str | None = Field(
        None, description="'michaelmas', 'lent' or 'easter' if the text names the term."
    )
    term_year: int | None = Field(None, description="The year of that term, if stated.")
    needs_image: bool = Field(
        False,
        description="True if the text refers to event details that are only in an attached "
        "image or poster (e.g. 'see poster', 'swipe for our termcard').",
    )
    events: list[LlmEvent] = Field(default_factory=list)


# --- turning them into observations ----------------------------------------------------


@dataclass
class EventContext:
    """Where an extraction came from and how its events are to be filed."""

    source_type: str
    event_source: str
    source_url: str
    retrieved_at: datetime
    #: The exact text the model was given; quotes are checked against it.
    source_text: str
    model: str
    prompt_version: str
    evidence: str
    visibility: str
    anchor: date
    calendar: TermCalendar
    #: Stable prefix for external ids: the organisation key, else the list,
    #: else the message — so a weekly mail repeating an event updates it.
    scope: str
    organiser_key: str | None = None
    organiser_name: str | None = None
    term: Term | None = None
    content_sha256: str | None = None
    #: `{storageId, sourceUrl}` of our stored copy of the post image, if any.
    image: dict[str, Any] | None = None
    fetch: FetchInfo | None = None
    #: Extra suffix for external ids (e.g. the attachment a vision pass read).
    id_suffix: str = ""
    #: Refuse term-week dates unless `term` is known (a termcard that does not
    #: say which term it is for may be last term's).
    require_term: bool = False
    notes: list[str] = field(default_factory=list)


def title_slug(title: str) -> str:
    """A stable short form of a title for external ids; titles with nothing
    ASCII (a Chinese society's event) fall back to a hash."""
    try:
        return slugify(title)[:60].rstrip("-")
    except ValueError:
        return f"h{sha1_hex(title.strip())[:12]}"


def verbatim_url(url: str | None, source_text: str) -> str | None:
    """The URL if it occurs in the source text (trailing punctuation
    tolerated), else None — a link the model produced is never trusted."""
    if not url:
        return None
    candidate = url.strip().rstrip(".,;:!?)")
    if not candidate.lower().startswith(("http://", "https://")):
        return None
    for found in _URL.findall(source_text):
        if found.rstrip(".,;:!?)") == candidate:
            return candidate
    return None


def external_id(context: EventContext, when: When, title: str) -> str:
    return f"{context.scope}:{when.local_date.isoformat()}:{title_slug(title)}{context.id_suffix}"


def _quote_or_value(quote: str | None, value: str | None) -> str | None:
    """The model's quote, else the value itself — a title or venue that occurs
    verbatim in the text is its own evidence."""
    return quote.strip() if quote and quote.strip() else value


def build_event(event: LlmEvent, context: EventContext) -> EventObservation:
    """One extracted event → an `EventObservation`. Raises `Unresolvable` when
    its date cannot be pinned down, and `ValueError` for an empty title."""
    title = " ".join(event.title.split())
    if not title:
        raise ValueError("event without a title")
    if event.term_week is not None and not event.date and context.require_term and not context.term:
        raise Unresolvable("a term week, but the source does not say which term")
    when = resolve_when(
        WhenSpec(
            date=event.date,
            term_week=event.term_week,
            weekday=event.weekday,
            relative_day=event.relative_day,
            start_time=event.start_time,
            end_time=event.end_time,
        ),
        anchor=context.anchor,
        calendar=context.calendar,
        term=context.term,
    )

    def llm(name: str, value: Any, quote: str | None) -> FieldObs:
        return llm_field(
            name,
            value,
            quote=quote,
            source_text=context.source_text,
            source_type=context.source_type,
            model=context.model,
            prompt_version=context.prompt_version,
            evidence=context.evidence,
        )

    when_quote = event.when_quote
    # Without a stated time the event is filed as all day at midnight: a
    # representation of "no time given", not a fact the text states — both
    # are `inferred`, with no quote (the date's words stay in valueRaw).
    timed = not when.all_day
    fields: list[FieldObs] = [
        llm("title", title[:300], _quote_or_value(event.title_quote, title)),
        llm("startsAt", epoch_ms(when.starts_at), when_quote if timed else None),
        llm("allDay", when.all_day, when_quote if timed else None),
    ]
    fields[1].value_raw = when_quote
    if when.ends_at is not None:
        fields.append(llm("endsAt", epoch_ms(when.ends_at), when_quote))
    if event.description and event.description.strip():
        text = event.description.strip()[:20_000]
        fields.append(llm("description", text, text))
    if event.venue and event.venue.strip():
        venue = " ".join(event.venue.split())[:300]
        fields.append(llm("venueText", venue, _quote_or_value(event.venue_quote, venue)))
    event_type = (event.event_type or "").strip().lower()
    fields.append(llm("eventType", event_type if event_type in EVENT_TYPES else "other", None))
    price = _price(event)
    if price is not None:
        fields.append(llm("price", price, event.price_text))
    booking = verbatim_url(event.booking_url, context.source_text)
    if booking:
        fields.append(llm("bookingUrl", booking, booking))
    if event.signup_required is not None:
        fields.append(llm("signupRequired", event.signup_required, None))
    if event.cancelled:
        fields.append(llm("cancelled", True, event.cancelled_quote))
    if event.tbc:
        # Its own words ("TBC", "to be confirmed"), never the date's.
        fields.append(llm("status", "tbc", event.tbc_quote))
    speakers = [
        {"name": " ".join(s.name.split()), "affiliation": s.affiliation or None}
        for s in event.speakers
        if s.name and s.name.strip()
    ]
    if speakers:
        # One quote for the list: it supports the list only if every name is
        # in the text too.
        named = all(
            check_quote(speaker["name"], context.source_text) is not EvidenceMatch.ABSENT
            for speaker in speakers
        )
        fields.append(llm("speakers", speakers, event.speakers_quote if named else None))
    if context.image:
        fields.append(
            parser_field(
                "image",
                context.image,
                extractor=f"{context.event_source}.media",
                evidence="primary",
            )
        )

    visibility = "members_only" if event.members_only else context.visibility
    organisers = (
        [
            OrganiserObs(
                identity=IdentityHints(
                    name=context.organiser_name or context.organiser_key,
                    known_key=context.organiser_key,
                )
            )
        ]
        if context.organiser_key
        else []
    )
    return EventObservation(
        source_type=context.source_type,
        source_key=external_id(context, when, title),
        source_url=context.source_url,
        retrieved_at=context.retrieved_at,
        content_sha256=context.content_sha256,
        fetch=context.fetch,
        fields=fields,
        event_source=context.event_source,
        external_id=external_id(context, when, title),
        visibility=visibility,
        organisers=organisers,
    )


def _price(event: LlmEvent) -> dict[str, Any] | None:
    text = (event.price_text or "").strip()
    if not text and event.free is None:
        return None
    price: dict[str, Any] = {"free": bool(event.free)}
    if text:
        price["text"] = text[:300]
    for name, value in (("minPence", event.min_price_pence), ("maxPence", event.max_price_pence)):
        if value is not None and 0 <= value <= 1_000_000:
            price[name] = int(value)
    return price


def build_events(
    extracted: LlmEvents, context: EventContext
) -> tuple[list[EventObservation], list[str]]:
    """Every extracted event that resolves, plus a note per dropped one."""
    observations: list[EventObservation] = []
    dropped: list[str] = []
    seen: set[str] = set()
    for event in extracted.events:
        try:
            observation = build_event(event, context)
        except (Unresolvable, ValueError) as error:
            dropped.append(f"{event.title[:60]!r}: {error}")
            continue
        if observation.external_id in seen:
            continue
        seen.add(observation.external_id)
        observations.append(observation)
    return observations, dropped


@dataclass(frozen=True)
class Extraction:
    value: LlmEvents
    model: str
    cached: bool


def extract_events(
    llm: LLMClient,
    memo: LLMMemo | None,
    *,
    prompt: str,
    prompt_version: str,
    text: str,
    tier: Tier = "bulk",
    images: tuple[bytes, ...] = (),
) -> Extraction:
    """Ask the model for `LlmEvents` about `text` (and `images`, with the
    strong tier), reusing a cached reply for identical inputs. Raises
    `LLMValidationError` when the reply does not validate after one retry."""
    key = memo_key(prompt_version, tier, llm.model_for(tier), text, *images)
    if memo is not None:
        cached = memo.get(prompt_version, key, LlmEvents)
        if cached is not None:
            return Extraction(cached[0], cached[1], True)
    user = vision_message(text, images) if images else {"role": "user", "content": text}
    call = llm.complete_json(
        schema=LlmEvents,
        messages=[{"role": "system", "content": prompt}, user],
        prompt_version=prompt_version,
        tier=tier,
    )
    if memo is not None:
        memo.put(prompt_version, key, call.value, call.model)
    return Extraction(call.value, call.model, False)


def quote_supported(quote: str | None, source_text: str) -> bool:
    """Whether a quote occurs in the text (normalised), for decisions taken
    outside a claim (e.g. trusting a society name the model read)."""
    if not quote or len(normalise_text(quote)) < 3:
        return False
    return normalise_text(quote) in normalise_text(source_text)


__all__ = [
    "PROMPTS_DIR",
    "EventContext",
    "Extraction",
    "LlmEvent",
    "LlmEvents",
    "LlmSpeaker",
    "build_event",
    "build_events",
    "external_id",
    "extract_events",
    "load_prompt",
    "quote_supported",
    "redact_contacts",
    "title_slug",
    "verbatim_url",
]
