import { v } from "convex/values"
import { sourceKey } from "../../lib/keys"
import { ROBOTS_VERDICTS, SOURCE_TYPES } from "../../lib/vocab"
import { internalMutation } from "../_generated/server"
import { hostOf } from "../lib/fields"
import {
  assertBatchSize,
  type BatchResult,
  emptyBatchResult,
  recordBatch,
  upsertRow,
} from "../lib/ingest"
import { literalUnion } from "../lib/validators"

/**
 * `POST /api/pipeline/sources` — one row per fetched URL (data-model §3),
 * upserted by key. The key must be `src-<sha1(url)>` (lib/keys.ts
 * `sourceKey`, pipeline `keys.source_key`); `host` is derived here.
 */

export const sourceInputValidator = v.object({
  key: v.string(),
  url: v.string(),
  sourceType: literalUnion(SOURCE_TYPES),
  orgKey: v.optional(v.string()),
  httpStatus: v.optional(v.number()),
  accessNote: v.optional(v.string()),
  contentSha256: v.optional(v.string()),
  lastFetchedAt: v.number(),
  yielded: v.optional(v.array(v.string())),
  robotsVerdict: literalUnion(ROBOTS_VERDICTS),
  robotsCheckedAt: v.number(),
})

const batchResult = v.object({ inserted: v.number(), updated: v.number(), unchanged: v.number() })

export const upsert = internalMutation({
  args: { sources: v.array(sourceInputValidator) },
  returns: batchResult,
  handler: async (ctx, args): Promise<BatchResult> => {
    assertBatchSize(args.sources.length, "sources")
    const now = Date.now()
    const result = emptyBatchResult()
    for (const source of args.sources) {
      if (source.key !== sourceKey(source.url)) {
        throw new Error(`Source key ${source.key} is not sourceKey(${source.url})`)
      }
      if ((source.yielded?.length ?? 0) > 1_000) throw new Error("yielded is limited to 1000")
      const existing = await ctx.db
        .query("sources")
        .withIndex("by_key", (q) => q.eq("key", source.key))
        .unique()
      const { outcome } = await upsertRow(
        ctx,
        "sources",
        existing,
        { ...source, host: hostOf(source.url), yielded: source.yielded ?? [] },
        now,
        { touchUpdatedAt: true },
      )
      recordBatch(result, outcome)
    }
    return result
  },
})
