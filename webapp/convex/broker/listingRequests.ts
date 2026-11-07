import { ConvexError, v } from "convex/values"
import { sourceKey } from "../../lib/keys"
import { isOwnerField } from "../../lib/owner-corrections"
import { isEmail } from "../../lib/syntax"
import { LISTING_REQUEST_STATUSES, ORGANISATION_FIELDS, SUPPRESSION_SCOPES } from "../../lib/vocab"
import { internal } from "../_generated/api"
import type { Doc } from "../_generated/dataModel"
import { type MutationCtx, mutation, query } from "../_generated/server"
import type { ClaimInput } from "../ingest/claims"
import { requireBrokerUser } from "../lib/auth"
import { brokerOrgRefs, orgRefValidator } from "../lib/brokerRows"
import { withoutSystemFields } from "../lib/ingest"
import { emailConfig, RELAY_STALE_MS } from "../lib/requestNotify"
import { createSuppression } from "../lib/suppressionEffects"
import {
  contactHash,
  MAX_NAME_WORDS,
  nameHash,
  nameWords,
  type SuppressionTarget,
} from "../lib/suppressions"
import { literalUnion } from "../lib/validators"
import { relayState, resend, startTest } from "../notifications"
import { agentState } from "../requestAgent"
import { listingRequestFields, requestNotificationValidator } from "../schema"

/**
 * The inbox of claim / correct / remove / object / add requests from the
 * public form (`listingRequests.submit`). The broker reads them, links them
 * to the listing, sets their status, and accepts them:
 *
 *  - **a correction or claim** (`acceptCorrections`): the broker picks the
 *    fields and checks the values (lib/owner-corrections.ts turns the form's
 *    text into typed values), and each becomes an `owner_submitted` claim
 *    through the claims ingestion (`internal.ingest.claims.ingest`, run as a
 *    sub-transaction) — never a direct edit (data-model §0 rule 2). The
 *    claim's source is the request itself (`request:<key>`, internal, never
 *    shown). Any refused value fails the whole acceptance, so nothing is half
 *    applied.
 *  - **a removal or objection** (`acceptRemoval`): a suppression of the whole
 *    listing, some of its fields, one contact address or named people
 *    (convex/lib/suppressions.ts). It is enforced at once and kept so no later
 *    harvest brings the data back (retention.md R8).
 *
 * The submitter's address is not verified: reply to it before accepting a
 * removal. Requests are deleted by the retention job; suppressions stay.
 *
 * ⚠ Every function here calls `requireBrokerUser` first.
 */

const MAX = 500
/** Corrections accepted per request (the form allows 10). */
const MAX_CORRECTIONS = 30
const RAW_MAX = 20_000

/** Fields a removal may take off a listing. Not its name — remove the listing
 * instead — and not what places it (`isCounterpart`). */
const SUPPRESSIBLE_FIELDS = ORGANISATION_FIELDS.filter(
  (field) => field !== "name" && field !== "isCounterpart",
) as readonly string[]

export const list = query({
  args: { status: v.optional(literalUnion(LISTING_REQUEST_STATUSES)) },
  returns: v.array(v.object({ ...listingRequestFields, org: v.union(v.null(), orgRefValidator) })),
  handler: async (ctx, args) => {
    await requireBrokerUser(ctx)
    const status = args.status
    const rows = status
      ? await ctx.db
          .query("listingRequests")
          .withIndex("by_status_createdAt", (q) => q.eq("status", status))
          .order("desc")
          .take(MAX)
      : await ctx.db.query("listingRequests").order("desc").take(MAX)
    const refs = brokerOrgRefs(ctx)
    const out = []
    for (const row of rows) {
      out.push({
        ...withoutSystemFields<"listingRequests">(row),
        org: row.orgKey ? await refs(row.orgKey) : null,
      })
    }
    return out
  },
})

/** Open requests, for the sidebar's badge; counted up to `OPEN_CAP` (the
 * badge then reads "99+"). */
export const OPEN_CAP = 100

export const openCount = query({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    await requireBrokerUser(ctx)
    const rows = await ctx.db
      .query("listingRequests")
      .withIndex("by_status_createdAt", (q) => q.eq("status", "open"))
      .take(OPEN_CAP)
    return rows.length
  },
})

/** Where new requests are announced (ENG-104): email from Convex when Resend
 * is set up, Slack and WhatsApp through the VPS relay (Mya) when it has
 * called recently. No secrets. */
export const notificationChannels = query({
  args: {},
  returns: v.object({
    email: v.boolean(),
    relay: v.union(
      v.null(),
      v.object({
        channels: v.array(v.union(v.literal("slack"), v.literal("whatsapp"))),
        lastSeenAt: v.number(),
        stale: v.boolean(),
      }),
    ),
  }),
  handler: async (ctx) => {
    await requireBrokerUser(ctx)
    const relay = await relayState(ctx)
    return {
      email: emailConfig() !== null,
      relay: relay ? { ...relay, stale: Date.now() - relay.lastSeenAt > RELAY_STALE_MS } : null,
    }
  },
})

