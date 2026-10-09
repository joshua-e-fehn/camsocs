"""Stage `load`: posts every keyed staged observation to Convex.

Reads the latest file of every staging directory (each harvest source, the
resolver's `_resolved`, and the post-resolve stages), keeps the records that
carry all their keys (`Observation.is_keyed`), and posts them through
`ConvexLoader.post_observations`: sources → claims → orgInternal →
relationships → event organisers → broker inferences. Unkeyed records wait
for the resolve stage and are counted as skipped.

Re-posting unchanged observations is cheap: the server recognises each claim
by its fingerprint and writes nothing (reported as `unchanged`).

Images staged as a bare ``{"sourceUrl"}`` get our own stored copy on the way
(`camsocs_pipeline.media`): the bytes come from the fetch cache the harvest
stage filled, and an image that cannot be had is not posted. Bytes the
deployment already stores are not uploaded again (`pipeline.stored_files`,
``var/state/stored-files.json``: sha256 → storageId per deployment).

Public free text is made safe to publish on the way too (decision D1,
`extract.redact`): names of private individuals become their roles, with the
bulk model (replies cached by the input's sha256) and deterministic checks.
A dry run uses cached replies and the deterministic rule only.

Event readings another source already lists are merged into that source's
event (`events.duplicates`); the notes say how many, from which sources.
"""

from __future__ import annotations

from itertools import islice

from camsocs_pipeline.extract.redact import redactor_for
from camsocs_pipeline.media import CachedImages
from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.pipeline.stored_files import StoredFiles, stored_files_path
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
    stored = StoredFiles.load(stored_files_path(ctx.settings.staging_dir), ctx.loader.base_url)
    ctx.loader.stored_files = None if ctx.loader.dry_run else stored
    try:
        report = ctx.loader.post_observations(
            records, run_key=ctx.run.run_key, media=media, redactor=redactor
        )
    finally:
        media.close()
        if ctx.loader.stored_files is not None:
            stored.save()
            ctx.loader.stored_files = None
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
    ctx.report.notes.extend(report.merged)
    if report.files_stored or report.files_dropped:
        ctx.report.notes.append(
            f"images: {report.files_stored} stored ({stored.reused} already on the server, "
            f"not uploaded again), {report.files_dropped} not available"
            + (f" ({media.unavailable})" if media.unavailable else "")
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
