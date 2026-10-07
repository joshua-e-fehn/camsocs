import { v } from "convex/values"
import type { HarvestRunStatus } from "../lib/vocab"
import type { Doc } from "./_generated/dataModel"
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server"
import { assertBatchSize, sameFields, withoutSystemFields } from "./lib/ingest"
import { type HarvestStageResult, harvestRunFields, harvestStageResult } from "./schema"

/**
 * The pipeline's run log: `start` opens a `harvestRuns` row before any data is
 * written, `finish` closes it with per-stage results.
 *
 * Both are `internalMutation`s reached only through `/api/pipeline/runs/*`
 * (convex/http.ts), behind the pipeline's Bearer key. Throws are the caller's
 * fault and map to 400, or 404 when the message says "not found".
 */

/** A stage list longer than this is a bug in the caller, not a big run. */
const MAX_STAGES = 50

/**
 * The run's status, derived from what its stages reported.
 *
 * Server-side on purpose: a posted status could disagree with the stages it
 * summarises, and the stages are the evidence.
 */
export function deriveRunStatus(
  stages: readonly Pick<HarvestStageResult, "status">[],
  error: string | null,
): Exclude<HarvestRunStatus, "running"> {
  if (error !== null) return "failed"
  const failed = stages.filter((stage) => stage.status !== "ok").length
  if (failed === 0) return "success"
  return failed === stages.length ? "failed" : "partial"
}

async function findRun(ctx: MutationCtx, runKey: string): Promise<Doc<"harvestRuns"> | null> {
  return await ctx.db
    .query("harvestRuns")
    .withIndex("by_runKey", (q) => q.eq("runKey", runKey))
    .unique()
}

/**
 * Opens a run. The row exists before any data is written, so a run that dies
 * on its first batch still leaves evidence it was attempted.
 *
 * A duplicate `runKey` is refused: keys are minted per invocation, and reusing
 * one would merge two runs' results into one row.
 */
export const start = internalMutation({
  args: {
    runKey: v.string(),
    command: v.string(),
    requestedStages: v.array(v.string()),
    pipelineVersion: v.string(),
  },
  returns: v.object({ runKey: v.string(), created: v.boolean() }),
  handler: async (ctx, args) => {
    if (args.runKey.trim() === "") throw new Error("runKey must not be empty")
    if (args.requestedStages.length > MAX_STAGES) {
      throw new Error(`Too many stages: ${args.requestedStages.length}, maximum is ${MAX_STAGES}`)
    }
    if ((await findRun(ctx, args.runKey)) !== null) {
      throw new Error(`Run ${args.runKey} already exists; run keys are minted per invocation`)
    }
    const now = Date.now()
    await ctx.db.insert("harvestRuns", {
      runKey: args.runKey,
      command: args.command,
      requestedStages: args.requestedStages,
      pipelineVersion: args.pipelineVersion,
      status: "running",
      startedAt: now,
      finishedAt: null,
      stages: [],
      warnings: [],
      error: null,
      createdAt: now,
      updatedAt: now,
    })
    return { runKey: args.runKey, created: true }
  },
})

/**
 * Closes a run with its per-stage results and warnings.
 *
 * Idempotent: the pipeline retries a finish whose response was lost in
 * transit, so an identical second call reports `unchanged` and writes nothing.
 * A *different* second call is refused — a finished run's record is evidence
 * and is not rewritten.
 */
export const finish = internalMutation({
  args: {
    runKey: v.string(),
    stages: v.array(harvestStageResult),
    warnings: v.array(v.string()),
    error: v.union(v.null(), v.string()),
  },
  returns: v.object({
    runKey: v.string(),
    status: v.union(v.literal("success"), v.literal("partial"), v.literal("failed")),
    unchanged: v.boolean(),
  }),
  handler: async (ctx, args) => {
    if (args.stages.length > MAX_STAGES) {
      throw new Error(`Too many stages: ${args.stages.length}, maximum is ${MAX_STAGES}`)
    }
    assertBatchSize(args.warnings.length, "warnings")

    const run = await findRun(ctx, args.runKey)
    if (run === null) throw new Error(`Run ${args.runKey} not found`)

    const status = deriveRunStatus(args.stages, args.error)
    const fields = { stages: args.stages, warnings: args.warnings, error: args.error, status }

    if (run.finishedAt !== null) {
      if (sameFields(run, fields)) return { runKey: args.runKey, status, unchanged: true }
      throw new Error(`Run ${args.runKey} already finished with different results`)
    }

    const now = Date.now()
    await ctx.db.patch(run._id, { ...fields, finishedAt: now, updatedAt: now })
    return { runKey: args.runKey, status, unchanged: false }
  },
})

/** The most recent runs, newest first — for operators and a future status page. */
export const latest = internalQuery({
  args: { limit: v.optional(v.number()) },
  returns: v.array(v.object(harvestRunFields)),
  handler: async (ctx, args) => {
    const requested = args.limit ?? 10
    const limit = Number.isFinite(requested) ? Math.max(1, Math.min(50, Math.floor(requested))) : 10
    const rows = await ctx.db
      .query("harvestRuns")
      .withIndex("by_startedAt")
      .order("desc")
      .take(limit)
    return rows.map((row) => withoutSystemFields<"harvestRuns">(row))
  },
})
