"""Stage `classify` (R2): orgType, level, categories, activity types,
audiences, languages and tags for every listed organisation
(`camsocs_pipeline.classify`: sources first, then deterministic rules, then
the bulk model with verbatim quotes for the rest).

Reads every keyed organisation observation in staging — the resolver's
``_resolved``, website enrichment, Camdram, CUCBC, colleges — except this
stage's own previous output (the part ``classify``, which it reads only to
restate what it no longer claims), and writes keyed observations to
``var/staging/<source_type>/<run_key>--classify.jsonl``, one per
(organisation, record the claims were read from). `load` posts them.

The model runs only when it is configured (`LLM_*`), in dry runs too, like
enrichment (nothing is written to Convex; answers are cached under
``var/cache/llm/classify_v1/``). Without it, the rules still run and nothing
the model said before is retracted. A text from a general source whose host
or page keeps AI out never reaches the model (`extract.ai_gate`).
"""

from __future__ import annotations

from camsocs_pipeline.classify import PART, classify_records
from camsocs_pipeline.config import ConfigError
from camsocs_pipeline.extract.ai_gate import AiGate
from camsocs_pipeline.extract.llm import LLMClient
from camsocs_pipeline.extract.memo import LLMMemo
from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.staging.store import is_events_directory


def run(ctx: StageContext) -> None:
    directories = [name for name in ctx.staging.directories() if not is_events_directory(name)]
    records = [
        record
        for name in directories
        for record in ctx.staging.read_latest(name, exclude_parts=(PART,))
    ]
    previous = [
        record for name in directories for record in ctx.staging.read_latest_part(name, PART)
    ]
    if not records:
        ctx.report.notes.append("nothing staged")
        return

    llm: LLMClient | None = None
    try:
        llm = LLMClient(ctx.settings.require_llm())
    except ConfigError as error:
        ctx.report.notes.append(f"LLM not configured ({error}) — rules only")

    with ctx.crawler() as client:
        # General sources' AI opt-outs hold (`extract.ai_gate`); a dry run
        # cannot read robots.txt, so it checks nothing and only replays the
        # cache.
        gate = None if ctx.dry_run else AiGate(client)
        result = classify_records(
            records,
            previous,
            llm=llm,
            memo=LLMMemo(ctx.settings.cache_dir / "llm"),
            workers=ctx.settings.llm_concurrency,
            gate=gate,
        )
    by_type: dict[str, list] = {}
    for record in result.records:
        by_type.setdefault(record.source_type, []).append(record)
    written = 0
    for source_type, staged in sorted(by_type.items()):
        written += ctx.staging.write(source_type, ctx.run.run_key, staged, part=ctx.report.name)
    ctx.report.inserted += written

    counts = result.counts
    ctx.report.notes.append(
        f"{counts.get('organisations', 0)} listed organisations; {written} observations staged "
        f"in {', '.join(sorted(by_type)) or 'nothing'}"
    )
    rules = {name.split(":", 1)[1]: n for name, n in counts.items() if name.startswith("rule:")}
    model = {name.split(":", 1)[1]: n for name, n in counts.items() if name.startswith("model:")}
    ctx.report.notes.append(
        "rules: " + (", ".join(f"{name} {n}" for name, n in sorted(rules.items())) or "none")
    )
    ctx.report.notes.append(
        f"model: {counts.get('model_requests', 0)} organisations to ask; claims "
        + (", ".join(f"{name} {n}" for name, n in sorted(model.items())) or "none")
    )
    if result.llm is not None:
        stats = result.llm
        average = stats.seconds / stats.calls if stats.calls else 0.0
        ctx.report.notes.append(
            f"LLM: {stats.calls} calls (avg {average:.1f}s), {stats.cached} cached, "
            f"{stats.answered} answered, {stats.missing} left out by the model, "
            f"{stats.failed} in failed calls"
        )
    if counts.get("restated"):
        ctx.report.notes.append(f"{counts['restated']} earlier readings restated as not found")