/** Sends a request's notification again on every channel. */
export const notifyAgain = mutation({
  args: { key: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireBrokerUser(ctx)
    await resend(ctx, await findRequest(ctx, args.key))
    return null
  },
})

/** The request agent's state (ENG-126): when it last called and whether
 * that is too long ago; null when it never has. */
export const requestAgent = query({
  args: {},
  returns: v.union(v.null(), v.object({ lastSeenAt: v.number(), stale: v.boolean() })),
  handler: async (ctx) => {
    await requireBrokerUser(ctx)
    return await agentState(ctx)
  },
})

/** Throws a request's draft away, so the agent drafts it again (within
 * about a minute). */
export const redraft = mutation({
  args: { key: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireBrokerUser(ctx)
    const row = await findRequest(ctx, args.key)
    if (row.status !== "open") throw new ConvexError("Only an open request is drafted")
    await ctx.db.patch("listingRequests", row._id, { draft: undefined })
    return null
  },
})

/** Queues a synthetic request for every channel; returns its key, whose
 * outcomes `notificationTest` reads as they arrive (the relay sends within
 * about a minute). Nothing is stored as a request. */
export const sendTestNotification = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    await requireBrokerUser(ctx)
    return await startTest(ctx)
  },
})

/** A test's outcomes so far, per channel. */
export const notificationTest = query({
  args: { key: v.string() },
  returns: v.union(v.null(), v.array(requestNotificationValidator)),
  handler: async (ctx, { key }) => {
    await requireBrokerUser(ctx)
    const row = await ctx.db
      .query("notificationTests")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique()
    return row ? row.notifications : null
  },
})

async function findRequest(ctx: MutationCtx, key: string): Promise<Doc<"listingRequests">> {
  const row = await ctx.db
    .query("listingRequests")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique()
  if (!row) throw new ConvexError("That request was not found")
  return row
}

export const setStatus = mutation({
  args: { key: v.string(), status: literalUnion(LISTING_REQUEST_STATUSES) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireBrokerUser(ctx)
    const row = await findRequest(ctx, args.key)
    await ctx.db.patch("listingRequests", row._id, {
      status: args.status,
      resolvedAt: args.status === "open" ? undefined : Date.now(),
    })
    return null
  },
})

/**
 * Accepts a claim or correction: each `{field, value}` becomes an
 * `owner_submitted` claim on the request's listing, and the request is marked
 * `accepted` with the fields applied. Values are checked by the claims
 * ingestion like any claim (validator, URL, length …); one refusal refuses
 * them all.
 */
export const acceptCorrections = mutation({
  args: {
    key: v.string(),
    corrections: v.array(v.object({ field: v.string(), value: v.any() })),
  },
  returns: v.object({ appliedFields: v.array(v.string()) }),
  handler: async (ctx, args) => {
    await requireBrokerUser(ctx)
    const request = await findRequest(ctx, args.key)
    if (request.kind !== "claim" && request.kind !== "correct") {
      throw new ConvexError("Only a claim or a correction carries values to accept")
    }
    if (!request.orgKey) throw new ConvexError("The request names no listing")
    if (args.corrections.length === 0) throw new ConvexError("Choose at least one field")
    if (args.corrections.length > MAX_CORRECTIONS) {
      throw new ConvexError(`At most ${MAX_CORRECTIONS} fields at once`)
    }
    const fields = args.corrections.map((correction) => correction.field)
    if (new Set(fields).size !== fields.length) throw new ConvexError("A field is listed twice")
    for (const field of fields) {
      if (!isOwnerField(field)) throw new ConvexError(`${field} cannot be corrected here`)
    }

    const url = `request:${request.key}`
    const claims: ClaimInput[] = args.corrections.map(({ field, value }) => {
      const raw = request.fields?.[field]
      return {
        entityType: "organisation",
        entityKey: request.orgKey as string,
        field,
        value,
        ...(raw !== undefined ? { valueRaw: raw.slice(0, RAW_MAX) } : {}),
        evidence: "primary",
        method: "owner_submitted",
        extractor: "listing-request",
        sourceKey: sourceKey(url),
        sourceUrl: url,
        sourceType: "manual",
        retrievedAt: request.createdAt,
      }
    })
    const result = await ctx.runMutation(internal.ingest.claims.ingest, { claims })
    if (result.rejected.length > 0) {
      throw new ConvexError(
        result.rejected.map((item) => `${item.field}: ${item.reason}`).join("; "),
      )
    }
    const now = Date.now()
    const applied = [...new Set([...(request.outcome?.appliedFields ?? []), ...fields])]
    await ctx.db.patch("listingRequests", request._id, {
      status: "accepted",
      resolvedAt: now,
      outcome: { ...request.outcome, appliedFields: applied, acceptedAt: now },
    })
    return { appliedFields: fields }
  },
})

