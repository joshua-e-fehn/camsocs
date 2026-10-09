import {
  paginationOptsValidator,
  paginationResultValidator,
  type WithoutSystemFields,
} from "convex/server"
import { ConvexError, v } from "convex/values"
import {
  INTERACTION_CHANNELS,
  NEED_OFFER_ITEMS,
  PECR_SUBSCRIBER_TYPES,
  RELATIONSHIP_TYPES,
  RELATIONSHIP_VISIBILITIES,
} from "../../lib/vocab"
import type { Doc } from "../_generated/dataModel"
import { mutation, query } from "../_generated/server"
import { emptyProfile } from "../ingest/broker"
import { requireBrokerUser } from "../lib/auth"
import {
  brokerOrgRefs,
  brokerOrgRow,
  brokerOrgRowValidator,
  cleanText,
  orgRefValidator,
  profileOf,
} from "../lib/brokerRows"
import { findOrganisation, writeOrgCard } from "../lib/entityStore"
import { withoutSystemFields } from "../lib/ingest"
import { literalUnion } from "../lib/validators"
import {
  organisationFields,
  orgBrokerProfileFields,
  orgInternalFields,
  personFields,
  storedRelationshipEvidenceValidator,
} from "../schema"

/**
 * Organisations, as the broker sees them: every field with its provenance,
 * internal feeds, the broker profile (needs / offers, opt-ins, PECR type,
 * suppression, ethics flags, notes), people, relationships, interactions —
 * and the switch that hides a listing from the public site.
 *
 * ⚠ Every function here calls `requireBrokerUser` first
 * (convex/broker/gating.test.ts enumerates them).
 */

/** Organisation rows per page; the dashboard loads every page. */
export const MAX_PAGE = 250

/**
 * Every organisation (counterparts and hidden ones too), as slim rows for the
 * table, the coverage overview and the outreach export. Paginated because the
 * full rows (descriptions, per-field meta) are ~10 KB each.
 */
export const page = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(brokerOrgRowValidator),
  handler: async (ctx, args) => {
    await requireBrokerUser(ctx)
    const numItems = Math.max(1, Math.min(MAX_PAGE, Math.floor(args.paginationOpts.numItems)))
    const result = await ctx.db
      .query("organisations")
      .withIndex("by_key")
      .paginate({ ...args.paginationOpts, numItems })
    const page = []
    for (const org of result.page) page.push(brokerOrgRow(org, await profileOf(ctx, org.key)))
    return { ...result, page }
  },
})

/** Organisations whose name matches `q`, for the party pickers (any kind). */
export const search = query({
  args: { q: v.string() },
  returns: v.array(orgRefValidator),
  handler: async (ctx, args) => {
    await requireBrokerUser(ctx)
    const text = args.q.trim().slice(0, 100)
    if (text === "") return []
    const rows = await ctx.db
      .query("organisations")
      .withSearchIndex("search_text", (s) => s.search("searchText", text))
      .take(15)
    return rows.map((org) => ({
      key: org.key,
      slug: org.slug,
      name: org.name,
      isCounterpart: org.isCounterpart,
      hidden: org.hidden === true,
    }))
  },
})

const relationshipRow = v.object({
  key: v.string(),
  type: literalUnion(RELATIONSHIP_TYPES),
  direction: v.union(v.literal("outgoing"), v.literal("incoming")),
  counterpart: v.union(orgRefValidator, v.object({ key: v.string() })),
  visibility: literalUnion(RELATIONSHIP_VISIBILITIES),
  confidence: v.number(),
  firstSeenAt: v.number(),
  lastSeenAt: v.number(),
  evidence: v.array(storedRelationshipEvidenceValidator),
})

const interactionRow = v.object({
  key: v.string(),
  date: v.number(),
  channel: literalUnion(INTERACTION_CHANNELS),
  summary: v.string(),
  nextStep: v.optional(v.string()),
  followUpOn: v.optional(v.string()),
  personKey: v.optional(v.string()),
})

