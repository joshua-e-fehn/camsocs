import type { FetchSummary, RunSummary, StageStatusRow } from "@/convex/broker/pipeline"
import type { GraphSource, GroupKey, PipelineGraph, StageNode } from "./graph"
import { stageNodes } from "./graph"

/**
 * What a stage node and a status row show (spec §5B, §5D), computed from the
 * broker's pipeline-status reads (`convex/broker/pipeline.ts`): pure, so the
 * mapping is tested without React or Convex.
 *
 * A state is always shown as an icon and a word as well as a colour
 * (DESIGN.md "Never rely on color alone"); the words live here.
 */

export const NODE_STATES = ["ok", "failed", "not_run", "not_requested", "running"] as const
export type NodeState = (typeof NODE_STATES)[number]

export const STATE_WORDS: Record<NodeState, string> = {
  ok: "ok",
  failed: "failed",
  not_run: "not run",
  not_requested: "not requested",
  running: "running",
}

/** The yield-drop rule, mirroring the monitor's shadow check `yield_drop`
 * (spec §6, monitor.py `_yield_drop`), over at least three prior ok runs:
 * the latest yield below a quarter of a median of at least five, or a yield
 * of zero against any median above zero. */
export const YIELD_DROP_RATIO = 0.25
export const YIELD_MIN_SAMPLES = 3
export const YIELD_MIN_MEDIAN = 5

/** Equal to `RUNNING_STALE_MS` in convex/broker/pipeline.ts (a test holds them
 * equal; that module is server code, so it is not imported here). */
export const RUNNING_STALE_MS = 12 * 60 * 60 * 1000

export type StageView = {
  /** Where the view comes from: the newest result per stage (`status`), or
   * one run the run picker chose (`run`), which has no baseline, streak or
   * freshness. */
  source: "status" | "run"
  state: NodeState
  /** The latest ok yield fell below a quarter of its median. */
  yieldDrop: boolean
  /** Consecutive failed results, newest first. */
  failStreak: number
  inserted: number | null
  updated: number | null
  unchanged: number | null
  skipped: number | null
  yield: number | null
  /** The baseline the yield is judged against, and its window. */
  median: number | null
  medianDays: 7 | 28
  medianSamples: number
  durationMs: number | null
  /** The run the node's numbers come from (the sheet's notes and error):
   * the newest posted result's run, or the chosen run. */
  runKey: string | null
  startedAt: number | null
  /** The run the state is about: the newest run that requested the stage.
   * Differs from `runKey` while that run is open, or when it ended without
   * posting the stage. */
  statusRunKey: string | null
  statusStartedAt: number | null
  lastOkAt: number | null
  lastProductiveAt: number | null
  fetch: FetchSummary | null
  talkRun: StageStatusRow["talkRun"]
}

const EMPTY: Omit<StageView, "state"> = {
  source: "status",
  yieldDrop: false,
  failStreak: 0,
  inserted: null,
  updated: null,
  unchanged: null,
  skipped: null,
  yield: null,
  median: null,
  medianDays: 28,
  medianSamples: 0,
  durationMs: null,
  runKey: null,
  startedAt: null,
  statusRunKey: null,
  statusStartedAt: null,
  lastOkAt: null,
  lastProductiveAt: null,
  fetch: null,
  talkRun: null,
}

/** Stages of the daily events group are judged over 7 days, full-only ones
 * over 28 (the monitor's windows). */
export function medianWindow(stage: Pick<StageNode, "groups">): 7 | 28 {
  return stage.groups.includes("events") ? 7 : 28
}

export function isYieldDrop(
  yieldValue: number | null,
  median: number | null,
  samples: number,
): boolean {
  if (yieldValue === null || median === null || samples < YIELD_MIN_SAMPLES) return false
  if (yieldValue === 0 && median > 0) return true
  return median >= YIELD_MIN_MEDIAN && yieldValue < YIELD_DROP_RATIO * median
}

/**
 * A stage's view from `stageStatus` (newest result per stage). With `group`
 * set, a stage outside that group reads `not_requested`; a stage of the group
 * that no scanned run mentions reads `not_run`.
 */
export function viewFromStatus(
  stage: StageNode,
  row: StageStatusRow | undefined,
  group?: GroupKey,
): StageView {
  if (group !== undefined && !stage.groups.includes(group)) {
    return { ...EMPTY, state: "not_requested" }
  }
  if (!row) return { ...EMPTY, state: "not_run", medianDays: medianWindow(stage) }
  const days = medianWindow(stage)
  const median = days === 7 ? row.yieldMedian7d : row.yieldMedian28d
  const samples = days === 7 ? row.yieldSamples7d : row.yieldSamples28d
  return {
    source: "status",
    state: row.lastStatus,
    yieldDrop: row.lastStatus === "ok" && isYieldDrop(row.yield, median, samples),
    failStreak: row.failStreak,
    inserted: row.inserted,
    updated: row.updated,
    unchanged: row.unchanged,
    skipped: row.skipped,
    yield: row.yield,
    median,
    medianDays: days,
    medianSamples: samples,
    durationMs: row.durationMs,
    runKey: row.resultRunKey,
    startedAt: row.resultStartedAt,
    statusRunKey: row.lastRunKey,
    statusStartedAt: row.lastStartedAt,
    lastOkAt: row.lastOkAt,
    lastProductiveAt: row.lastProductiveAt,
    fetch: row.fetch,
    talkRun: row.talkRun,
  }
}

/** A stage's view in one chosen run (the run picker): that run's counts and
 * fetches, no yield baseline, streak or freshness (`source: "run"`). */
