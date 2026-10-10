"""Stage `load`: posts every keyed staged observation to Convex.

Reads the latest file of every staging directory (each harvest source, the
resolver's `_resolved`, and the post-resolve stages), keeps the records that
carry all their keys (`Observation.is_keyed`), and posts them through
`ConvexLoader.post_observations`: sources → claims → orgInternal →
relationships → event organisers → broker inferences. Unkeyed records wait
for the resolve stage and are counted as skipped.

Re-posting unchanged observations is cheap: the server recognises each claim
by its fingerprint and writes nothing (reported as `unchanged`), and each
organisation's feed identifiers travel as one merged patch, so a second
identical load reports nothing updated.

Nothing the suppression list forbids is posted (`camsocs_pipeline.suppressions`:
listings, fields, addresses and people removed on request); the notes say what
was held back.

Images staged as a bare ``{"sourceUrl"}`` get our own stored copy on the way
(`camsocs_pipeline.media`): the bytes come from the fetch cache the harvest
stage filled, and an image that cannot be had is not posted. Bytes this
deployment already stores are not uploaded again: their ids are remembered in
``var/state/stored-files.json`` (`StoredFileCache`).

Public free text is made safe to publish on the way too (decision D1,
`extract.redact`): names of private individuals become their roles, with the
bulk model (replies cached by the input's sha256) and deterministic checks.
A dry run uses cached replies and the deterministic rule only.

Event readings another source already lists are merged into that source's
event (`events.duplicates`); the notes say how many, from which sources.

Calendar noise is sifted out first (decision D6: the rules in `events.noise`,
the model and the claims in `extract.event_noise`): readings that are no
events — a prayer room closed, a deadline, a placeholder — are not posted,
and someone else's event a society only takes part in (a CTF on its
calendar) is posted ``hosting: takes_part``. Rules first, the bulk model
for borderline readings (replies cached by the input's sha256; a dry run
uses cached replies and the rules only). The notes count each rule and give
a few dropped notices' keys — never their titles — and the metrics carry
the totals.
"""

from __future__ import annotations

from itertools import islice

from camsocs_pipeline.extract.event_noise import classifier_for
from camsocs_pipeline.extract.redact import redactor_for
from camsocs_pipeline.media import CachedImages
from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.pipeline.load import StoredFileCache, stored_files_path
from camsocs_pipeline.staging.store import RESOLVED, Record

#: Rejection reasons shown in the stage notes; the rest are counted.
MAX_REJECTION_NOTES = 10


def run(ctx: StageContext) -> None:
    directories = ctx.staging.directories()
    if not directories:
        ctx.report.notes.append("nothing staged")
        return
    # The resolver's output first: it creates the organisations (their
    # `name` claims) that post-resolve stages' keyed observations — website
    # enrichment, events — only add fields to. A claim for an organisation
    # that does not exist yet is refused unless its name arrives first.
    ordered = [name for name in directories if name == RESOLVED]
    ordered += [name for name in directories if name != RESOLVED]
    records = [record for name in ordered for record in ctx.staging.read_latest(name)]
    total = len(records)
    # A harvest directory keeps its unkeyed originals after resolve has
    # written their keyed copies to `_resolved`; only an original with no
    # keyed copy (held in the quarantine, or staged after resolve ran) is
    # still waiting.
    keyed_refs = {_ref(record) for record in records if record.is_keyed}
    awaiting = sum(
        1 for record in records if not record.is_keyed and _ref(record) not in keyed_refs
    )
    records = [record for record in records if record.is_keyed]
    if ctx.limit is not None:
        records = list(islice(records, ctx.limit))

    media = CachedImages(ctx.settings)
    redactor, redaction_note = redactor_for(ctx.settings, dry_run=ctx.dry_run)
    if redaction_note:
        ctx.report.notes.append(redaction_note)
    noise, noise_note = classifier_for(ctx.settings, dry_run=ctx.dry_run)
    if noise_note:
        ctx.report.notes.append(noise_note)
    cache = StoredFileCache.load(stored_files_path(ctx.settings.staging_dir), ctx.loader.base_url)
    ctx.loader.file_cache = cache
    try:
        report = ctx.loader.post_observations(
            records, run_key=ctx.run.run_key, media=media, redactor=redactor, noise=noise
        )
    finally:
        media.close()
        ctx.loader.file_cache = None
        if not ctx.dry_run:
            cache.save()
    report.skipped += awaiting
    claims = report.claims
    ctx.report.inserted += claims.inserted
    ctx.report.updated += claims.updated
    ctx.report.unchanged += claims.unchanged
    ctx.report.skipped += report.skipped

    ctx.report.notes.append(
        f"{total} records from {', '.join(directories)}; {report.skipped} awaiting resolve"
    )
    if report.collisions:
        ctx.report.notes.append(
            f"{len(report.collisions)} fields not posted: one source gave one entity "
            "two different readings"
        )
        for collision in report.collisions[:MAX_REJECTION_NOTES]:
            ctx.report.notes.append(f"  {collision}")
    if report.redaction.texts:
        ctx.report.notes.append(str(report.redaction))
        # Keys only: an entity already on the deployment keeps its last title
        # until it is withdrawn or removed (`ingest/purge:removeEntity`).
        for key in report.redaction.dropped[:MAX_REJECTION_NOTES]:
            ctx.report.notes.append(f"  title unsafe, not posted: {key}")
        # For review: a name redacted inside a title ("A chat with someone").
        someone = report.redaction.someone_titles
        if someone:
            ctx.report.notes.append(f"  {len(someone)} posted titles read 'someone' (review):")
            for key in someone[:MAX_REJECTION_NOTES]:
                ctx.report.notes.append(f"    {key}")
    ctx.report.notes.extend(report.noise.notes())
    if report.noise.readings:
        ctx.report.metrics["eventNoticesDropped"] = sum(report.noise.dropped.values())
        ctx.report.metrics["eventsTakingPart"] = sum(report.noise.external.values())
    ctx.report.notes.extend(report.merged)
    if ctx.loader.suppressions_note:
        ctx.report.notes.append(ctx.loader.suppressions_note)
    if report.suppressed:
        ctx.report.notes.append(str(report.suppressed))
    if report.files_stored or report.files_dropped:
        ctx.report.notes.append(
            f"images: {report.files_stored} stored ({report.files_reused} already on the "
            f"deployment, not uploaded again), {report.files_dropped} not available"
            + (f" ({media.unavailable})" if media.unavailable else "")
        )
    if report.files_stale:
        ctx.report.notes.append(
            f"images: {report.files_stale} remembered ids were gone from the deployment — "
            "forgotten; the next run uploads them again"
        )
    entities = claims.entities
    if entities:
        ctx.report.notes.append(
            "entities: "
            + ", ".join(f"{count} {name}" for name, count in sorted(entities.items()) if count)
        )
    for result in report.results():
        if result.requests and result is not claims:
            ctx.report.notes.append(str(result))
    rejected = [item for result in report.results() for item in result.rejected]
    if rejected:
        ctx.report.notes.append(f"{len(rejected)} refused by the server:")
        for item in rejected[:MAX_REJECTION_NOTES]:
            ctx.report.notes.append(f"  {_describe(item)}")


def _describe(item: object) -> str:
    if isinstance(item, dict):
        return f"{item.get('entityKey')}.{item.get('field')}: {item.get('reason')}"
    return f"not found: {item}"


def _ref(record: Record) -> tuple[str, str]:
    return (record.source_type, record.source_key)
