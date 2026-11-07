import { v } from "convex/values"
import { HARVEST_RUN_STATUSES, HARVEST_STAGE_STATUSES, TALK_RUN_STATUSES } from "../../lib/vocab"
import type { Doc } from "../_generated/dataModel"
import { query } from "../_generated/server"
import { requireBrokerUser } from "../lib/auth"
import { DAY_MS } from "../lib/derived"
import { literalUnion } from "../lib/validators"
import { runGroup } from "../runs"

/**
 * The broker's pipeline-status reads (spec L10): per-stage health over the
 * run log for `/dashboard/pipeline` and `/dashboard/status`, the run list
 * behind the run picker, and one stage's notes and error.
 *
 * Everything is computed from `harvestRuns` (what `pipeline/report.py` posts
 * through `runs.finish`) and, for the talks pillar's `talks` stage, the
 * latest `talkRuns` row. Counts, durations and metrics only: notes, errors and
 * warnings stay behind `stageDetail`, which the dashboard opens on request.
 *
 * ⚠ Every function here calls `requireBrokerUser` first.
 */

/** Runs read by `stageStatus`, newest first (about five weeks of the daily
 * events run plus the weekly full run). */
export const STATUS_SCAN = 40

/** Most runs `runs` returns. */
export const MAX_RUNS = 30

/** Rows `runs` reads to fill a group-filtered page; a group with fewer runs
 * in this window returns what it found. */
const RUNS_SCAN = 200

/**
 * An unfinished run older than this died without calling `runs.finish` (the
 * longest group, `full`, is stopped by its runner after 6 h:
 * camsocs-harvest.sh). Its stages read as `not_run`, never as `running`.
 */
export const RUNNING_STALE_MS = 12 * 60 * 60 * 1000

export const STAGE_STATES = ["ok", "failed", "not_run", "not_requested", "running"] as const
export type StageState = (typeof STAGE_STATES)[number]

type Run = Pick<
  Doc<"harvestRuns">,
  | "runKey"
  | "command"
  | "group"
  | "requestedStages"
  | "status"
  | "startedAt"
  | "finishedAt"
  | "stages"
>
type StageResult = Doc<"harvestRuns">["stages"][number]
type TalkRun = Doc<"talkRuns">

const nullableNumber = v.union(v.null(), v.number())

const fetchSummary = v.object({
  requests: v.number(),
  /** fetchUnreachable + fetchHttpError: the monitor's `fetch_error_rate`
   * numerator. A 5xx is never added again: a non-retried one is already an
   * HTTP error and a retried one ends unreachable (sources/base.py). */
  errors: v.number(),
  status4xx: v.number(),
  status5xx: v.number(),
  robotsBlocked: v.number(),
  retries: v.number(),
  tooMany: v.number(),
})
export type FetchSummary = typeof fetchSummary.type

const talkRunSummary = v.object({
  runId: v.string(),
  status: literalUnion(TALK_RUN_STATUSES),
  startedAt: v.number(),
  finishedAt: v.number(),
  sourcesOk: v.number(),
  sourcesFailed: v.number(),
  talksReceived: v.number(),
  inserted: v.number(),
  updated: v.number(),
  unchanged: v.number(),
  missing: v.number(),
  /** How many errors the run recorded; their text is not returned here. */
  errorCount: v.number(),
})
export type TalkRunSummary = typeof talkRunSummary.type

