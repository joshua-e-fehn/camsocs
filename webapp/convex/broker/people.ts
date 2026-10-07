import { v } from "convex/values"
import { personKey } from "../../lib/keys"
import { CONSENT_BASES } from "../../lib/vocab"
import { mutation, query } from "../_generated/server"
import { requireBrokerUser } from "../lib/auth"
import { brokerOrgRefs, checkIsoDate, cleanText, orgRefValidator } from "../lib/brokerRows"
import { academicYearOf, londonIsoDate, nextHandoverDate } from "../lib/derived"
import { findOrganisation } from "../lib/entityStore"
import { isHttpUrl, isOrgKey } from "../lib/fields"
import { withoutSystemFields } from "../lib/ingest"
import { literalUnion } from "../lib/validators"
import { personFields } from "../schema"

/**
 * Named committee members — private, from public sources or the broker's own
 * dealings, and stale after each handover (data-model §4). Never shown
 * outside /dashboard; no public query reads this table.
 *
 * A row the pipeline wrote (`method: parser | llm`) becomes the broker's
 * (`manual`) as soon as it is edited here, so the next harvest cannot undo
 * the edit (convex/ingest/broker.ts leaves manual rows alone).
 *
 * ⚠ Every function here calls `requireBrokerUser` first.
 */

const MAX_PEOPLE = 5_000
const LIMITS = { name: 200, role: 120, notes: 5_000, links: 10 }
/** Where a manually entered person's details came from: the broker. */
export const MANUAL_SOURCE = "manual:broker"

const publicLink = v.object({ platform: v.string(), url: v.string() })

export const list = query({
  args: {},
  returns: v.array(
    v.object({ ...personFields, org: v.union(v.null(), orgRefValidator), staleNow: v.boolean() }),
  ),
  handler: async (ctx) => {
    await requireBrokerUser(ctx)
    const today = londonIsoDate(Date.now())
    const rows = await ctx.db.query("people").take(MAX_PEOPLE)
    const refs = brokerOrgRefs(ctx)
    const out = []
    for (const person of rows) {
      out.push({
        ...withoutSystemFields<"people">(person),
        org: await refs(person.orgKey),
        // The daily cron sets `stale`; between runs the date decides.
        staleNow: person.stale || person.staleAfter < today,
      })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, "en"))
  },
})

function checkLinks(links: { platform: string; url: string }[]) {
  if (links.length > LIMITS.links) throw new Error(`At most ${LIMITS.links} links`)
  for (const link of links) {
    if (!isHttpUrl(link.url)) throw new Error(`Not an http(s) URL: ${link.url.slice(0, 100)}`)
  }
  return links.map((link) => ({ platform: link.platform.trim().slice(0, 40), url: link.url }))
}

function requireText(value: string, max: number, what: string): string {
  const text = cleanText(value, max, what)
  if (!text) throw new Error(`The ${what} is required`)
  return text
}

export const create = mutation({
  args: {
    orgKey: v.string(),
    name: v.string(),
    role: v.string(),
    academicYear: v.optional(v.string()),
    startDate: v.optional(v.string()),
    staleAfter: v.optional(v.string()),
    sourceUrl: v.optional(v.string()),
    consentBasis: v.optional(literalUnion(CONSENT_BASES)),
    publicLinks: v.optional(v.array(publicLink)),
    notes: v.optional(v.string()),
  },
  returns: v.object({ key: v.string() }),
  handler: async (ctx, args) => {
    await requireBrokerUser(ctx)
    if (!isOrgKey(args.orgKey) || !(await findOrganisation(ctx, args.orgKey))) {
      throw new Error("Pick the organisation this person belongs to")
    }
    const name = requireText(args.name, LIMITS.name, "name")
    const key = personKey(args.orgKey, name)
    const clash = await ctx.db
      .query("people")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique()
    if (clash) throw new Error(`${clash.name} is already listed at this organisation`)
    if (args.sourceUrl && !isHttpUrl(args.sourceUrl)) throw new Error("The source is not a URL")
    const now = Date.now()
    const staleAfter = args.staleAfter
      ? checkIsoDate(args.staleAfter, "stale-after date")
      : nextHandoverDate(now)
    await ctx.db.insert("people", {
      key,
      name,
      orgKey: args.orgKey,
      role: requireText(args.role, LIMITS.role, "role"),
      academicYear: cleanText(args.academicYear, 10, "academic year") ?? academicYearOf(now),
      startDate: args.startDate ? checkIsoDate(args.startDate, "start date") : undefined,
      staleAfter,
      stale: staleAfter < londonIsoDate(now),
      sourceUrl: args.sourceUrl ?? MANUAL_SOURCE,
      seenAt: now,
      publicLinks: checkLinks(args.publicLinks ?? []),
      consentBasis: args.consentBasis ?? "legitimate_interest",
      method: "manual",
      notes: cleanText(args.notes, LIMITS.notes, "note"),
      archived: false,
      createdAt: now,
      updatedAt: now,
    })
    return { key }
  },
})

/** Edits a person; only the fields passed change (`""` clears a note). */
export const update = mutation({
  args: {
    key: v.string(),
    orgKey: v.optional(v.string()),
    name: v.optional(v.string()),
    role: v.optional(v.string()),
    academicYear: v.optional(v.string()),
    startDate: v.optional(v.string()),
    staleAfter: v.optional(v.string()),
    consentBasis: v.optional(literalUnion(CONSENT_BASES)),
    publicLinks: v.optional(v.array(publicLink)),
    notes: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireBrokerUser(ctx)
    const person = await ctx.db
      .query("people")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique()
    if (!person) throw new Error("That person was not found")
    const now = Date.now()
    const patch: Partial<typeof person> = { method: "manual", updatedAt: now }
    if (args.orgKey !== undefined) {
      if (!isOrgKey(args.orgKey) || !(await findOrganisation(ctx, args.orgKey))) {
        throw new Error("That organisation was not found")
      }
      patch.orgKey = args.orgKey
    }
    if (args.name !== undefined) patch.name = requireText(args.name, LIMITS.name, "name")
    if (args.role !== undefined) patch.role = requireText(args.role, LIMITS.role, "role")
    if (args.academicYear !== undefined) {
      patch.academicYear = requireText(args.academicYear, 10, "academic year")
    }
    if (args.startDate !== undefined) {
      patch.startDate = args.startDate ? checkIsoDate(args.startDate, "start date") : undefined
    }
    if (args.staleAfter !== undefined) {
      patch.staleAfter = checkIsoDate(args.staleAfter, "stale-after date")
      patch.stale = patch.staleAfter < londonIsoDate(now)
    }
    if (args.consentBasis !== undefined) patch.consentBasis = args.consentBasis
    if (args.publicLinks !== undefined) patch.publicLinks = checkLinks(args.publicLinks)
    if (args.notes !== undefined) patch.notes = cleanText(args.notes, LIMITS.notes, "note")
    await ctx.db.patch("people", person._id, patch)
    return null
  },
})

/** Archives (or restores) a person: kept for the record, out of the lists. */
export const setArchived = mutation({
  args: { key: v.string(), archived: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireBrokerUser(ctx)
    const person = await ctx.db
      .query("people")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique()
    if (!person) throw new Error("That person was not found")
    await ctx.db.patch("people", person._id, {
      archived: args.archived,
      method: "manual",
      updatedAt: Date.now(),
    })
    return null
  },
})