/** Everything about one organisation, for the detail drawer. */
export const detail = query({
  args: { key: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      org: v.object(organisationFields),
      logoUrl: v.optional(v.string()),
      internal: v.union(v.null(), v.object(orgInternalFields)),
      profile: v.union(v.null(), v.object(orgBrokerProfileFields)),
      people: v.array(v.object(personFields)),
      relationships: v.array(relationshipRow),
      interactions: v.array(interactionRow),
    }),
  ),
  handler: async (ctx, args) => {
    await requireBrokerUser(ctx)
    const org = await findOrganisation(ctx, args.key)
    if (!org) return null
    const [internal, profile, people, outgoing, incoming, interactions] = await Promise.all([
      ctx.db
        .query("orgInternal")
        .withIndex("by_orgKey", (q) => q.eq("orgKey", org.key))
        .unique(),
      profileOf(ctx, org.key),
      ctx.db
        .query("people")
        .withIndex("by_orgKey", (q) => q.eq("orgKey", org.key))
        .take(200),
      ctx.db
        .query("relationships")
        .withIndex("by_from", (q) => q.eq("fromKey", org.key))
        .take(200),
      ctx.db
        .query("relationships")
        .withIndex("by_to", (q) => q.eq("toKey", org.key))
        .take(200),
      ctx.db
        .query("interactions")
        .withIndex("by_orgKey_date", (q) => q.eq("orgKey", org.key))
        .order("desc")
        .take(100),
    ])
    const refs = brokerOrgRefs(ctx)
    const relationships = []
    for (const [edges, direction] of [
      [outgoing, "outgoing"],
      [incoming, "incoming"],
    ] as const) {
      for (const edge of edges) {
        const otherKey = direction === "outgoing" ? edge.toKey : edge.fromKey
        relationships.push({
          key: edge.key,
          type: edge.type,
          direction,
          counterpart: (await refs(otherKey)) ?? { key: otherKey },
          visibility: edge.visibility,
          confidence: edge.confidence,
          firstSeenAt: edge.firstSeenAt,
          lastSeenAt: edge.lastSeenAt,
          evidence: edge.evidence,
        })
      }
    }
    const logoUrl = org.logo?.storageId
      ? ((await ctx.storage.getUrl(org.logo.storageId)) ?? undefined)
      : undefined
    return {
      org: withoutSystemFields<"organisations">(org),
      logoUrl,
      internal: internal ? withoutSystemFields<"orgInternal">(internal) : null,
      profile: profile ? withoutSystemFields<"orgBrokerProfiles">(profile) : null,
      people: people
        .map((person) => withoutSystemFields<"people">(person))
        .sort((a, b) => Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name)),
      relationships: relationships.sort((a, b) => b.lastSeenAt - a.lastSeenAt),
      interactions: interactions.map((row) => ({
        key: row.key,
        date: row.date,
        channel: row.channel,
        summary: row.summary,
        nextStep: row.nextStep,
        followUpOn: row.followUpOn,
        personKey: row.personKey,
      })),
    }
  },
})

const LIMITS = { notes: 10_000, flag: 60, flags: 20 }

type ProfileFields = WithoutSystemFields<Doc<"orgBrokerProfiles">>

/** `null` clears a tri-state opt-in back to "unknown". */
const optIn = v.optional(v.union(v.boolean(), v.null()))

/**
 * Edits the broker profile, creating it on first use. Only the fields passed
 * change; `""` clears a note.
 */