const stageStatusRow = v.object({
  name: v.string(),
  /** The stage in its own last run (`lastRunKey`): `running` while that run
   * is open, its posted result once finished, `not_run` when it finished or
   * was abandoned without reporting the stage. `not_requested` when a newer
   * run of the same group no longer asks for it (the stage left the group).
   * Runs of other groups never decide it, so a full-only stage keeps its
   * weekly result while the daily events runs are newer. */
  lastStatus: literalUnion(STAGE_STATES),
  /** The newest run that requested or reported the stage. */
  lastRunKey: v.union(v.null(), v.string()),
  lastStartedAt: nullableNumber,
  /** `finishedAt` of the newest run whose result for the stage was `ok`. */
  lastOkAt: nullableNumber,
  /** `finishedAt` of the newest `ok` result with a yield above zero. */
  lastProductiveAt: nullableNumber,
  /** The counts of the newest posted result (null before the first one). */
  inserted: nullableNumber,
  updated: nullableNumber,
  unchanged: nullableNumber,
  skipped: nullableNumber,
  /** Null when the result was posted before durations were recorded. */
  durationMs: nullableNumber,
  /** Consecutive newest results that `failed`; a `not_run` (skipped for a
   * failed dependency) neither extends nor ends the streak, an `ok` ends it. */
  failStreak: v.number(),
  /** inserted + updated + unchanged of the newest posted result. */
  yield: nullableNumber,
  /** Median yield of the `ok` results before the newest one, over runs that
   * started in the last 7 / 28 days; null when there are none. */
  yieldMedian7d: nullableNumber,
  yieldMedian28d: nullableNumber,
  /** How many results each median is over (the monitor wants at least 3). */
  yieldSamples7d: v.number(),
  yieldSamples28d: v.number(),
  /** The newest result's fetch counters (pipeline fetch_stats); null when it
   * recorded none (every result posted before the pipeline sent fetch metrics),
   * which readers show as "not recorded", never as zeros. */
  fetch: v.union(v.null(), fetchSummary),
  /** For the `talks` stage: the latest `talkRuns` row, counts only. */
  talkRun: v.union(v.null(), talkRunSummary),
})
export type StageStatusRow = typeof stageStatusRow.type

const runStageSummary = v.object({
  name: v.string(),
  status: literalUnion(HARVEST_STAGE_STATUSES),
  inserted: v.number(),
  updated: v.number(),
  unchanged: v.number(),
  skipped: v.number(),
  durationMs: nullableNumber,
  /** Whether the stage posted an error (its text is in `stageDetail`). */
  failed: v.boolean(),
})

const runSummary = v.object({
  runKey: v.string(),
  command: v.string(),
  /** The recorded group, else the one parsed from `command`; null for an
   * ad-hoc `sync --stages …` run. */
  group: v.union(v.null(), v.string()),
  revision: v.union(v.null(), v.string()),
  pipelineVersion: v.string(),
  status: literalUnion(HARVEST_RUN_STATUSES),
  startedAt: v.number(),
  finishedAt: nullableNumber,
  /** finishedAt − startedAt; null while the run is open. */
  durationMs: nullableNumber,
  requestedStages: v.array(v.string()),
  stages: v.array(runStageSummary),
  warningCount: v.number(),
  /** Whether the run recorded a run-level error. */
  hasError: v.boolean(),
})
export type RunSummary = typeof runSummary.type

// --- pure helpers (exported for the tests) -------------------------------------------------

/** The median of `values`, or null when there are none. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** inserted + updated + unchanged: what the stage found this run (spec §6). */
export function stageYield(result: Pick<StageResult, "inserted" | "updated" | "unchanged">) {
  return result.inserted + result.updated + result.unchanged
}

/** The fetch counters in a result's metrics, or null when it recorded none. */
export function fetchSummaryOf(metrics: StageResult["metrics"]): FetchSummary | null {
  if (metrics?.fetchRequests === undefined) return null
  const n = (name: string) => metrics[name] ?? 0
  return {
    requests: n("fetchRequests"),
    errors: n("fetchUnreachable") + n("fetchHttpError"),
    status4xx: n("fetchStatus4xx"),
    status5xx: n("fetchStatus5xx"),
    robotsBlocked: n("fetchRobotsBlocked"),
    retries: n("fetchRetries"),
    tooMany: n("fetchTooMany"),
  }
}

/** Whether `run` is still open, as opposed to finished or abandoned. */
export function isRunning(run: Pick<Run, "finishedAt" | "startedAt">, now: number): boolean {
  return run.finishedAt === null && now - run.startedAt < RUNNING_STALE_MS
}

/**
 * The stage's state in `lastRun`, the newest run that requested or reported
 * it; `newer` are the runs after it, none of which mention the stage.
 */
