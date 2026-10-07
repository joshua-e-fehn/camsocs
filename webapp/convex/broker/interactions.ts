import { v } from "convex/values"
import { sha1Hex } from "../../lib/hash"
import { INTERACTION_CHANNELS } from "../../lib/vocab"
import type { Doc } from "../_generated/dataModel"
import { type MutationCtx, mutation, type QueryCtx, query } from "../_generated/server"
import { requireBrokerUser } from "../lib/auth"
import {
  brokerOrgRefs,
  checkIsoDate,
  cleanText,
  orgRefValidator,
  personRefs,
} from "../lib/brokerRows"
import { DAY_MS, londonIsoDate } from "../lib/derived"
import { findOrganisation } from "../lib/entityStore"
import { withoutSystemFields } from "../lib/ingest"
import { literalUnion } from "../lib/validators"
import { interactionFields } from "../schema"

/**
 * The interaction log (data-model §4): who the broker spoke to, how, what
 * was said, the next step and when to follow up. A follow-up is "done" when
 * its date is cleared (`completeFollowUp`).
 *
 * ⚠ Every function here calls `requireBrokerUser` first.
 */

const RECENT = 300
const LIMITS = { summary: 5_000, nextStep: 1_000 }

const personRef = v.object({ key: v.string(), name: v.string(), role: v.string() })
const interactionRow = v.object({
  ...interactionFields,
  org: v.union(v.null(), orgRefValidator),
  person: v.union(v.null(), personRef),
})

async function withRefs(ctx: QueryCtx, rows: Doc<"interactions">[]) {
  const orgs = brokerOrgRefs(ctx)
  const people = personRefs(ctx)
  const out = []
  for (const row of rows) {
    out.push({
      ...withoutSystemFields<"interactions">(row),
      org: row.orgKey ? await orgs(row.orgKey) : null,
      person: row.personKey ? await people(row.personKey) : null,
    })
  }
  return out
}

/** The latest interactions (by date), or one organisation's. */
export const list = query({
  args: { orgKey: v.optional(v.string()) },
  returns: v.array(interactionRow),
  handler: async (ctx, args) => {
    await requireBrokerUser(ctx)
    const orgKey = args.orgKey
    const rows = orgKey
      ? await ctx.db
          .query("interactions")
          .withIndex("by_orgKey_date", (q) => q.eq("orgKey", orgKey))
          .order("desc")
          .take(RECENT)
      : (await ctx.db.query("interactions").order("desc").take(RECENT)).sort(
          (a, b) => b.date - a.date,
        )
    return await withRefs(ctx, rows)
  },
})

/** Open follow-ups due within `days` (default 7) — overdue ones included. */
export const followUps = query({
  args: { days: v.optional(v.number()) },
  returns: v.array(interactionRow),
  handler: async (ctx, args) => {
    await requireBrokerUser(ctx)
    const horizon = londonIsoDate(Date.now() + Math.max(0, Math.min(90, args.days ?? 7)) * DAY_MS)
    const rows = await ctx.db
      .query("interactions")
      .withIndex("by_followUpOn", (q) => q.gt("followUpOn", "").lte("followUpOn", horizon))
      .take(RECENT)
    return await withRefs(ctx, rows)
  },
})

async function checkParties(ctx: MutationCtx, orgKey?: string, personKey?: string) {
  if (!orgKey && !personKey) throw new Error("Pick an organisation or a person")
  if (orgKey && !(await findOrganisation(ctx, orgKey))) {
    throw new Error("That organisation was not found")
  }
  if (personKey) {
    const person = await ctx.db
      .query("people")
      .withIndex("by_key", (q) => q.eq("key", personKey))
      .unique()
    if (!person) throw new Error("That person was not found")
  }
}

const fields = {
  date: v.number(),
  orgKey: v.optional(v.string()),
  personKey: v.optional(v.string()),
  channel: literalUnion(INTERACTION_CHANNELS),
  summary: v.string(),
  nextStep: v.optional(v.string()),
  followUpOn: v.optional(v.string()),
}

export const create = mutation({
  args: fields,
  returns: v.object({ key: v.string() }),
  handler: async (ctx, args) => {
    await requireBrokerUser(ctx)
    await checkParties(ctx, args.orgKey, args.personKey)
    const summary = cleanText(args.summary, LIMITS.summary, "summary")
    if (!summary) throw new Error("Say what happened")
    const now = Date.now()
    const key = `int-${sha1Hex(`${now}:${args.orgKey ?? ""}:${args.personKey ?? ""}:${summary}`).slice(0, 20)}`
    await ctx.db.insert("interactions", {
      key,
      date: args.date,
      orgKey: args.orgKey,
      personKey: args.personKey,
      channel: args.channel,
      summary,
      nextStep: cleanText(args.nextStep, LIMITS.nextStep, "next step"),
      followUpOn: args.followUpOn ? checkIsoDate(args.followUpOn, "follow-up date") : undefined,
      createdAt: now,
      updatedAt: now,
    })
    return { key }
  },
})

async function findInteraction(ctx: MutationCtx, key: string) {
  const row = await ctx.db
    .query("interactions")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique()
  if (!row) throw new Error("That interaction was not found")
  return row
}

/** Replaces an interaction's fields (`followUpOn: ""` clears the follow-up). */
export const update = mutation({
  args: { key: v.string(), ...fields },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireBrokerUser(ctx)
    const row = await findInteraction(ctx, args.key)
    await checkParties(ctx, args.orgKey, args.personKey)
    const summary = cleanText(args.summary, LIMITS.summary, "summary")
    if (!summary) throw new Error("Say what happened")
    await ctx.db.patch("interactions", row._id, {
      date: args.date,
      orgKey: args.orgKey,
      personKey: args.personKey,
      channel: args.channel,
      summary,
      nextStep: cleanText(args.nextStep, LIMITS.nextStep, "next step"),
      followUpOn: args.followUpOn ? checkIsoDate(args.followUpOn, "follow-up date") : undefined,
      updatedAt: Date.now(),
    })
    return null
  },
})

/** Marks the follow-up done: clears its date, keeps the interaction. */
export const completeFollowUp = mutation({
  args: { key: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireBrokerUser(ctx)
    const row = await findInteraction(ctx, args.key)
    await ctx.db.patch("interactions", row._id, { followUpOn: undefined, updatedAt: Date.now() })
    return null
  },
})

export const remove = mutation({
  args: { key: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireBrokerUser(ctx)
    const row = await findInteraction(ctx, args.key)
    await ctx.db.delete("interactions", row._id)
    return null
  },
})
