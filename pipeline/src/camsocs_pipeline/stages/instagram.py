"""Stage `instagram`: events from societies' public Instagram posts, through the
official Business Discovery API only (source-research §17).

Gated on `META_IG_USER_ID` + `META_ACCESS_TOKEN`: without both it notes
"skipped: not configured" and succeeds, so a cron without Meta access stays
green. instagram.com is never fetched.

1. **Targets**: organisations in staging with exactly one Instagram handle
   that no other organisation claims (`KnownOrgs.instagram_targets`).
2. **Rotation**: Business Discovery is rate-limited per hour, so a run checks
   at most `MAX_HANDLES_PER_RUN` (or `--limit`) handles — never-checked first,
   then the longest unchecked; a handle checked in the last `RECHECK_HOURS` is
   not due, and one that is not a professional account is retried after
   `NOT_PROFESSIONAL_RETRY_DAYS`. A throttle or high `X-App-Usage` ends the
   run's checks; an invalid token fails the stage with a message to renew it.
3. **Per account**: `orgInternal` learns the handle, whether it is a
   professional account and its Instagram id; the newest post's timestamp is
   a `lastActiveAt` claim (posting is activity).
4. **Per post** from the last `MAX_POST_AGE_DAYS` days: the bulk model reads
   the caption (`caption_events_v1`); when the caption points at the image
   ("see poster", "swipe for our termcard") or names a termcard, the strong
   model reads up to `MAX_VISION_IMAGES` images (`image_events_v1`). Caption
   quotes are checked against the caption; image-only values stay `inferred`.
   Replies are cached by post and caption, so a re-run costs nothing.
5. Events are **public** (the society published them), or `members_only` if
   the post says so. The post's image is downloaded from the URL the API gave
   and stored as our own copy (never hotlinked). An event repeated in several
   posts is kept once (newest post), and events another source already has
   are dropped (`extract.dedupe`).

The stage writes `var/staging/instagram_api/<run>.jsonl` with the full current
set: this run's accounts plus the previous file's records for accounts not
re-checked, because `load` posts only the latest file.
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

import httpx

from camsocs_pipeline.claims import epoch_ms, parser_field
from camsocs_pipeline.extract.dedupe import EventIndex
from camsocs_pipeline.extract.events import (
    EventContext,
    build_events,
    extract_events,
    load_prompt,
    redact_contacts,
)
from camsocs_pipeline.extract.images import upload_image, vision_image
from camsocs_pipeline.extract.llm import LLMClient, LLMValidationError
from camsocs_pipeline.extract.memo import LLMMemo
from camsocs_pipeline.extract.when import TermCalendar, london_date
from camsocs_pipeline.known_orgs import KnownOrgs
from camsocs_pipeline.models.observation import (
    EventObservation,
    FetchInfo,
    IdentityHints,
    Observation,
)
from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.pipeline.load import ConvexLoader
from camsocs_pipeline.sources.instagram import (
    BusinessDiscovery,
    InstagramError,
    Media,
    NotProfessional,
    Profile,
    RateLimited,
    TokenInvalid,
)
from camsocs_pipeline.staging.store import Record

logger = logging.getLogger(__name__)

SOURCE_TYPE = "instagram_api"
EVENT_SOURCE = "instagram_api"
MAX_HANDLES_PER_RUN = 100
RECHECK_HOURS = 20
NOT_PROFESSIONAL_RETRY_DAYS = 14
MEDIA_LIMIT = 12
MAX_POST_AGE_DAYS = 60
MAX_VISION_IMAGES = 4
ACCESS_NOTE = "official Instagram Graph API (business_discovery); instagram.com is never fetched"
_POSTER_WORDS = ("termcard", "term card", "poster", "line-up", "lineup", "schedule", "swipe")


@dataclass
class Tools:
    llm: LLMClient
    memo: LLMMemo
    calendar: TermCalendar
    index: EventIndex
    client: BusinessDiscovery
    upload: bool
    loader: ConvexLoader
    notes: list[str] = field(default_factory=list)


def run(ctx: StageContext) -> None:
    settings = ctx.settings
    if not settings.meta_configured:
        ctx.report.notes.append("skipped: not configured (META_IG_USER_ID / META_ACCESS_TOKEN)")
        return
    known = KnownOrgs.from_staging(ctx.staging)
    targets = known.instagram_targets()
    if not targets:
        ctx.report.notes.append("no organisation in staging has an Instagram handle yet")
        return

    now = datetime.now(UTC)
    handles = ctx.state.data("instagram").setdefault("handles", {})
    due = sorted(
        (target for target in targets if _due(handles.get(target[1]), now)),
        key=lambda target: handles.get(target[1], {}).get("checked", ""),
    )
    budget = ctx.limit or MAX_HANDLES_PER_RUN
    if ctx.dry_run:
        ctx.report.notes.append(
            f"dry run: {min(len(due), budget)} of {len(targets)} handles would be checked"
        )
        return
    client = BusinessDiscovery(
        ig_user_id=settings.meta_ig_user_id,
        access_token=settings.meta_access_token.get_secret_value(),
        version=settings.meta_graph_version,
        user_agent=settings.require_user_agent(),
    )
    tools = Tools(
        llm=LLMClient(settings.require_llm()),
        memo=LLMMemo(settings.cache_dir / "llm"),
        calendar=TermCalendar.default(),
        index=EventIndex.from_staging(ctx.staging, exclude=[SOURCE_TYPE]),
        client=client,
        upload=not ctx.dry_run,
        loader=ctx.loader,
    )

    records: list[Record] = []
    processed: set[str] = set()
    counts = {"checked": 0, "not professional": 0, "errors": 0}
    try:
        for org_key, handle in due[:budget]:
            if client.near_limit:
                ctx.report.notes.append(f"stopped early: app usage at {client.call_count}%")
                break
            try:
                profile = client.fetch(handle, media_limit=MEDIA_LIMIT)
            except RateLimited as error:
                ctx.report.notes.append(f"rate limited, resuming next run: {error}")
                break
            except NotProfessional:
                handles[handle] = {"checked": now.isoformat(), "status": "not_professional"}
                records.append(_account(org_key, handle, None, client, now, known))
                processed.add(org_key)
                counts["not professional"] += 1
                continue
            except TokenInvalid:
                # Every further call would fail too: fail the stage, loudly.
                raise
            except (InstagramError, httpx.HTTPError) as error:
                logger.warning("instagram: @%s failed (%s)", handle, type(error).__name__)
                counts["errors"] += 1
                continue
            records.append(_account(org_key, handle, profile, client, now, known))
            records.extend(_events(org_key, profile, now, known, tools))
            # Marked checked only once its records exist: a crash above leaves
            # the handle due again next run.
            handles[handle] = {"checked": now.isoformat(), "status": "ok", "id": profile.ig_id}
            processed.add(org_key)
            counts["checked"] += 1
    finally:
        client.close()

    still_targets = {org_key for org_key, _handle in targets}
    carried = [
        record
        for record in ctx.staging.read_latest(SOURCE_TYPE)
        if _org_of(record) in still_targets and _org_of(record) not in processed
    ]
    current = carried + records
    if current:
        ctx.staging.write(SOURCE_TYPE, ctx.run.run_key, current)
    events = sum(isinstance(record, EventObservation) for record in records)
    ctx.report.notes.append(
        f"{len(due)} handles due of {len(targets)}; "
        + ", ".join(f"{count} {name}" for name, count in counts.items())
        + f"; {events} events this run, {len(carried)} records carried forward"
    )
    ctx.report.notes.extend(tools.notes[:10])
    ctx.report.skipped += max(0, len(due) - budget)


def _due(entry: dict | None, now: datetime) -> bool:
    if not entry or "checked" not in entry:
        return True
    try:
        checked = datetime.fromisoformat(entry["checked"])
    except ValueError:
        return True
    wait = (
        timedelta(days=NOT_PROFESSIONAL_RETRY_DAYS)
        if entry.get("status") == "not_professional"
        else timedelta(hours=RECHECK_HOURS)
    )
    return now - checked >= wait


def _org_of(record: Record) -> str | None:
    if isinstance(record, EventObservation):
        keys = [o.identity.known_key for o in record.organisers]
        return keys[0] if keys else None
    return record.entity_key


def _account(
    org_key: str,
    handle: str,
    profile: Profile | None,
    client: BusinessDiscovery,
    now: datetime,
    known: KnownOrgs,
) -> Observation:
    """What we learnt about the account itself: orgInternal identifiers and,
    from the newest post, `lastActiveAt`."""
    org = known.get(org_key)
    internal: dict = {"instagram_handle": handle, "instagram_business": profile is not None}
    fields = []
    if profile is not None:
        internal["instagram_user_id"] = profile.ig_id
        if profile.media:
            newest = max(media.timestamp for media in profile.media)
            fields.append(
                parser_field(
                    "lastActiveAt",
                    epoch_ms(newest),
                    extractor="instagram.latest_post",
                    evidence="primary",
                )
            )
    return Observation(
        source_type=SOURCE_TYPE,
        source_key=handle,
        source_url=client.source_url(handle),
        retrieved_at=now,
        fetch=FetchInfo(http_status=200, access_note=ACCESS_NOTE),
        entity_type="organisation",
        identity=IdentityHints(
            name=org.display_name if org else org_key,
            instagram_handle=handle,
            known_key=org_key,
        ),
        entity_key=org_key,
        internal=internal,
        fields=fields,
    )


def _events(
    org_key: str, profile: Profile, now: datetime, known: KnownOrgs, tools: Tools
) -> list[EventObservation]:
    """Events from the account's recent posts, newest post first, each event
    once (by its external id), minus those another source already has."""
    org = known.get(org_key)
    cutoff = now - timedelta(days=MAX_POST_AGE_DAYS)
    recent = sorted(
        (media for media in profile.media if media.timestamp >= cutoff),
        key=lambda media: media.timestamp,
        reverse=True,
    )
    found: list[EventObservation] = []
    seen: set[str] = set()
    for media in recent:
        try:
            events = _post_events(org_key, org.display_name if org else org_key, media, now, tools)
        except LLMValidationError:
            tools.notes.append(f"a post of @{profile.handle} did not validate")
            continue
        for event in events:
            if event.external_id in seen or tools.index.is_duplicate_record(event):
                continue
            seen.add(event.external_id)
            found.append(event)
    return found


def _post_events(
    org_key: str, org_name: str, media: Media, now: datetime, tools: Tools
) -> list[EventObservation]:
    caption = redact_contacts(media.caption).strip()
    anchor = london_date(media.timestamp)
    calendar_note = tools.calendar.context(anchor)
    extracted = None
    model = tools.llm.model_for("bulk")
    prompt, version = load_prompt("caption_events_v1")
    if caption:
        result = extract_events(
            tools.llm,
            tools.memo,
            prompt=prompt,
            prompt_version=version,
            text=f"{calendar_note}\n\n--- CAPTION ---\n{caption}",
        )
        extracted, model = result.value, result.model

    images: tuple[bytes, ...] = ()
    poster_hint = any(word in caption.lower() for word in _POSTER_WORDS)
    wants_image = (
        extracted is None or extracted.needs_image or (poster_hint and not extracted.events)
    )
    if wants_image and media.image_urls:
        images = _download(media, tools)
        readable = tuple(prepared for prepared in map(vision_image, images) if prepared)
        if readable:
            image_prompt, image_version = load_prompt("image_events_v1")
            result = extract_events(
                tools.llm,
                tools.memo,
                prompt=image_prompt,
                prompt_version=image_version,
                text=f"{calendar_note}\n\n--- CAPTION ---\n{caption}",
                tier="strong",
                images=readable,
            )
            if result.value.events:
                extracted, model, version = result.value, result.model, image_version
    if extracted is None or not extracted.events:
        return []

    image = _stored_image(media, images, tools)
    context = EventContext(
        source_type=SOURCE_TYPE,
        event_source=EVENT_SOURCE,
        source_url=media.permalink,
        retrieved_at=now,
        source_text=caption,
        model=model,
        prompt_version=version,
        evidence="primary",
        visibility="public",
        anchor=anchor,
        calendar=tools.calendar,
        term=tools.calendar.term_named(extracted.term, extracted.term_year, anchor),
        scope=org_key,
        organiser_key=org_key,
        organiser_name=org_name,
        content_sha256=hashlib.sha256(media.caption.encode("utf-8")).hexdigest(),
        image=image,
        fetch=FetchInfo(http_status=200, access_note=ACCESS_NOTE),
    )
    events, dropped = build_events(extracted, context)
    if dropped:
        tools.notes.append(f"{len(dropped)} undated event(s) in a post")
    return events


def _download(media: Media, tools: Tools) -> tuple[bytes, ...]:
    images = []
    for url in media.image_urls[:MAX_VISION_IMAGES]:
        data = tools.client.download(url)
        if data:
            images.append(data)
    return tuple(images)


def _stored_image(media: Media, images: tuple[bytes, ...], tools: Tools) -> dict | None:
    """Our own copy of the post's first image, for the event card."""
    if not tools.upload:
        return None
    first = images[0] if images else None
    if first is None and media.image_urls:
        first = tools.client.download(media.image_urls[0])
    prepared = upload_image(first) if first else None
    if prepared is None:
        return None
    stored = tools.loader.upload_file(*prepared)
    return {"storageId": stored.storage_id, "sourceUrl": media.permalink}


__all__ = ["run"]
