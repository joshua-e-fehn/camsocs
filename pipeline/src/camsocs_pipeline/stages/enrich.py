"""Stage `enrich` (T5): resolved organisations → their own website and
Linktree (source-research §13, §14; feeds §11, ticketing §15).

Reads the resolve stage's latest output (``var/staging/_resolved``), picks
every organisation with a website or Linktree a source states
(`sources.websites.enrich.targets_from`; ``--limit N`` takes the first N),
and enriches it (`sources.websites.enrich.Enricher`: polite fetch of a few
key pages, deterministic links / emails / feeds / JSON-LD, LLM extraction with
verbatim-evidence checks). Named sponsors and partners are keyed against the
crosswalk (`resolve.Resolver.reference_key`): a known organisation keeps its
key, a company / NGO / college / department becomes a counterpart
organisation, an unknown student group is dropped.

Writes keyed observations, like any harvester's but already keyed:

- ``var/staging/society_website/<run_key>--enrich.jsonl`` — counterparts first, then
  one observation per page read, then sessions;
- ``var/staging/linktree/<run_key>--enrich.jsonl``.

`load` posts them. The LLM runs only when it is configured (`LLM_*`), in dry
runs too (nothing is written to Convex; results are cached under
``var/cache/llm/``). The crosswalk gains the counterparts after a real run.
"""

from __future__ import annotations

from camsocs_pipeline.claims import llm_field, parser_field
from camsocs_pipeline.config import ConfigError
from camsocs_pipeline.extract.llm import LLMClient
from camsocs_pipeline.models.observation import Observation
from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.resolve.crosswalk import Crosswalk, crosswalk_path
from camsocs_pipeline.resolve.resolver import Resolver
from camsocs_pipeline.sources.base import PoliteClient
from camsocs_pipeline.sources.websites.enrich import (
    Enricher,
    PartnerMention,
    Stats,
    TargetResult,
    enrich_all,
    targets_from,
)
from camsocs_pipeline.staging.store import RESOLVED

#: Per-organisation notes shown in the stage report; the rest are counted.
MAX_NOTES = 25


def run(ctx: StageContext) -> None:
    resolved = ctx.staging.read_latest(RESOLVED)
    if not resolved:
        ctx.report.notes.append("nothing resolved yet — run resolve first")
        return
    targets, notes = targets_from(resolved)
    total = len(targets)
    if ctx.limit is not None:
        targets = targets[: ctx.limit]
    ctx.report.notes.append(
        f"{total} organisations with a website or Linktree; enriching {len(targets)}"
    )
    ctx.report.notes.extend(notes[:MAX_NOTES])
    if not targets:
        return

    llm: LLMClient | None = None
    try:
        llm = LLMClient(ctx.settings.require_llm())
    except ConfigError as error:
        ctx.report.notes.append(f"LLM not configured ({error}) — deterministic extraction only")

    settings = ctx.settings
    # One retry: a society site that is down is retried by the next run, and
    # a dead domain should not hold a worker for minutes of backoff.
    with PoliteClient(
        user_agent=settings.require_user_agent(),
        cache_dir=settings.cache_dir,
        min_interval=settings.min_host_interval,
        max_retries=1,
    ) as client:
        results = enrich_all(Enricher(client, llm, cache_dir=settings.cache_dir), targets)

    crosswalk = Crosswalk.load(crosswalk_path(settings.staging_dir))
    crosswalk.add_resolved(resolved, run_key=ctx.run.run_key)
    resolver = Resolver(crosswalk, run_key=ctx.run.run_key)
    counterparts, dropped = _key_partners(resolver, results)

    website = [record for result in results for record in result.website]
    linktree = [record for result in results for record in result.linktree]
    part = ctx.report.name
    written = ctx.staging.write(
        "society_website", ctx.run.run_key, [*counterparts, *website], part=part
    )
    written += ctx.staging.write("linktree", ctx.run.run_key, linktree, part=part)
    if not ctx.dry_run and counterparts:
        crosswalk.save(crosswalk_path(settings.staging_dir))

    stats = Stats()
    for result in results:
        stats.add(result.stats)
    _report(ctx, stats, written, len(counterparts), dropped)
    shown = [note for result in results for note in result.notes]
    ctx.report.notes.extend(f"  {note}" for note in shown[:MAX_NOTES])
    if len(shown) > MAX_NOTES:
        ctx.report.notes.append(f"  … and {len(shown) - MAX_NOTES} more")


