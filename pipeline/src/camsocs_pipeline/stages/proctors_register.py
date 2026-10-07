"""Stage `proctors_register`: the Proctors' register of University societies
(source-research §2; parsing in `sources/proctors.py`).

Fetches the one register page politely (robots.txt, cache) and writes one
observation per entry to ``var/staging/proctors_register/<run>--proctors_register.jsonl``. The
entries' links are classified, never fetched. A dry run replays the cached
page, if any, and stages nothing.
"""

from __future__ import annotations

from collections import Counter

from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.sources.proctors import REGISTER_URL, parse_register, register_observation


def run(ctx: StageContext) -> None:
    with ctx.crawler() as client:
        page = client.cached(REGISTER_URL) if ctx.dry_run else client.fetch(REGISTER_URL)

    if page is None:
        ctx.report.notes.append("dry run: the register is not cached; nothing to replay")
        return
    if not page.ok:
        raise RuntimeError(
            f"Proctors' register: {page.outcome} ({page.status}) {page.detail or ''}"
        )
    entries = parse_register(page.text, page.final_url)
    if not entries:
        raise RuntimeError("Proctors' register: no entries parsed — has the page layout changed?")
    listed = len(entries)
    if ctx.limit is not None:
        entries = entries[: ctx.limit]

    records = [register_observation(entry, page) for entry in entries]
    if ctx.dry_run:
        ctx.report.notes.append("dry run: replayed from cache, nothing staged")
    else:
        ctx.staging.write("proctors_register", ctx.run.run_key, records, part=ctx.report.name)

    kinds = Counter(entry.link_kind or "no link" for entry in entries)
    ctx.report.notes.append(f"{listed} listed; {len(records)} observations")
    ctx.report.notes.append("links: " + ", ".join(f"{k} {n}" for k, n in kinds.most_common()))
