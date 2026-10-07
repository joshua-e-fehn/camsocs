import { v } from "convex/values"
import { INBOUND_EXTRACTION_STATUSES } from "../../lib/vocab"
import { internalMutation, internalQuery } from "../_generated/server"
import { assertBatchSize, pageLimit } from "../lib/ingest"
import { literalUnion } from "../lib/validators"
import { inboundAttachmentValidator } from "../schema"

/**
 * The mailing-list inbox (source-research §16). Raw mail is personal data:
 * every function here is internal, reached only through the inbound webhook's
 * secret or the pipeline key, and nothing public reads `inboundEmails`.
 *
 * The webhook's side (`POST /api/inbound/email`, convex/http.ts):
 *
 *  - `hasMessage` — dedupe before fetching a body from the provider;
 *  - `receive` — store one mail as `pending` (idempotent by `messageId`).
 *
 * The pipeline's side:
 *
 *  - `POST /api/pipeline/inbound/pending` — the oldest `pending` mails, for
 *    extraction;
 *  - `POST /api/pipeline/inbound/file` — one stored attachment of a mail
 *    (`fileOf` checks it belongs to that mail);
 *  - `POST /api/pipeline/inbound/mark` — record each mail's outcome and the
 *    event keys extracted from it.
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

// --- the webhook's side -------------------------------------------------------------

export const hasMessage = internalQuery({
  args: { messageId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("inboundEmails")
      .withIndex("by_messageId", (q) => q.eq("messageId", args.messageId))
      .first()
    return row !== null
  },
})

/**
 * Stores one received mail as `pending`. Idempotent by `messageId`: a provider
 * retry, or the same list mail reaching us twice, is acknowledged and not
 * stored again (`stored: false`); the caller then deletes the files it
 * uploaded for the duplicate.
 */
export const receive = internalMutation({
  args: {
    messageId: v.string(),
    receivedAt: v.number(),
    from: v.string(),
    listId: v.optional(v.string()),
    listName: v.optional(v.string()),
    subject: v.string(),
    text: v.string(),
    htmlStorageId: v.optional(v.id("_storage")),
    attachments: v.array(inboundAttachmentValidator),
    note: v.optional(v.string()),
  },
  returns: v.object({ stored: v.boolean() }),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("inboundEmails")
      .withIndex("by_messageId", (q) => q.eq("messageId", args.messageId))
      .first()
    if (existing) return { stored: false }
    const now = Date.now()
    const { note, ...mail } = args
    await ctx.db.insert("inboundEmails", {
      ...mail,
      extraction: "pending",
      extractedEventKeys: [],
      extractionNote: note?.slice(0, 2_000),
      createdAt: now,
      updatedAt: now,
    })
    return { stored: true }
  },
})

// --- the pipeline's side: one stored file ---------------------------------------------

/**
 * The stored HTML body or attachment `storageId` of the mail `messageId`, or
 * null — so `/api/pipeline/inbound/file` serves only inbox files, never an
 * arbitrary storage id (logos and termcards have their own public URLs).
 */
export const fileOf = internalQuery({
  args: { messageId: v.string(), storageId: v.id("_storage") },
  returns: v.union(
    v.null(),
    v.object({ storageId: v.id("_storage"), filename: v.string(), contentType: v.string() }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("inboundEmails")
      .withIndex("by_messageId", (q) => q.eq("messageId", args.messageId))
      .first()
    if (!row) return null
    if (row.htmlStorageId === args.storageId) {
      return { storageId: args.storageId, filename: "body.html", contentType: "text/html" }
    }
    return row.attachments.find((item) => item.storageId === args.storageId) ?? null
  },
})