def _key_partners(resolver: Resolver, results: list[TargetResult]) -> tuple[list[Observation], int]:
    """Key every sponsor / partner mention (single-threaded: the resolver
    and crosswalk are not thread-safe). Returns the counterparts created and
    how many mentions matched nothing."""
    counterparts: list[Observation] = []
    dropped = 0
    for result in results:
        for mention in result.partners:
            key = resolver.reference_key(mention.relationship.to_identity, mention.record)
            if key is None or key == result.target.key:
                dropped += 1
                continue
            mention.relationship.to_identity.known_key = key
            mention.record.relationships.append(mention.relationship)
            for created in resolver.take_counterparts():
                counterparts.append(_as_llm_counterpart(created, mention))
    return counterparts, dropped


def _as_llm_counterpart(record: Observation, mention: PartnerMention) -> Observation:
    """A counterpart named by the LLM: its name is an LLM reading with the
    quote checked against the page; its type is the LLM's classification
    (unquoted, so inferred); `isCounterpart` and the level follow from them."""
    model = "llm"
    for obs in mention.record.fields:
        if obs.method == "llm":
            model = obs.extractor
            break
    fields = []
    for obs in record.fields:
        if obs.field == "name":
            fields.append(
                llm_field(
                    "name",
                    obs.value,
                    quote=mention.quote,
                    source_text=mention.page_text,
                    source_type=record.source_type,
                    model=model,
                    prompt_version="org_v1",
                    evidence="secondary",
                )
            )
        elif obs.field == "orgType":
            fields.append(
                llm_field(
                    "orgType",
                    obs.value,
                    quote=None,
                    source_text="",
                    source_type=record.source_type,
                    model=model,
                    prompt_version="org_v1",
                    evidence="secondary",
                )
            )
        elif obs.field == "level":
            fields.append(
                parser_field(
                    "level",
                    obs.value,
                    extractor="enrich.counterpart_level",
                    evidence="secondary",
                    inferred=True,
                )
            )
        else:
            fields.append(obs)
    record.fields = fields
    return record


def _report(ctx: StageContext, stats: Stats, written: int, counterparts: int, dropped: int) -> None:
    ctx.report.skipped += stats.disallowed + stats.unreachable + stats.not_about
    claims = stats.fields_found + stats.fields_inferred
    ratio = f"{stats.fields_found / claims:.0%}" if claims else "n/a"
    ctx.report.notes.append(
        f"{written} observations staged; {stats.pages} pages read; "
        f"{stats.unreachable} sites unreachable, {stats.disallowed} disallowed by robots, "
        f"{stats.not_about} not the organisation's site"
    )
    ctx.report.notes.append(
        f"claims: {stats.fields_found} found, {stats.fields_inferred} inferred ({ratio} found), "
        f"{stats.fields_missing} not found; {stats.sessions} sessions, {stats.people} people "
        f"(private), {stats.partners} sponsors/partners ({counterparts} new counterparts, "
        f"{dropped} unmatched)"
    )
    average = stats.llm_seconds / stats.llm_calls if stats.llm_calls else 0.0
    ctx.report.notes.append(
        f"LLM: {stats.llm_calls} calls (avg {average:.1f}s), {stats.llm_cached} cached, "
        f"{stats.llm_failed} failed, {stats.llm_skipped_robots} sites kept from the LLM by "
        "robots.txt"
    )
    if stats.by_field:
        top = ", ".join(f"{name} {count}" for name, count in stats.by_field.most_common())
        ctx.report.notes.append(f"fields with a value: {top}")
