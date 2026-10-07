import type { WithoutSystemFields } from "convex/server"
import type { Doc, TableNames } from "../_generated/dataModel"
import type { MutationCtx } from "../_generated/server"

/**
 * What every pipeline-ingestion mutation shares.
 *
 * Combines Bundestracker's convex/lib/ingest.ts (upsert on a natural key, batch
 * ceiling) with salo-ba's importResearch.ts (write only when a field actually
 * differs; prune last, and refuse an implausibly large prune).
 *
 * The pipeline re-runs: a nightly sync re-reads pages, a failed run is simply
 * run again, and re-sending a batch must be a no-op rather than a second copy
 * or a pointless rewrite. So "insert if new, patch if changed, otherwise leave
 * alone" is the only write shape here, defined once.
 *
 * ⚠ Patch semantics: a field absent from the incoming row is left untouched,
 * never removed. The pipeline therefore omits fields it did not observe rather
 * than sending null — Bundestracker lost 633 portraits on 2026-07-29 to a
 * transform that sent null for "not fetched this run".
 */

/** Convex reads ~16 000 documents and writes ~8 000 in one transaction. A batch
 * upsert costs one indexed read and at most one write per row, so 500 leaves
 * room for index lookups underneath. The pipeline chunks to this (`MAX_BATCH`
 * in pipeline/src/camsocs_pipeline/pipeline/load.py); the mutations enforce it.
 * The two must not drift. */
export const MAX_BATCH = 500

/** Ceiling on any client-supplied `limit`, so a list query is never one bad
 * argument away from reading a whole table. */
export const MAX_PAGE = 500

/** Clamps a caller-supplied limit into `1…MAX_PAGE`. `NaN` falls back rather
 * than reaching `.take(NaN)`, which returns an empty page that looks like
 * missing data. */
export function pageLimit(limit: number | undefined, fallback = 50): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback
  return Math.max(1, Math.min(MAX_PAGE, Math.floor(limit)))
}

/** Rejects an oversized batch, naming the unit, so the pipeline gets a 400 it
 * can chunk and retry instead of a 200 that silently wrote a prefix. */
export function assertBatchSize(count: number, unit: string): void {
  if (count > MAX_BATCH) {
    throw new Error(`Batch too large: ${count} ${unit}, maximum is ${MAX_BATCH}`)
  }
}

/** The system fields Convex adds and the ingestion API does not expose. Tables
 * are addressed by minted string keys, never `_id`. */
type SystemFields = "_id" | "_creationTime"

/** Drops Convex's system fields — the read-model shape for a keyed table. */
export function withoutSystemFields<Table extends TableNames>(
  row: Doc<Table>,
): Omit<Doc<Table>, SystemFields> {
  const { _id, _creationTime, ...rest } = row
  return rest
}

/**
 * A table's document minus everything the *caller* does not supply: Convex's
 * system fields, and the timestamps the mutation stamps itself.
 */
export type IngestFields<Table extends TableNames> = Omit<
  WithoutSystemFields<Doc<Table>>,
  "createdAt" | "updatedAt"
>

/**
 * Structural equality over Convex values (null, booleans, numbers, bigints,
 * strings, ArrayBuffers, arrays, plain objects). `undefined` equals a missing
 * key, as it does in Convex.
 */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a === "number" && typeof b === "number") return Object.is(a, b)
  if (a instanceof ArrayBuffer && b instanceof ArrayBuffer) {
    if (a.byteLength !== b.byteLength) return false
    const left = new Uint8Array(a)
    const right = new Uint8Array(b)
    return left.every((byte, index) => byte === right[index])
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((value, index) => valuesEqual(value, b[index]))
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const left = a as Record<string, unknown>
    const right = b as Record<string, unknown>
    const keys = new Set([...Object.keys(left), ...Object.keys(right)])
    for (const key of keys) {
      if (!valuesEqual(left[key], right[key])) return false
    }
    return true
  }
  return false
}

/**
 * Whether `existing` already holds every value `incoming` would write.
 *
 * Only the incoming keys are compared — the patch leaves every other field
 * alone, so a field the caller did not send cannot make the row "different".
 */
export function sameFields(existing: Record<string, unknown>, incoming: Record<string, unknown>) {
  return Object.keys(incoming).every((key) => valuesEqual(existing[key], incoming[key]))
}

/** What happened to one row. */
export type UpsertOutcome = "inserted" | "updated" | "unchanged"

/**
 * Inserts `fields`, patches `existing` with them, or does nothing when nothing
 * would change — and reports which.
 *
 * The comparison (salo-ba) is what makes a re-run cheap and observable: a
 * second sync over unchanged sources reports every row `unchanged` and writes
 * nothing, and a non-zero `updated` with no upstream change points at a
 * non-deterministic transform. `updatedAt` is stamped only on a real change.
 *
 * The casts are the price of being generic over `Table`: `patch` and `insert`
 * resolve their parameter types from a concrete table name.
 */
