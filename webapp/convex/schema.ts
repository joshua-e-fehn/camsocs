import { defineSchema, defineTable } from "convex/server"
import { type Infer, v } from "convex/values"
import { HARVEST_RUN_STATUSES, HARVEST_STAGE_STATUSES } from "../lib/vocab"
import { literalUnion } from "./lib/validators"

/**
 * The application schema. Better Auth's tables live in its own component
 * (convex/betterAuth/schema.ts), not here.
 *
 * Deliberately minimal: the domain tables (societies, events, sources, field
 * claims, and the private broker tables) are specified in docs/data-model.md
 * and land separately. What is here is the first *pipeline-owned* table, so the
 * ingestion path can be exercised end to end.
 *
 * Rules every table follows (Bundestracker schema.ts, salo-ba, cambridge):
 *
 *  - **Minted string keys, never `v.id`, for identity.** A row is addressed by
 *    a key the pipeline can compute (`runKey`, later `soc-<slug>`), so a
 *    re-run finds the same row and a URL survives a table rebuild.
 *  - **Three states for a value.** A value; `null` = "observed, and the source
 *    says there is none" (a known unknown); absent (`v.optional`) = "not
 *    applicable / not observed". Never send null for "not fetched this run".
 *  - **Arrays are always present** (empty, not missing).
 *  - **`createdAt` / `updatedAt` are stamped by the mutation**, never posted.
 *  - **Pipeline-owned tables are written only by `internal*` mutations** behind
 *    `/api/pipeline/*` (convex/http.ts) — never by a user action.
 *  - **Closed vocabularies come from lib/vocab.ts** via `literalUnion`.
 */

/** One stage's result inside a run — what `pipeline/report.py` posts. */
export const harvestStageResult = v.object({
  name: v.string(),
  status: literalUnion(HARVEST_STAGE_STATUSES),
  inserted: v.number(),
  updated: v.number(),
  unchanged: v.number(),
  /** Items the stage saw but did not write — robots-disallowed, quarantined,
   * unchanged-on-fetch. Counted so a stage's report adds up. */
  skipped: v.number(),
  error: v.union(v.null(), v.string()),
  notes: v.array(v.string()),
})
export type HarvestStageResult = Infer<typeof harvestStageResult>

/**
 * One row per pipeline run that reached Convex (`--dry-run` never writes).
 *
 * Combines salo-ba `importRuns` (a row exists from the first call, so a run
 * that died is visible as one that never finished) with Fiscalis's sync status
 * (`success | partial | failed`). `status` is derived server-side from
 * `stages` in `runs.finish`, never posted.
 */
export const harvestRunFields = {
  /** Minted by the pipeline per invocation, e.g. `20261007T215500Z-3f9a1c`. */
  runKey: v.string(),
  /** The CLI command, e.g. `sync`. */
  command: v.string(),
  /** Stage names in the order requested. */
  requestedStages: v.array(v.string()),
  /** `camsocs_pipeline.__version__` of the code that ran. */
  pipelineVersion: v.string(),
  status: literalUnion(HARVEST_RUN_STATUSES),
  startedAt: v.number(),
  /** null until `runs.finish`. */
  finishedAt: v.union(v.null(), v.number()),
  stages: v.array(harvestStageResult),
  warnings: v.array(v.string()),
  /** A run-level failure (e.g. the health check failed mid-run). */
  error: v.union(v.null(), v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
}

export default defineSchema({
  harvestRuns: defineTable(harvestRunFields)
    .index("by_runKey", ["runKey"])
    .index("by_startedAt", ["startedAt"]),
})
