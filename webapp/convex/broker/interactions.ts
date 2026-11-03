import { v } from "convex/values"
import { SEND_LOG_BATCH, sentOnProblem } from "../../lib/broker/outreach"
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
 * its date is cleared (`completeFollowUp`). `recordSendLog` imports the Art
 * 14 outreach's send log as interactions (lib/broker/outreach.ts).
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

/** The interaction a sent notice becomes. Its key depends only on the
 * organisation, address and date, so importing a log twice records it once. */
function sendLogInteraction(entry: {
  orgKey: string
  email: string
  sentOn: string
  bounced: boolean
}) {
  const sent = `Art 14 notice (outreach) sent to ${entry.email} on ${entry.sentOn}`
  return {
    key: `int-art14-${sha1Hex(`${entry.orgKey}:${entry.email}:${entry.sentOn}`).slice(0, 20)}`,
    summary: entry.bounced ? `${sent}; it bounced.` : `${sent}.`,
    nextStep: entry.bounced
      ? "Send the notice to the next role address, or find another route."
      : undefined,
    followUpOn: entry.bounced ? entry.sentOn : undefined,
  }
}

/**
 * Records the outreach send log (Art 5(2) evidence of who was told, and
 * when): one email interaction per organisation and address sent to. Done
 * again with the same rows it changes nothing, except that a send now marked
 * bounced gains the bounce and a follow-up; a bounce is never taken back,
 * and an interaction the broker has since edited is left as it is. A date
 * before `OUTREACH_FROM` or after today (Europe/London) is refused.
 * Unknown organisations are skipped and returned; `offListing` returns the
 * organisations whose address is not one their listing publishes (recorded
 * all the same: the log says what was sent).
 */
export const recordSendLog = mutation({
  args: {
    entries: v.array(
      v.object({
        orgKey: v.string(),
        email: v.string(),
        sentOn: v.string(),
        bounced: v.boolean(),
      }),
    ),
  },
  returns: v.object({
    recorded: v.number(),
    bounced: v.number(),
    unchanged: v.number(),
    unknownOrgs: v.array(v.string()),
    offListing: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    await requireBrokerUser(ctx)
    if (args.entries.length > SEND_LOG_BATCH) {
      throw new Error(`Send at most ${SEND_LOG_BATCH} rows at a time`)
    }
    const result = {
      recorded: 0,
      bounced: 0,
      unchanged: 0,
      unknownOrgs: [] as string[],
      offListing: [] as string[],
    }
    const now = Date.now()
    const today = londonIsoDate(now)
    for (const raw of args.entries) {
      const entry = { ...raw, email: raw.email.trim().toLowerCase() }
      checkIsoDate(entry.sentOn, "sent date")
      const outside = sentOnProblem(entry.sentOn, today)
      if (outside) throw new Error(`The sent date ${outside}`)
      if (entry.email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(entry.email)) {
        throw new Error(`"${entry.email.slice(0, 80)}" is not an address`)
      }
      const org = await findOrganisation(ctx, entry.orgKey)
      if (!org) {
        result.unknownOrgs.push(entry.orgKey)
        continue
      }
      const published = [org.email, ...org.roleEmails.map((item) => item.email)]
      if (!published.some((email) => email?.trim().toLowerCase() === entry.email)) {
        result.offListing.push(entry.orgKey)
      }
      const row = sendLogInteraction(entry)
      const existing = await ctx.db
        .query("interactions")
        .withIndex("by_key", (q) => q.eq("key", row.key))
        .unique()
      if (!existing) {
        await ctx.db.insert("interactions", {
          ...row,
          date: Date.parse(`${entry.sentOn}T12:00:00Z`),
          orgKey: entry.orgKey,
          channel: "email",
          createdAt: now,
          updatedAt: now,
        })
        result.recorded++
      } else if (
        entry.bounced &&
        existing.summary === sendLogInteraction({ ...entry, bounced: false }).summary
      ) {
        // Only the untouched "sent" record gains the bounce: one the broker
        // has edited (a reply, a new address) or that already bounced stays.
        await ctx.db.patch("interactions", existing._id, {
          summary: row.summary,
          nextStep: row.nextStep,
          followUpOn: row.followUpOn,
          updatedAt: now,
        })
      } else {
        result.unchanged++
        continue
      }
      if (entry.bounced) result.bounced++
    }
    return result
  },
})
