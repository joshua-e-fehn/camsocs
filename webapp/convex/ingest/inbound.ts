import { v } from "convex/values"
import { INBOUND_EXTRACTION_STATUSES } from "../../lib/vocab"
import { internalMutation, internalQuery } from "../_generated/server"
import { assertBatchSize, pageLimit } from "../lib/ingest"
import { literalUnion } from "../lib/validators"
import { inboundAttachmentValidator } from "../schema"

/**
 * The pipeline's side of the mailing-list inbox (source-research §16):
 *
 *  - `POST /api/pipeline/inbound/pending` — the oldest `pending` mails, for
 *    extraction. Raw mail is internal: it reaches only the pipeline key.
 *  - `POST /api/pipeline/inbound/mark` — record each mail's outcome and the
 *    event keys extracted from it.
 *
 * Mail lands in `inboundEmails` through the inbound webhook (T7), not here.
 */

export const pendingMailValidator = v.object({
  messageId: v.string(),
  receivedAt: v.number(),
  from: v.string(),
  listId: v.optional(v.string()),
  listName: v.optional(v.string()),
  subject: v.string(),
  text: v.string(),
  htmlStorageId: v.optional(v.id("_storage")),
  attachments: v.array(inboundAttachmentValidator),
  orgKey: v.optional(v.string()),
})

export const pending = internalQuery({
  args: { limit: v.optional(v.number()) },
  returns: v.array(pendingMailValidator),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("inboundEmails")
      .withIndex("by_extraction_receivedAt", (q) => q.eq("extraction", "pending"))
      .order("asc")
      .take(pageLimit(args.limit, 50))
    return rows.map((row) => ({
      messageId: row.messageId,
      receivedAt: row.receivedAt,
      from: row.from,
      listId: row.listId,
      listName: row.listName,
      subject: row.subject,
      text: row.text,
      htmlStorageId: row.htmlStorageId,
      attachments: row.attachments,
      orgKey: row.orgKey,
    }))
  },
})

export const mark = internalMutation({
  args: {
    items: v.array(
      v.object({
        messageId: v.string(),
        extraction: literalUnion(INBOUND_EXTRACTION_STATUSES),
        extractedEventKeys: v.optional(v.array(v.string())),
        orgKey: v.optional(v.string()),
        note: v.optional(v.string()),
      }),
    ),
  },
  returns: v.object({
    inserted: v.number(),
    updated: v.number(),
    unchanged: v.number(),
    missing: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    assertBatchSize(args.items.length, "inbound marks")
    const now = Date.now()
    const result = { inserted: 0, updated: 0, unchanged: 0, missing: [] as string[] }
    for (const item of args.items) {
      const row = await ctx.db
        .query("inboundEmails")
        .withIndex("by_messageId", (q) => q.eq("messageId", item.messageId))
        .unique()
      if (!row) {
        result.missing.push(item.messageId)
        continue
      }
      await ctx.db.patch("inboundEmails", row._id, {
        extraction: item.extraction,
        extractedEventKeys: item.extractedEventKeys ?? row.extractedEventKeys,
        orgKey: item.orgKey ?? row.orgKey,
        extractionNote: item.note?.slice(0, 2_000),
        updatedAt: now,
      })
      result.updated++
    }
    return result
  },
})
