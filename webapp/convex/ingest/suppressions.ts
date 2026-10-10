import { v } from "convex/values"
import type { EntityType } from "../../lib/vocab"
import { internal } from "../_generated/api"
import { internalMutation, internalQuery } from "../_generated/server"
import { dropSetAsideClaims, setAsidePatch } from "../lib/suppressionEffects"
import {
  carriesSuppressedAddress,
  carriesSuppressedName,
  MAX_SUPPRESSIONS,
} from "../lib/suppressions"
import { reresolveEntity } from "./claims"

/**
 * `POST /api/pipeline/suppressions` — the suppression list
 * (convex/lib/suppressions.ts) as the pipeline's `load` stage filters by it
 * before posting anything: listings, fields of listings, contact addresses
 * (sha256 of the trimmed, lower-cased address, never the address), broker
 * people keys, events and names (sha256 of the normalised name) removed on
 * request. Internal: reached only with the pipeline
 * key. Holds no personal data.
 */
export const list = internalQuery({
  args: {},
  returns: v.object({
    organisations: v.array(v.string()),
    fields: v.array(v.object({ orgKey: v.string(), field: v.string() })),
    contactHashes: v.array(v.string()),
    people: v.array(v.string()),
    events: v.array(v.string()),
    /** sha256 of each normalised name (lib/suppressions.ts `nameHash`). */
    nameHashes: v.array(v.string()),
    /** More rows than one read returns: the pipeline must not load. */
    truncated: v.boolean(),
  }),
  handler: async (ctx) => {
    const rows = await ctx.db.query("suppressions").take(MAX_SUPPRESSIONS + 1)
    const organisations = new Set<string>()
    const fields = new Map<string, { orgKey: string; field: string }>()
    const contactHashes = new Set<string>()
    const people = new Set<string>()
    const events = new Set<string>()
    const nameHashes = new Set<string>()
    for (const row of rows.slice(0, MAX_SUPPRESSIONS)) {
      if (row.scope === "event" && row.eventKey) events.add(row.eventKey)
      if (row.scope === "name" && row.valueHash) nameHashes.add(row.valueHash)
      if (row.scope === "organisation" && row.orgKey) organisations.add(row.orgKey)
      if (row.scope === "field" && row.orgKey && row.field) {
        fields.set(`${row.orgKey}\u0000${row.field}`, { orgKey: row.orgKey, field: row.field })
      }
      if (row.scope === "contact" && row.valueHash) contactHashes.add(row.valueHash)
      if (row.scope === "person" && row.personKey) people.add(row.personKey)
    }
    return {
      organisations: [...organisations].sort(),
      fields: [...fields.values()],
      contactHashes: [...contactHashes].sort(),
      people: [...people].sort(),
      events: [...events].sort(),
      nameHashes: [...nameHashes].sort(),
      truncated: rows.length > MAX_SUPPRESSIONS,
    }
  },
})

/** Claims read per walk call: a claim may hold two 20,000-character texts. */
const WALK_PAGE = 100

/**
 * The walk that accepting a contact or a name suppression schedules
 * (lib/suppressionEffects.ts): every live claim, of any listing, event or
 * session, whose value carries the address (or names the person) is set
 * aside — a page of the claim log at a time — and its entity re-resolved. A
 * suppression lifted meanwhile stops it.
 */
export const setAsideAddress = internalMutation({
  args: {
    key: v.string(),
    valueHash: v.string(),
    /** `contact` (an address) or `name` (a person who objected). */
    scope: v.optional(v.union(v.literal("contact"), v.literal("name"))),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.object({ processed: v.number(), setAside: v.number(), done: v.boolean() }),
  handler: async (ctx, args) => {
    const live = await ctx.db
      .query("suppressions")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique()
    if (!live) return { processed: 0, setAside: 0, done: true }
    const hashes = new Set([args.valueHash])
    const carries = (value: unknown) =>
      args.scope === "name"
        ? carriesSuppressedName(value, hashes)
        : carriesSuppressedAddress(value, hashes)
    const page = await ctx.db
      .query("fieldClaims")
      .paginate({ numItems: WALK_PAGE, cursor: args.cursor ?? null })
    const touched = new Map<
      string,
      { entityType: EntityType; entityKey: string; fields: Set<string> }
    >()
    let setAside = 0
    for (const claim of page.page) {
      if (claim.reviewStatus !== "accepted" && claim.reviewStatus !== "proposed") continue
      if (!carries(claim.value)) continue
      await ctx.db.patch("fieldClaims", claim._id, setAsidePatch(args.key))
      const id = `${claim.entityType}\u0000${claim.entityKey}`
      const entry = touched.get(id) ?? {
        entityType: claim.entityType,
        entityKey: claim.entityKey,
        fields: new Set<string>(),
      }
      entry.fields.add(claim.field)
      touched.set(id, entry)
      setAside++
    }
    for (const entry of touched.values()) {
      await reresolveEntity(ctx, entry.entityType, entry.entityKey, [...entry.fields])
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.ingest.suppressions.setAsideAddress, {
        key: args.key,
        valueHash: args.valueHash,
        scope: args.scope,
        cursor: page.continueCursor,
      })
    }
    return { processed: page.page.length, setAside, done: page.isDone }
  },
})

/** The rest of a lifted suppression's set-aside claims (lib/suppressionEffects.ts). */
export const dropSetAside = internalMutation({
  args: { key: v.string() },
  returns: v.object({ done: v.boolean() }),
  handler: async (ctx, args) => ({ done: await dropSetAsideClaims(ctx, args.key) }),
})