/**
 * Accepts a removal or objection as suppressions: the request's whole
 * listing (`organisation`), some of its `fields`, one contact `address` (kept
 * only as a hash), named `personKeys` from the broker tables, one or more
 * events by key (`eventKeys`), or a person's `name` wherever public text
 * gives it (kept only as a hash; two words or more). Events and names need
 * no listing. Each is enforced at once; the request is marked `accepted`
 * with what was created.
 */
export const acceptRemoval = mutation({
  args: {
    key: v.string(),
    scope: literalUnion(SUPPRESSION_SCOPES),
    fields: v.optional(v.array(v.string())),
    address: v.optional(v.string()),
    personKeys: v.optional(v.array(v.string())),
    eventKeys: v.optional(v.array(v.string())),
    name: v.optional(v.string()),
  },
  returns: v.object({ suppressionKeys: v.array(v.string()) }),
  handler: async (ctx, args) => {
    await requireBrokerUser(ctx)
    const request = await findRequest(ctx, args.key)
    if (request.kind !== "remove" && request.kind !== "object") {
      throw new ConvexError("Only a removal or an objection is accepted as a suppression")
    }
    const targets: SuppressionTarget[] = []
    if (args.scope === "event" || args.scope === "name") {
      const listing = request.orgKey
      if (args.scope === "event") {
        const keys = [...new Set((args.eventKeys ?? []).map((key) => key.trim()))]
        if (keys.length === 0) throw new ConvexError("Give the events' keys (evt-…)")
        for (const eventKey of keys) {
          if (!/^evt-[0-9a-f]{40}$/.test(eventKey)) {
            throw new ConvexError(`Not an event key: ${eventKey}`)
          }
          targets.push({ scope: "event", orgKey: listing, eventKey })
        }
      } else {
        const name = args.name?.trim() ?? ""
        const words = nameWords(name)
        if (words.length < 2 || words.length > MAX_NAME_WORDS) {
          throw new ConvexError(`Give the full name as published (2 to ${MAX_NAME_WORDS} words)`)
        }
        targets.push({ scope: "name", orgKey: listing, valueHash: nameHash(name) })
      }
      return await suppress(ctx, request, targets)
    }
    const orgKey = request.orgKey
    if (!orgKey) throw new ConvexError("The request names no listing")

    if (args.scope === "organisation") {
      targets.push({ scope: "organisation", orgKey })
    } else if (args.scope === "field") {
      const fields = [...new Set(args.fields ?? [])]
      if (fields.length === 0) throw new ConvexError("Choose the fields to remove")
      for (const field of fields) {
        if (!SUPPRESSIBLE_FIELDS.includes(field)) {
          throw new ConvexError(`${field} cannot be removed on its own`)
        }
        targets.push({ scope: "field", orgKey, field })
      }
    } else if (args.scope === "contact") {
      const address = args.address?.trim() ?? ""
      if (!isEmail(address)) throw new ConvexError("Give the address to remove")
      targets.push({ scope: "contact", orgKey, valueHash: contactHash(address) })
    } else {
      const keys = [...new Set(args.personKeys ?? [])]
      if (keys.length === 0) throw new ConvexError("Choose the people to remove")
      for (const personKey of keys) {
        const person = await ctx.db
          .query("people")
          .withIndex("by_key", (q) => q.eq("key", personKey))
          .unique()
        if (!person || person.orgKey !== orgKey) {
          throw new ConvexError("That person is not recorded for this listing")
        }
        targets.push({ scope: "person", orgKey, personKey })
      }
    }

    return await suppress(ctx, request, targets)
  },
})

/** Creates and enforces `targets` for `request` and marks it accepted. */
async function suppress(
  ctx: MutationCtx,
  request: Doc<"listingRequests">,
  targets: SuppressionTarget[],
): Promise<{ suppressionKeys: string[] }> {
  const created: string[] = []
  for (const target of targets) {
    const { key } = await createSuppression(ctx, target, {
      key: request.key,
      kind: request.kind,
    })
    created.push(key)
  }
  const now = Date.now()
  await ctx.db.patch("listingRequests", request._id, {
    status: "accepted",
    resolvedAt: now,
    outcome: {
      ...request.outcome,
      suppressionKeys: [...new Set([...(request.outcome?.suppressionKeys ?? []), ...created])],
      acceptedAt: now,
    },
  })
  return { suppressionKeys: created }
}
