"""Stage `inbox`: events from forwarded society list mail (source-research §16).

For each `pending` mail in Convex (`ConvexLoader.inbound_pending`):

1. **Skip non-list mail** before any LLM call: no `List-Id`, no
   lists.cam.ac.uk sender and no known organisation → `skipped`.
2. **Identify the sender** deterministically (`sources.inbox.identify_sender`:
   recorded org; then, only for a mail whose sender a trusted receiver
   verified, List-Id → Sympa list on record, sender address / own domain),
   against the organisations in staging (`known_orgs.KnownOrgs`). An
   unverified mail is never attributed and claims no activity.
3. **Extract events** with the bulk model (`extract/prompts/email_events_v1.md`)
   from the subject and text, with e-mail addresses and phone numbers redacted
   first. One mail often lists a week of events with dates like "Wednesday of
   Week 3"; `extract.when` resolves them against the verified term dates and
   the mail's date. Every value carries its verbatim quote, checked against the
   text the model saw. A society name the model reads from the sign-off
   identifies the sender only when its quote checks out.
4. **Posters and termcards attached** (images, PDFs) are read with the strong
   model's vision when the text found no events, says to see the attachment,
   or the file is named like a termcard. Image-only claims cannot be checked
   against text and stay `inferred`.
5. **Visibility** is `cam_only` (list mail is for list members), or
   `members_only` when the mail says so — never public.
6. Events another source already has (same organiser, start and similar
   title; `extract.dedupe`) are dropped.
7. The events are **posted here**, then each mail is **marked** `done`
   (with its event keys), `skipped` or `failed`. Posting before marking keeps
   "done" true only once the events have landed; a crash leaves the mail
   `pending` for the next run. A transport failure (LLM or Convex) also leaves
   it pending; a reply that never validates marks it `failed`.

The observations are also written to `var/staging/mailing_list_email/` as a
record; the `load` stage re-posts them as a no-op (fingerprints match).

Mail is personal data: nothing here logs a subject, sender or body.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import UTC, date, datetime

from camsocs_pipeline.claims import epoch_ms, parser_field
from camsocs_pipeline.extract.dedupe import EventIndex
from camsocs_pipeline.extract.events import (
    EventContext,
    LlmEvents,
    build_events,
    extract_events,
    load_prompt,
    quote_supported,
    redact_contacts,
)
from camsocs_pipeline.extract.images import render_pdf, vision_image
from camsocs_pipeline.extract.llm import LLMClient, LLMValidationError
from camsocs_pipeline.extract.memo import LLMMemo
from camsocs_pipeline.extract.redact import redactor_for
from camsocs_pipeline.extract.when import TermCalendar, london_date
from camsocs_pipeline.keys import event_key, sha1_hex
from camsocs_pipeline.known_orgs import KnownOrgs
from camsocs_pipeline.models.observation import EventObservation, IdentityHints, Observation
from camsocs_pipeline.models.wire import InboundMark, PendingMail
from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.pipeline.load import ConvexLoader
from camsocs_pipeline.sources.inbox import (
    header_list_name,
    identify_sender,
    is_list_mail,
    list_name_of,
)

logger = logging.getLogger(__name__)

SOURCE_TYPE = "mailing_list_email"
EVENT_SOURCE = "mailing_list"
#: Mails taken per run when no `--limit` is given.
DEFAULT_BATCH = 50
#: Attachments read with vision per mail.
MAX_VISION_ATTACHMENTS = 3
VISION_TYPES = frozenset({"image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"})
_TERMCARD_NAME = ("termcard", "term card", "term-card", "poster", "flyer", "programme", "schedule")


@dataclass
class MailOutcome:
    mail: PendingMail
    #: `done` / `skipped` / `failed`; None = leave pending (transient failure).
    extraction: str | None
    org_key: str | None = None
    events: list[EventObservation] = field(default_factory=list)
    extra: list[Observation] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


@dataclass
class InboxTools:
    llm: LLMClient
    memo: LLMMemo | None
    known: KnownOrgs
    index: EventIndex
    calendar: TermCalendar
    loader: ConvexLoader
    #: The clock (tests pin it).
    now: Callable[[], datetime] = field(default=lambda: datetime.now(UTC))


def run(ctx: StageContext) -> None:
    pending = ctx.loader.inbound_pending(limit=ctx.limit or DEFAULT_BATCH)
    if not pending:
        ctx.report.notes.append("no pending mail")
        return
    tools = InboxTools(
        llm=LLMClient(ctx.settings.require_llm()),
        memo=LLMMemo(ctx.settings.cache_dir / "llm"),
        known=KnownOrgs.from_staging(ctx.staging),
        index=EventIndex.from_staging(ctx.staging, exclude=[SOURCE_TYPE]),
        calendar=TermCalendar.default(),
        loader=ctx.loader,
    )
    workers = max(1, min(ctx.settings.llm_concurrency, len(pending)))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        outcomes = list(pool.map(lambda mail: process_mail(mail, tools), pending))
    finish(ctx, outcomes)


def finish(ctx: StageContext, outcomes: Sequence[MailOutcome]) -> None:
    """Post the events, then mark the mails; record counts and state."""
    records = [record for o in outcomes for record in (*o.events, *o.extra)]
    if records:
        with ctx.staging.writer(SOURCE_TYPE, ctx.run.run_key) as out:
            out.write_all(records)
        # Event descriptions are public text: names become roles (D1).
        redactor, note = redactor_for(ctx.settings, dry_run=ctx.dry_run)
        if note:
            ctx.report.notes.append(note)
        report = ctx.loader.post_observations(records, run_key=ctx.run.run_key, redactor=redactor)
        ctx.report.inserted += report.claims.inserted
        ctx.report.updated += report.claims.updated
        ctx.report.unchanged += report.claims.unchanged
        rejected = [item for result in report.results() for item in result.rejected]
        if rejected:
            ctx.report.notes.append(f"{len(rejected)} claims or events refused by the server")

    marks = [
        InboundMark(
            message_id=o.mail.message_id,
            extraction=o.extraction,
            extracted_event_keys=[event_key(e.event_source, e.external_id) for e in o.events],
            org_key=o.org_key,
            note="; ".join(o.notes)[:2_000] or None,
        )
        for o in outcomes
        if o.extraction is not None
    ]
    if marks:
        ctx.loader.mark_inbound(marks)

    counts: dict[str, int] = {}
    for outcome in outcomes:
        counts[outcome.extraction or "left pending"] = (
            counts.get(outcome.extraction or "left pending", 0) + 1
        )
    ctx.report.skipped += counts.get("skipped", 0)
    events = sum(len(o.events) for o in outcomes)
    ctx.report.notes.append(
        f"{len(outcomes)} mails: "
        + ", ".join(f"{count} {name}" for name, count in sorted(counts.items()))
        + f"; {events} events"
    )

    if not ctx.dry_run:
        seen = ctx.state.data("inbox").setdefault("org_last_mail", {})
        lists = ctx.state.data("inbox").setdefault("lists_seen", {})
        for outcome in outcomes:
            when = datetime.fromtimestamp(outcome.mail.received_at / 1000, UTC).isoformat()
            if outcome.org_key:
                seen[outcome.org_key] = max(seen.get(outcome.org_key, ""), when)
            list_name = list_name_of(outcome.mail)
            if list_name:
                lists[list_name] = max(lists.get(list_name, ""), when)


def process_mail(mail: PendingMail, tools: InboxTools) -> MailOutcome:
    """One mail → its events and outcome. Never raises for one bad mail."""
    try:
        return _process(mail, tools)
    except LLMValidationError as error:
        return MailOutcome(mail, "failed", notes=[f"LLM reply did not validate: {error}"[:500]])
    except Exception as error:  # a transport failure: try again next run
        logger.warning("inbox: leaving a mail pending after %s", type(error).__name__)
        return MailOutcome(mail, None, notes=[f"{type(error).__name__}"])


def _process(mail: PendingMail, tools: InboxTools) -> MailOutcome:
    identified = identify_sender(mail, tools.known)
    if not is_list_mail(mail) and identified.org_key is None:
        return MailOutcome(mail, "skipped", notes=["not list mail"])

    # Never later than now: the claims API refuses a future retrieval time.
    received = min(datetime.fromtimestamp(mail.received_at / 1000, UTC), tools.now())
    anchor = london_date(received)
    body = redact_contacts(mail.text).strip()
    source_text = f"Subject: {redact_contacts(mail.subject)}\n\n{body}"
    calendar_note = tools.calendar.context(anchor)
    prompt, version = load_prompt("email_events_v1")

    org_key = identified.org_key
    notes = [f"sender: {identified.how}"]
    extracted = LlmEvents()
    model = tools.llm.model_for("bulk")
    if body:
        result = extract_events(
            tools.llm,
            tools.memo,
            prompt=prompt,
            prompt_version=version,
            text=f"{calendar_note}\n\n--- EMAIL ---\n{source_text}",
        )
        extracted, model = result.value, result.model
        # A sign-off names the society only on a verified list mail: anyone
        # can sign a mail with a society's name.
        if (
            org_key is None
            and mail.sender_verified
            and header_list_name(mail) is not None
            and quote_supported(extracted.society_name_quote, source_text)
        ):
            org_key = tools.known.by_name(extracted.society_name)
            if org_key:
                notes[0] = "sender: society name in the mail"

    org = tools.known.get(org_key) if org_key else None
    list_name = list_name_of(mail)
    scope = org_key or (
        f"list:{list_name}" if list_name else f"msg:{sha1_hex(mail.message_id)[:16]}"
    )

    def context(text: str, used_model: str, used_version: str, suffix: str = "") -> EventContext:
        return EventContext(
            source_type=SOURCE_TYPE,
            event_source=EVENT_SOURCE,
            source_url=f"inbound:{mail.message_id}",
            retrieved_at=received,
            source_text=text,
            model=used_model,
            prompt_version=used_version,
            # The organisation's own list is its own channel; an unidentified
            # sender is anyone's.
            evidence="primary" if org_key else "secondary",
            visibility="cam_only",
            anchor=anchor,
            calendar=tools.calendar,
            term=tools.calendar.term_named(extracted.term, extracted.term_year, anchor),
            scope=scope,
            organiser_key=org_key,
            organiser_name=org.display_name if org else None,
            id_suffix=suffix,
        )

    events, dropped = build_events(extracted, context(source_text, model, version))
    if dropped:
        notes.append(f"{len(dropped)} undated or implausible")

    if mail.attachments and (
        not events
        or extracted.needs_image
        or any(_termcard_like(a.filename) for a in mail.attachments)
    ):
        events.extend(_attachment_events(mail, tools, context, anchor, notes))

    kept = [event for event in events if not tools.index.is_duplicate_record(event)]
    if len(kept) < len(events):
        notes.append(f"{len(events) - len(kept)} already known from another source")

    extra: list[Observation] = []
    if org_key:
        extra.append(_activity(org_key, org.display_name if org else org_key, mail, received))
    if not kept:
        return MailOutcome(mail, "skipped", org_key, [], extra, [*notes, "no events"])
    return MailOutcome(mail, "done", org_key, kept, extra, notes)


def _termcard_like(filename: str) -> bool:
    lowered = filename.lower()
    return any(word in lowered for word in _TERMCARD_NAME)


def _attachment_events(
    mail: PendingMail,
    tools: InboxTools,
    context: Callable[..., EventContext],
    anchor: date,
    notes: list[str],
) -> list[EventObservation]:
    """Events read from attached posters / termcards with the strong model."""
    prompt, version = load_prompt("image_events_v1")
    anchor_note = tools.calendar.context(anchor)
    found: list[EventObservation] = []
    readable = [a for a in mail.attachments if a.content_type in VISION_TYPES]
    for attachment in readable[:MAX_VISION_ATTACHMENTS]:
        data = tools.loader.inbound_file(mail.message_id, attachment.storage_id)
        if data is None:
            notes.append("an attachment was not found")
            continue
        text_layer = ""
        if attachment.content_type == "application/pdf":
            rendered = render_pdf(data)
            images = tuple(rendered.images) if rendered else ()
            text_layer = redact_contacts(rendered.text) if rendered else ""
        else:
            image = vision_image(data)
            images = (image,) if image else ()
        if not images:
            notes.append("an attachment could not be read")
            continue
        result = extract_events(
            tools.llm,
            tools.memo,
            prompt=prompt,
            prompt_version=version,
            text=f"{anchor_note}\n\n--- TEXT LAYER ---\n{text_layer}"
            if text_layer
            else anchor_note,
            tier="strong",
            images=images,
        )
        # Quotes from an image can only be checked against a PDF's text layer.
        attachment_context = context(
            text_layer, result.model, version, f"#{sha1_hex(attachment.storage_id)[:8]}"
        )
        if result.value.term:
            attachment_context.term = tools.calendar.term_named(
                result.value.term, result.value.term_year, anchor
            )
        events, dropped = build_events(result.value, attachment_context)
        if dropped:
            notes.append(f"{len(dropped)} undated in an attachment")
        found.extend(events)
    if readable:
        notes.append(f"read {min(len(readable), MAX_VISION_ATTACHMENTS)} attachment(s)")
    return found


def _activity(org_key: str, name: str, mail: PendingMail, received: datetime) -> Observation:
    """The mail itself is dated activity of its organisation (`lastActiveAt`,
    which takes the maximum of all claims)."""
    return Observation(
        source_type=SOURCE_TYPE,
        source_key=mail.message_id,
        source_url=f"inbound:{mail.message_id}",
        retrieved_at=received,
        entity_type="organisation",
        identity=IdentityHints(name=name, known_key=org_key),
        entity_key=org_key,
        fields=[
            parser_field(
                "lastActiveAt",
                epoch_ms(received),
                extractor="inbox.received",
                evidence="primary",
            )
        ],
    )


__all__ = ["InboxTools", "MailOutcome", "finish", "process_mail", "run"]