export const updateProfile = mutation({
  args: {
    orgKey: v.string(),
    optIns: v.optional(
      v.object({ openToSponsors: optIn, openToCollaborations: optIn, careersEvents: optIn }),
    ),
    pecrSubscriberType: v.optional(literalUnion(PECR_SUBSCRIBER_TYPES)),
    suppressed: v.optional(v.boolean()),
    ethicsFlags: v.optional(v.array(v.string())),
    notes: v.optional(v.string()),
    sponsorNotes: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireBrokerUser(ctx)
    const org = await findOrganisation(ctx, args.orgKey)
    if (!org) throw new Error("That organisation was not found")
    const now = Date.now()
    const existing = await profileOf(ctx, org.key)
    const base: ProfileFields = existing ?? {
      ...emptyProfile(org.key),
      createdAt: now,
      updatedAt: now,
    }

    const patch: Partial<ProfileFields> = {}
    if (args.optIns) {
      const optIns = { ...base.optIns }
      for (const [name, value] of Object.entries(args.optIns) as [
        keyof typeof optIns,
        boolean | null | undefined,
      ][]) {
        if (value === undefined) continue
        optIns[name] = value === null ? undefined : value
      }
      patch.optIns = optIns
    }
    if (args.pecrSubscriberType) patch.pecrSubscriberType = args.pecrSubscriberType
    if (args.suppressed !== undefined) patch.suppressed = args.suppressed
    if (args.ethicsFlags) {
      const flags = [...new Set(args.ethicsFlags.map((flag) => flag.trim()).filter(Boolean))]
      if (flags.length > LIMITS.flags) throw new Error(`At most ${LIMITS.flags} ethics flags`)
      if (flags.some((flag) => flag.length > LIMITS.flag)) {
        throw new Error(`An ethics flag is at most ${LIMITS.flag} characters`)
      }
      patch.ethicsFlags = flags
    }
    if (args.notes !== undefined) patch.notes = cleanText(args.notes, LIMITS.notes, "note")
    if (args.sponsorNotes !== undefined) {
      patch.sponsorNotes = cleanText(args.sponsorNotes, LIMITS.notes, "sponsor note")
    }

    if (existing)
      await ctx.db.patch("orgBrokerProfiles", existing._id, { ...patch, updatedAt: now })
    else await ctx.db.insert("orgBrokerProfiles", { ...base, ...patch })
    return null
  },
})

/**
 * The broker's verdict on one need or offer: `confirmed` (also adds an item
 * the pipeline never inferred), `rejected` (a tombstone: hidden, and the
 * pipeline will not infer it again), or `null` to forget the item entirely
 * (so it may be inferred again).
 */
export const setNeedOffer = mutation({
  args: {
    orgKey: v.string(),
    kind: v.union(v.literal("needs"), v.literal("offers")),
    item: literalUnion(NEED_OFFER_ITEMS),
    status: v.union(v.literal("confirmed"), v.literal("rejected"), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireBrokerUser(ctx)
    const org = await findOrganisation(ctx, args.orgKey)
    if (!org) throw new Error("That organisation was not found")
    const now = Date.now()
    const existing = await profileOf(ctx, org.key)
    const base: ProfileFields = existing ?? {
      ...emptyProfile(org.key),
      createdAt: now,
      updatedAt: now,
    }
    const entries = base[args.kind]
    const current = entries.find((entry) => entry.item === args.item)
    const rest = entries.filter((entry) => entry.item !== args.item)
    const next =
      args.status === null
        ? rest
        : [
            ...rest,
            {
              item: args.item,
              status: args.status,
              evidenceQuote: current?.evidenceQuote,
              sourceUrl: current?.sourceUrl,
              method: current?.method ?? ("manual" as const),
              updatedAt: now,
            },
          ]
    if (existing) {
      await ctx.db.patch("orgBrokerProfiles", existing._id, { [args.kind]: next, updatedAt: now })
    } else {
      await ctx.db.insert("orgBrokerProfiles", { ...base, [args.kind]: next })
    }
    return null
  },
})

/**
 * Hides a listing from the public site (a "remove" or "object" request), or
 * shows it again — refused while the listing is on the suppression list
 * (`broker.listingRequests.acceptRemoval`; lift it first, `broker.suppressions.lift`). The row and its claims stay — the pipeline keeps it current
 * and the broker still sees it — but it loses its directory card, so no public
 * query lists, names or links it, and `orgs.getBySlug` answers null.
 */
export const setHidden = mutation({
  args: { orgKey: v.string(), hidden: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireBrokerUser(ctx)
    const org = await findOrganisation(ctx, args.orgKey)
    if (!org) throw new Error("That organisation was not found")
    if ((org.hidden === true) === args.hidden) return null
    if (!args.hidden) {
      const suppressed = await ctx.db
        .query("suppressions")
        .withIndex("by_orgKey", (q) => q.eq("orgKey", org.key))
        .take(50)
      if (suppressed.some((row) => row.scope === "organisation")) {
        throw new ConvexError(
          "This listing was removed on request: lift its suppression before showing it again",
        )
      }
    }
    await ctx.db.patch("organisations", org._id, {
      hidden: args.hidden ? true : undefined,
      updatedAt: Date.now(),
    })
    const updated = await ctx.db.get("organisations", org._id)
    if (updated) await writeOrgCard(ctx, updated)
    return null
  },
})