function stageStateIn(
  lastRun: Run | null,
  name: string,
  now: number,
  newer: readonly Run[],
): StageState {
  if (lastRun === null) return "not_requested"
  const group = runGroup(lastRun)
  // A newer run of the same group left the stage out: it has left the group.
  // Ad-hoc `sync --stages …` runs (no group) never supersede one another.
  if (group !== null && newer.some((run) => runGroup(run) === group)) return "not_requested"
  const result = lastRun.stages.find((stage) => stage.name === name)
  if (result && lastRun.finishedAt !== null) return result.status
  return isRunning(lastRun, now) ? "running" : "not_run"
}

function talkRunSummaryOf(run: TalkRun): TalkRunSummary {
  return {
    runId: run.runId,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    sourcesOk: run.sourcesOk,
    sourcesFailed: run.sourcesFailed,
    talksReceived: run.talksReceived,
    inserted: run.inserted,
    updated: run.updated,
    unchanged: run.unchanged,
    missing: run.missing,
    errorCount: run.errors.length,
  }
}

/**
 * Per-stage status over `runs` (newest first, filtered to one group or a mix
 * of every group).
 *
 * Stages are listed in the order the newest run requested them, then any
 * older ones it did not, so a stage that left the group still shows (as
 * `not_requested`). `talkRun` is joined onto the `talks` stage.
 */
export function summariseStages(
  runs: readonly Run[],
  options: { now: number; talkRun?: TalkRun | null },
): StageStatusRow[] {
  const { now } = options
  const names: string[] = []
  const seen = new Set<string>()
  for (const run of runs) {
    for (const name of [...run.requestedStages, ...run.stages.map((stage) => stage.name)]) {
      if (seen.has(name)) continue
      seen.add(name)
      names.push(name)
    }
  }

  return names.map((name) => {
    // Results newest first, each with the run it came from.
    const results: { run: Run; result: StageResult }[] = []
    let lastRun: Run | null = null
    let lastIndex = -1
    for (const [index, run] of runs.entries()) {
      const result = run.stages.find((stage) => stage.name === name)
      if (lastRun === null && (result || run.requestedStages.includes(name))) {
        lastRun = run
        lastIndex = index
      }
      if (result && run.finishedAt !== null) results.push({ run, result })
    }

    const lastStatus = stageStateIn(lastRun, name, now, runs.slice(0, Math.max(0, lastIndex)))

    const latest = results[0]?.result ?? null
    const ok = results.filter(({ result }) => result.status === "ok")
    const lastOk = ok[0]?.run ?? null
    const lastProductive = ok.find(({ result }) => stageYield(result) > 0)?.run ?? null

    let failStreak = 0
    for (const { result } of results) {
      if (result.status === "ok") break
      if (result.status === "failed") failStreak++
    }

    // The baseline the newest result is judged against: the ok results before it.
    const prior = ok.filter(({ result }) => result !== latest)
    const within = (days: number) =>
      prior
        .filter(({ run }) => run.startedAt >= now - days * DAY_MS)
        .map(({ result }) => stageYield(result))
    const week = within(7)
    const month = within(28)

    return {
      name,
      lastStatus,
      lastRunKey: lastRun?.runKey ?? null,
      lastStartedAt: lastRun?.startedAt ?? null,
      lastOkAt: lastOk?.finishedAt ?? null,
      lastProductiveAt: lastProductive?.finishedAt ?? null,
      inserted: latest?.inserted ?? null,
      updated: latest?.updated ?? null,
      unchanged: latest?.unchanged ?? null,
      skipped: latest?.skipped ?? null,
      durationMs: latest?.durationMs ?? null,
      failStreak,
      yield: latest ? stageYield(latest) : null,
      yieldMedian7d: median(week),
      yieldMedian28d: median(month),
      yieldSamples7d: week.length,
      yieldSamples28d: month.length,
      fetch: latest ? fetchSummaryOf(latest.metrics) : null,
      talkRun: name === "talks" && options.talkRun ? talkRunSummaryOf(options.talkRun) : null,
    }
  })
}