export async function upsertRow<Table extends TableNames>(
  ctx: MutationCtx,
  table: Table,
  existing: Doc<Table> | null,
  fields: IngestFields<Table>,
  now: number,
  options: { touchUpdatedAt?: boolean } = {},
): Promise<{ id: Doc<Table>["_id"]; outcome: UpsertOutcome }> {
  const incoming = fields as unknown as Record<string, unknown>
  if (existing) {
    if (sameFields(existing as unknown as Record<string, unknown>, incoming)) {
      return { id: existing._id, outcome: "unchanged" }
    }
    const patch = options.touchUpdatedAt ? { ...incoming, updatedAt: now } : incoming
    await ctx.db.patch(existing._id, patch as unknown as Partial<Doc<Table>>)
    return { id: existing._id, outcome: "updated" }
  }
  const stamped = options.touchUpdatedAt ? { ...incoming, updatedAt: now } : incoming
  const id = await ctx.db.insert(table, {
    ...stamped,
    createdAt: now,
  } as unknown as WithoutSystemFields<Doc<Table>>)
  return { id, outcome: "inserted" }
}

/** What a batch ingestion reports back. */
export type BatchResult = { inserted: number; updated: number; unchanged: number }

export function emptyBatchResult(): BatchResult {
  return { inserted: 0, updated: 0, unchanged: 0 }
}

export function recordBatch(result: BatchResult, outcome: UpsertOutcome): void {
  result[outcome]++
}

// --- pruning ----------------------------------------------------------------

/**
 * The fraction of a table an unattended prune may delete (salo-ba
 * `PRUNE_SAFETY_RATIO`). Directories grow and are corrected; they do not halve.
 * A prune past this is far more likely to be a crawl that fetched a fraction of
 * its sources than half the societies disbanding overnight.
 */
export const PRUNE_SAFETY_RATIO = 0.5

/**
 * The most rows a whole-table prune will read in one transaction. Hitting it
 * means something is wrong upstream, and the prune stops rather than acting on
 * a prefix — a delete set computed from a partial read deletes live rows.
 * Below Convex's per-transaction write limit, so the deletes fit too.
 */
export const WHOLE_TABLE_LIMIT = 8000

/**
 * Which rows a prune would delete: those whose key is not in `keepKeys`.
 *
 * Throws instead of returning when more than `PRUNE_SAFETY_RATIO` of a
 * non-empty table would go, unless `allowLargeDeletion` is set — the scenario
 * is a run that crashed after loading a third of its batches and then prunes
 * against that third. A refusal is recoverable in a minute; a silent deletion
 * is discovered by a reader concluding that a society no longer exists.
 *
 * Pure, so the guard is unit-tested without a database.
 */
export function planPrune<Row>(
  existing: readonly Row[],
  keyOf: (row: Row) => string,
  keepKeys: Iterable<string>,
  options: { unit: string; allowLargeDeletion?: boolean },
): Row[] {
  const keep = new Set(keepKeys)
  const doomed = existing.filter((row) => !keep.has(keyOf(row)))
  if (
    options.allowLargeDeletion !== true &&
    existing.length > 0 &&
    doomed.length > existing.length * PRUNE_SAFETY_RATIO
  ) {
    throw new Error(
      `Refusing to delete ${doomed.length} of ${existing.length} ${options.unit}. ` +
        `A prune this large usually means the run sent an incomplete key set. ` +
        `If the source really shrank, re-run with allowLargeDeletion: true.`,
    )
  }
  return doomed
}

/**
 * Deletes every row of `table` whose key is not in `keepKeys`.
 *
 * ⚠ Call only after every batch of that table in the run has been
 * acknowledged, so an interrupted run leaves *stale* rows rather than
 * *missing* ones. Prefer marking rows stale/archived over deleting them where a
 * table carries history; this is for tables that genuinely mirror a source.
 */
export async function pruneTable<Table extends TableNames>(
  ctx: MutationCtx,
  table: Table,
  keyOf: (row: Doc<Table>) => string,
  keepKeys: Iterable<string>,
  options: { allowLargeDeletion?: boolean } = {},
): Promise<{ deleted: number }> {
  const rows = (await ctx.db.query(table).take(WHOLE_TABLE_LIMIT + 1)) as Doc<Table>[]
  if (rows.length > WHOLE_TABLE_LIMIT) {
    throw new Error(
      `${table} holds more than ${WHOLE_TABLE_LIMIT} rows; refusing to prune against a ` +
        `partial read. Inspect the table before continuing.`,
    )
  }
  const doomed = planPrune(rows, keyOf, keepKeys, { unit: `${table} rows`, ...options })
  for (const row of doomed) await ctx.db.delete(row._id)
  return { deleted: doomed.length }
}