export function viewFromRun(stage: StageNode, run: RunSummary, now: number): StageView {
  const result = run.stages.find((s) => s.name === stage.name)
  const base: Omit<StageView, "state"> = {
    ...EMPTY,
    source: "run",
    medianDays: medianWindow(stage),
    runKey: run.runKey,
    startedAt: run.startedAt,
    statusRunKey: run.runKey,
    statusStartedAt: run.startedAt,
  }
  if (!result && !run.requestedStages.includes(stage.name)) {
    return { ...base, state: "not_requested" }
  }
  if (result && run.finishedAt !== null) {
    return {
      ...base,
      state: result.status,
      failStreak: result.status === "failed" ? 1 : 0,
      inserted: result.inserted,
      updated: result.updated,
      unchanged: result.unchanged,
      skipped: result.skipped,
      yield: result.inserted + result.updated + result.unchanged,
      durationMs: result.durationMs,
      fetch: result.fetch,
    }
  }
  const open = run.finishedAt === null && now - run.startedAt < RUNNING_STALE_MS
  return { ...base, state: open ? "running" : "not_run" }
}

/** Every stage's view, keyed by stage name. */
export function stageViews(
  graph: PipelineGraph,
  source:
    | { kind: "status"; rows: readonly StageStatusRow[]; group?: GroupKey }
    | { kind: "run"; run: RunSummary; now: number },
): Record<string, StageView> {
  const out: Record<string, StageView> = {}
  if (source.kind === "status") {
    const byName = new Map(source.rows.map((row) => [row.name, row]))
    for (const stage of stageNodes(graph)) {
      out[stage.name] = viewFromStatus(stage, byName.get(stage.name), source.group)
    }
  } else {
    for (const stage of stageNodes(graph)) {
      out[stage.name] = viewFromRun(stage, source.run, source.now)
    }
  }
  return out
}

/** The status word with the streak and the yield flag: "failed ×3", "ok · yield ↓". */
export function statusText(view: Pick<StageView, "state" | "failStreak" | "yieldDrop">): string {
  const word = STATE_WORDS[view.state]
  const streak = view.state === "failed" && view.failStreak > 1 ? ` ×${view.failStreak}` : ""
  return `${word}${streak}${view.yieldDrop ? " · yield ↓" : ""}`
}

/** fetch errors / fetch requests, or null when nothing was fetched or recorded. */
export function fetchErrorShare(fetch: FetchSummary | null): number | null {
  if (!fetch || fetch.requests === 0) return null
  return fetch.errors / fetch.requests
}

/** latest yield / median, or null without both. */
export function yieldRatio(view: Pick<StageView, "yield" | "median">): number | null {
  if (view.yield === null || view.median === null || view.median === 0) return null
  return view.yield / view.median
}

/** "850 ms", "4.2 s", "3 min 05 s", "1 h 12 min"; "—" when not recorded. */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—"
  if (ms < 1000) return `${Math.round(ms)} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)} s`
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  if (hours > 0) return `${hours} h ${String(minutes).padStart(2, "0")} min`
  return `${minutes} min ${String(rest).padStart(2, "0")} s`
}

/** "1,204"; "—" when not recorded. */
export function formatCount(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-GB")
}

/** Counts of each state over some views (the per-pillar health line). */
export function stateCounts(views: readonly StageView[]): Record<NodeState, number> & {
  yieldDrop: number
} {
  const counts = { ok: 0, failed: 0, not_run: 0, not_requested: 0, running: 0, yieldDrop: 0 }
  for (const view of views) {
    counts[view.state]++
    if (view.yieldDrop) counts.yieldDrop++
  }
  return counts
}

/** One row of `/dashboard/status`: a manifest source joined to its stage's status. */
export type SourceStatusRow = {
  source: GraphSource
  stage: StageNode | null
  view: StageView
  errorShare: number | null
  ratio: number | null
}

/**
 * The status table: one row per manifest source, in manifest order, joined to
 * its stage's newest result. Several sources may share a stage (`enrich`
 * reads Linktree pages and society websites); each shows that stage's numbers.
 */
export function sourceStatusRows(
  graph: PipelineGraph,
  rows: readonly StageStatusRow[],
): SourceStatusRow[] {
  const stages = new Map(stageNodes(graph).map((stage) => [stage.name, stage]))
  const byName = new Map(rows.map((row) => [row.name, row]))
  return graph.sources.map((source) => {
    const stage = stages.get(source.stage) ?? null
    const view = stage
      ? viewFromStatus(stage, byName.get(stage.name))
      : { ...EMPTY, state: "not_run" as const }
    return { source, stage, view, errorShare: fetchErrorShare(view.fetch), ratio: yieldRatio(view) }
  })
}

/**
 * Why a view has no fetch counters, in a word for the status table:
 * `no_fetch` for a stage that never fetches from the web (`network: false`),
 * `no_result` before the stage's first result, `none_recorded` for a result
 * without counters (the pipeline writes them only when the stage fetched at
 * least once, and results from before fetch metrics have none); null when
 * the counters are there.
 */
export type FetchGap = "no_fetch" | "no_result" | "none_recorded"

export function fetchGap(
  stage: Pick<StageNode, "network"> | null,
  view: Pick<StageView, "fetch" | "runKey">,
): FetchGap | null {
  if (stage && !stage.network) return "no_fetch"
  if (view.fetch !== null) return null
  return view.runKey === null ? "no_result" : "none_recorded"
}

/** Stages no manifest source names (resolve, classify, load, report…), in
 * registry order: the status page lists them so every stage's state shows. */
export function stagesWithoutSource(graph: PipelineGraph): StageNode[] {
  const named = new Set(graph.sources.map((source) => source.stage))
  return stageNodes(graph).filter((stage) => !named.has(stage.name))
}
