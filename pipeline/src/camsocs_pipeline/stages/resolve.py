"""Stage `resolve` (T4): identities → keys.

Reads the latest staged file of every source directory, resolves which
observations are one organisation (`camsocs_pipeline.resolve.resolver`: the
persisted crosswalk first, then SU id, Instagram handle, website, normalised
name + level + college), and writes the keyed copies to
``var/staging/_resolved/<run_key>.jsonl`` for `load`.

Around that:

- the crosswalk is the local cache ``var/state/crosswalk.json`` merged with
  Convex's (``POST /api/pipeline/crosswalk``; a 404 means the route is not
  deployed yet and the local cache is used alone). It is saved after a real
  run, never after a dry run;
- operator decisions come from ``pipeline/resolve-decisions.json``;
- the quarantine — held observations, dropped references, matches to review —
  is written to ``var/reports/quarantine.json`` every run, dry or not.

Records that already carry their keys (written by stages after resolve:
enrichment, events) are left where they are; `load` reads them from their
own directory. `--limit` does not apply: who is who needs every observation.
"""

from __future__ import annotations

import json

from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.pipeline.load import ConvexNotFound
from camsocs_pipeline.resolve.crosswalk import (
    DECISIONS_PATH,
    Crosswalk,
    Decisions,
    crosswalk_path,
    quarantine_path,
)
from camsocs_pipeline.resolve.resolver import resolve_records
from camsocs_pipeline.staging.store import RESOLVED

#: Quarantine lines shown in the stage notes; the file has all of them.
MAX_NOTES = 8


def run(ctx: StageContext) -> None:
    directories = [name for name in ctx.staging.directories() if name != RESOLVED]
    if not directories:
        ctx.report.notes.append("nothing staged")
        return
    records = [record for name in directories for record in ctx.staging.read_latest(name)]

    local = crosswalk_path(ctx.settings.staging_dir)
    crosswalk = Crosswalk.load(local)
    ctx.report.notes.append(f"crosswalk: {len(crosswalk)} keys cached locally")
    if not ctx.dry_run:
        try:
            added = crosswalk.merge_remote(ctx.loader.crosswalk())
            ctx.report.notes.append(f"crosswalk: {added} more keys from Convex")
        except ConvexNotFound:
            ctx.report.notes.append("crosswalk: route not deployed on Convex; local cache only")

    resolution = resolve_records(
        records,
        crosswalk=crosswalk,
        decisions=Decisions.load(DECISIONS_PATH),
        run_key=ctx.run.run_key,
    )
    written = ctx.staging.write(RESOLVED, ctx.run.run_key, resolution.records)

    report_path = quarantine_path(ctx.settings.staging_dir)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(
        json.dumps(resolution.report.model_dump(exclude_none=True), indent=1, ensure_ascii=False)
        + "\n",
        encoding="utf-8",
    )
    if not ctx.dry_run:
        resolution.crosswalk.save(local)

    counts = resolution.report.counts
    ctx.report.skipped += counts.get("held", 0)
    ctx.report.notes.append(
        f"{len(records)} staged records from {', '.join(directories)} → {written} keyed "
        f"({counts.get('organisations', 0)} organisation observations, "
        f"{counts.get('keys_kept', 0)} keys kept, {counts.get('keys_minted', 0)} minted, "
        f"{counts.get('counterparts_created', 0)} counterparts)"
    )
    ctx.report.notes.append(
        f"quarantine: {counts.get('held', 0)} held, "
        f"{counts.get('dropped_references', 0)} references dropped, "
        f"{counts.get('review', 0)} to review → {report_path}"
    )
    for item in [*resolution.report.held, *resolution.report.review][:MAX_NOTES]:
        ctx.report.notes.append(f"  {item.kind}: {item.reason} — {', '.join(item.names[:3])}")
