import { v } from "convex/values"
import { sha1Hex } from "../../lib/hash"
import { INTRODUCTION_STATUSES } from "../../lib/vocab"
import { type MutationCtx, mutation, query } from "../_generated/server"
import { requireBrokerUser } from "../lib/auth"
import { brokerOrgRefs, cleanText, orgRefValidator, personRefs } from "../lib/brokerRows"
import { findOrganisation } from "../lib/entityStore"
import { withoutSystemFields } from "../lib/ingest"
import { literalUnion } from "../lib/validators"
import { introductionFields } from "../schema"

/**
 * Introductions (data-model §4): party A ↔ party B — each an organisation or
 * a person — with the reason, a status on the board
 * (idea → proposed → sent → accepted → met, or declined / stale) and the
 * outcome.
 *
 * ⚠ Every function here calls `requireBrokerUser` first.
 */

const MAX = 1_000
const LIMITS = { reason: 2_000, outcome: 5_000 }

const party = v.object({ orgKey: v.optional(v.string()), personKey: v.optional(v.string()) })
const partyRef = v.object({
  org: v.union(v.null(), orgRefValidator),
  person: v.union(v.null(), v.object({ key: v.string(), name: v.string(), role: v.string() })),
})

export const list = query({
  args: {},
  returns: v.array(v.object({ ...introductionFields, a: partyRef, b: partyRef })),
  handler: async (ctx) => {
    await requireBrokerUser(ctx)
    const rows = await ctx.db.query("introductions").order("desc").take(MAX)
    const orgs = brokerOrgRefs(ctx)
    const people = personRefs(ctx)
    const resolve = async (p: { orgKey?: string; personKey?: string }) => ({
      org: p.orgKey ? await orgs(p.orgKey) : null,
      person: p.personKey ? await people(p.personKey) : null,
    })
    const out = []
    for (const row of rows) {
      out.push({
        ...withoutSystemFields<"introductions">(row),
        a: await resolve(row.partyA),
        b: await resolve(row.partyB),
      })
    }
    return out.sort((x, y) => y.date - x.date)
  },
})

/** Exactly one of `orgKey` / `personKey`, and it must exist. */
async function checkParty(ctx: MutationCtx, p: { orgKey?: string; personKey?: string }) {
  if (Boolean(p.orgKey) === Boolean(p.personKey)) {
    throw new Error("Each side is one organisation or one person")
  }
  if (p.orgKey && !(await findOrganisation(ctx, p.orgKey))) {
    throw new Error("That organisation was not found")
  }
  if (p.personKey) {
    const key = p.personKey
    const person = await ctx.db
      .query("people")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique()
    if (!person) throw new Error("That person was not found")
  }
  return { orgKey: p.orgKey || undefined, personKey: p.personKey || undefined }
}

const sameParty = (
  a: { orgKey?: string; personKey?: string },
  b: { orgKey?: string; personKey?: string },
) => a.orgKey === b.orgKey && a.personKey === b.personKey

export const create = mutation({
  args: {
    partyA: party,
    partyB: party,
    reason: v.string(),
    status: v.optional(literalUnion(INTRODUCTION_STATUSES)),
  },
  returns: v.object({ key: v.string() }),
  handler: async (ctx, args) => {
    await requireBrokerUser(ctx)
    const partyA = await checkParty(ctx, args.partyA)
    const partyB = await checkParty(ctx, args.partyB)
    if (sameParty(partyA, partyB)) throw new Error("Pick two different parties")
    const reason = cleanText(args.reason, LIMITS.reason, "reason")
    if (!reason) throw new Error("Say why they should meet")
    const now = Date.now()
    const ids = [partyA, partyB].map((p) => p.orgKey ?? p.personKey).join(":")
    const key = `intro-${sha1Hex(`${now}:${ids}:${reason}`).slice(0, 20)}`
    await ctx.db.insert("introductions", {
      key,
      partyA,
      partyB,
      reason,
      date: now,
      status: args.status ?? "idea",
      createdAt: now,
      updatedAt: now,
    })
    return { key }
  },
})

/** Moves an introduction on the board or edits it; only the fields passed change. */
export const update = mutation({
  args: {
    key: v.string(),
    status: v.optional(literalUnion(INTRODUCTION_STATUSES)),
    reason: v.optional(v.string()),
    outcome: v.optional(v.string()),
    partyA: v.optional(party),
    partyB: v.optional(party),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireBrokerUser(ctx)
    const row = await ctx.db
      .query("introductions")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique()
    if (!row) throw new Error("That introduction was not found")
    const patch: Partial<typeof row> = { updatedAt: Date.now() }
    if (args.status !== undefined && args.status !== row.status) {
      patch.status = args.status
      // `date` is when it last moved, so the board shows how long it has sat.
      patch.date = Date.now()
    }
    if (args.reason !== undefined) {
      const reason = cleanText(args.reason, LIMITS.reason, "reason")
      if (!reason) throw new Error("Say why they should meet")
      patch.reason = reason
    }
    if (args.outcome !== undefined)
      patch.outcome = cleanText(args.outcome, LIMITS.outcome, "outcome")
    if (args.partyA !== undefined) patch.partyA = await checkParty(ctx, args.partyA)
    if (args.partyB !== undefined) patch.partyB = await checkParty(ctx, args.partyB)
    if (sameParty(patch.partyA ?? row.partyA, patch.partyB ?? row.partyB)) {
      throw new Error("Pick two different parties")
    }
    await ctx.db.patch("introductions", row._id, patch)
    return null
  },
})

export const remove = mutation({
  args: { key: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireBrokerUser(ctx)
    const row = await ctx.db
      .query("introductions")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique()
    if (!row) throw new Error("That introduction was not found")
    await ctx.db.delete("introductions", row._id)
    return null
  },
})
