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
stage filled, and an image that cannot be had is not posted.
"""

from __future__ import annotations

from itertools import islice

from camsocs_pipeline.media import CachedImages
from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.staging.store import RESOLVED

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
    awaiting = sum(1 for record in records if not record.is_keyed)
    records = [record for record in records if record.is_keyed]
    if ctx.limit is not None:
        records = list(islice(records, ctx.limit))

    media = CachedImages(ctx.settings)
    try:
        report = ctx.loader.post_observations(records, run_key=ctx.run.run_key, media=media)
    finally:
        media.close()
    report.skipped += awaiting
    claims = report.claims
    ctx.report.inserted += claims.inserted
    ctx.report.updated += claims.updated
    ctx.report.unchanged += claims.unchanged
    ctx.report.skipped += report.skipped

    ctx.report.notes.append(
        f"{total} records from {', '.join(directories)}; {report.skipped} awaiting resolve"
    )
    if report.files_stored or report.files_dropped:
        ctx.report.notes.append(
            f"images: {report.files_stored} stored, {report.files_dropped} not available"
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