/** A run as the run picker shows it: counts, never notes, errors or warnings. */
export function summariseRun(run: Doc<"harvestRuns">): RunSummary {
  return {
    runKey: run.runKey,
    command: run.command,
    group: runGroup(run),
    revision: run.revision ?? null,
    pipelineVersion: run.pipelineVersion,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.finishedAt === null ? null : run.finishedAt - run.startedAt,
    requestedStages: run.requestedStages,
    stages: run.stages.map((stage) => ({
      name: stage.name,
      status: stage.status,
      inserted: stage.inserted,
      updated: stage.updated,
      unchanged: stage.unchanged,
      skipped: stage.skipped,
      durationMs: stage.durationMs ?? null,
      failed: stage.error !== null,
    })),
    warningCount: run.warnings.length,
    hasError: run.error !== null,
  }
}

// --- queries --------------------------------------------------------------------------------

/**
 * Per-stage status over the newest `STATUS_SCAN` runs, optionally only those
 * of one group (`events`, `full`, `talks`: the recorded `group`, else parsed
 * from `command`).
 */
export const stageStatus = query({
  args: { group: v.optional(v.string()) },
  returns: v.array(stageStatusRow),
  handler: async (ctx, args) => {
    await requireBrokerUser(ctx)
    const scanned = await ctx.db
      .query("harvestRuns")
      .withIndex("by_startedAt")
      .order("desc")
      .take(STATUS_SCAN)
    const runs =
      args.group === undefined ? scanned : scanned.filter((run) => runGroup(run) === args.group)
    if (runs.length === 0) return []
    const talkRun = runs.some(
      (run) => run.requestedStages.includes("talks") || run.stages.some((s) => s.name === "talks"),
    )
      ? await ctx.db.query("talkRuns").withIndex("by_finishedAt").order("desc").first()
      : null
    return summariseStages(runs, { now: Date.now(), talkRun })
  },
})

/** The newest runs (at most `MAX_RUNS`), optionally of one group, for the run picker. */
export const runs = query({
  args: { group: v.optional(v.string()), limit: v.optional(v.number()) },
  returns: v.array(runSummary),
  handler: async (ctx, args) => {
    await requireBrokerUser(ctx)
    const requested = args.limit ?? 10
    const limit = Number.isFinite(requested)
      ? Math.max(1, Math.min(MAX_RUNS, Math.floor(requested)))
      : 10
    const out: RunSummary[] = []
    let scanned = 0
    for await (const run of ctx.db.query("harvestRuns").withIndex("by_startedAt").order("desc")) {
      if (++scanned > RUNS_SCAN || out.length >= limit) break
      if (args.group !== undefined && runGroup(run) !== args.group) continue
      out.push(summariseRun(run))
    }
    return out
  },
})

/** One stage of one run with its notes and error, or null when either is
 * unknown. Broker-only; the dashboard opens it behind a disclosure. */
export const stageDetail = query({
  args: { runKey: v.string(), stage: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      runKey: v.string(),
      group: v.union(v.null(), v.string()),
      revision: v.union(v.null(), v.string()),
      startedAt: v.number(),
      finishedAt: nullableNumber,
      name: v.string(),
      status: literalUnion(HARVEST_STAGE_STATUSES),
      inserted: v.number(),
      updated: v.number(),
      unchanged: v.number(),
      skipped: v.number(),
      durationMs: nullableNumber,
      metrics: v.record(v.string(), v.number()),
      notes: v.array(v.string()),
      error: v.union(v.null(), v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    await requireBrokerUser(ctx)
    const run = await ctx.db
      .query("harvestRuns")
      .withIndex("by_runKey", (q) => q.eq("runKey", args.runKey))
      .unique()
    const stage = run?.stages.find((s) => s.name === args.stage)
    if (!run || !stage) return null
    return {
      runKey: run.runKey,
      group: runGroup(run),
      revision: run.revision ?? null,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      name: stage.name,
      status: stage.status,
      inserted: stage.inserted,
      updated: stage.updated,
      unchanged: stage.unchanged,
      skipped: stage.skipped,
      durationMs: stage.durationMs ?? null,
      metrics: stage.metrics ?? {},
      notes: stage.notes,
      error: stage.error,
    }
  },
})
