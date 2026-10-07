import { type Infer, v } from "convex/values"
import {
  CATEGORIES,
  INTERNAL_SOURCE_TYPES,
  NEED_OFFER_ITEMS,
  NEED_OFFER_STATUSES,
  ORG_LEVELS,
  ORG_STATUSES,
  ORG_TYPES,
  ROLES,
} from "../../lib/vocab"
import type { Doc } from "../_generated/dataModel"
import type { QueryCtx } from "../_generated/server"
import { classifyEmail } from "./derived"
import { hostOf, isHttpUrl } from "./fields"
import type { FieldMeta } from "./resolve"
import { literalUnion } from "./validators"

/**
 * Read models for the private broker area (convex/broker/*). Only those
 * functions use these — every one behind `requireBrokerUser` — so they may
 * carry what the public projection drops (internal sources, hidden rows),
 * with one exception kept even here: a personal CRSid address is never an
 * outreach address.
 */

/** Statuses that mean "we hold a value". */
const HELD = new Set(["found", "inferred", "owner_confirmed", "manual", "conflicting"])

/** Role addresses in the order the outreach prefers them. */
const ROLE_PREFERENCE = [
  "secretary",
  "president",
  "events",
  "sponsorship",
  "publicity",
  "other",
  "treasurer",
  "welfare",
  "captain",
] as const

const isPersonal = (email: string) => classifyEmail(email) === "personal_crsid"

/** The best published, non-personal address to write to, or undefined. */
export function bestRoleAddress(
  org: Pick<Doc<"organisations">, "email" | "roleEmails">,
): { email: string; role: string } | undefined {
  for (const role of ROLE_PREFERENCE) {
    const entry = org.roleEmails.find((item) => item.role === role && !isPersonal(item.email))
    if (entry) return { email: entry.email, role }
  }
  if (org.email && !isPersonal(org.email)) return { email: org.email, role: "general" }
  return undefined
}

/** Fields we hold a value for, in registry order. */
export function heldFields(meta: Record<string, FieldMeta>): string[] {
  return Object.entries(meta)
    .filter(([, entry]) => HELD.has(entry.status))
    .map(([field]) => field)
}

/** Hosts of the public pages the held values came from, de-duplicated. */
export function sourceHosts(meta: Record<string, FieldMeta>): string[] {
  const hosts = new Set<string>()
  for (const entry of Object.values(meta)) {
    if (!HELD.has(entry.status) || !entry.sourceUrl) continue
    if ((INTERNAL_SOURCE_TYPES as readonly string[]).includes(entry.sourceType ?? "")) continue
    if (isHttpUrl(entry.sourceUrl)) hosts.add(hostOf(entry.sourceUrl))
  }
  return [...hosts].sort()
}

const needOfferChip = v.object({
  item: literalUnion(NEED_OFFER_ITEMS),
  status: literalUnion(NEED_OFFER_STATUSES),
})

/** One organisation in the broker's table, coverage and outreach export. */
export const brokerOrgRowValidator = v.object({
  key: v.string(),
  slug: v.string(),
  name: v.string(),
  orgType: v.optional(literalUnion(ORG_TYPES)),
  level: v.optional(literalUnion(ORG_LEVELS)),
  status: literalUnion(ORG_STATUSES),
  isCounterpart: v.boolean(),
  hidden: v.boolean(),
  collegeKeys: v.array(v.string()),
  categories: v.array(literalUnion(CATEGORIES)),
  has: v.object({
    email: v.boolean(),
    website: v.boolean(),
    instagram: v.boolean(),
    description: v.boolean(),
  }),
  missingFields: v.array(v.string()),
  bestAddress: v.optional(
    v.object({ email: v.string(), role: v.union(literalUnion(ROLES), v.literal("general")) }),
  ),
  heldFields: v.array(v.string()),
  sourceHosts: v.array(v.string()),
  /** Rejected entries are left out. */
  needs: v.array(needOfferChip),
  offers: v.array(needOfferChip),
  suppressed: v.boolean(),
  hasProfile: v.boolean(),
  updatedAt: v.number(),
})
export type BrokerOrgRow = Infer<typeof brokerOrgRowValidator>

const chips = (entries: Doc<"orgBrokerProfiles">["needs"]) =>
  entries
    .filter((entry) => entry.status !== "rejected")
    .map(({ item, status }) => ({ item, status }))

export function brokerOrgRow(
  org: Doc<"organisations">,
  profile: Doc<"orgBrokerProfiles"> | null,
): BrokerOrgRow {
  const best = bestRoleAddress(org)
  return {
    key: org.key,
    slug: org.slug,
    name: org.name,
    orgType: org.orgType,
    level: org.level,
    status: org.status,
    isCounterpart: org.isCounterpart,
    hidden: org.hidden === true,
    collegeKeys: org.collegeKeys,
    categories: org.categories,
    has: {
      email: best !== undefined,
      website: org.website !== undefined,
      instagram: org.socials.some((social) => social.platform === "instagram"),
      description: Boolean(org.description || org.shortDescription),
    },
    missingFields: org.missingFields,
    bestAddress: best as BrokerOrgRow["bestAddress"],
    heldFields: heldFields(org.meta),
    sourceHosts: sourceHosts(org.meta),
    needs: chips(profile?.needs ?? []),
    offers: chips(profile?.offers ?? []),
    suppressed: profile?.suppressed ?? false,
    hasProfile: profile !== null,
    updatedAt: org.updatedAt,
  }
}

export async function profileOf(
  ctx: QueryCtx,
  orgKey: string,
): Promise<Doc<"orgBrokerProfiles"> | null> {
  return await ctx.db
    .query("orgBrokerProfiles")
    .withIndex("by_orgKey", (q) => q.eq("orgKey", orgKey))
    .unique()
}

export const orgRefValidator = v.object({
  key: v.string(),
  slug: v.string(),
  name: v.string(),
  isCounterpart: v.boolean(),
  hidden: v.boolean(),
})
export type BrokerOrgRef = Infer<typeof orgRefValidator>

/**
 * Looks organisations up by key, once each, for one query. Reads the small
 * directory card first and falls back to the full row, because a hidden
 * organisation has no card but the broker still needs its name.
 */
export function brokerOrgRefs(ctx: QueryCtx) {
  const cache = new Map<string, Promise<BrokerOrgRef | null>>()
  return (key: string): Promise<BrokerOrgRef | null> => {
    let hit = cache.get(key)
    if (!hit) {
      hit = (async () => {
        const card = await ctx.db
          .query("orgCards")
          .withIndex("by_key", (q) => q.eq("key", key))
          .unique()
        if (card) {
          return {
            key,
            slug: card.slug,
            name: card.name,
            isCounterpart: card.isCounterpart,
            hidden: false,
          }
        }
        const org = await ctx.db
          .query("organisations")
          .withIndex("by_key", (q) => q.eq("key", key))
          .unique()
        return org
          ? {
              key,
              slug: org.slug,
              name: org.name,
              isCounterpart: org.isCounterpart,
              hidden: org.hidden === true,
            }
          : null
      })()
      cache.set(key, hit)
    }
    return hit
  }
}

/** Looks people up by key, once each, for one query. */
export function personRefs(ctx: QueryCtx) {
  const cache = new Map<string, Promise<{ key: string; name: string; role: string } | null>>()
  return (key: string) => {
    let hit = cache.get(key)
    if (!hit) {
      hit = ctx.db
        .query("people")
        .withIndex("by_key", (q) => q.eq("key", key))
        .unique()
        .then((person) =>
          person ? { key: person.key, name: person.name, role: person.role } : null,
        )
      cache.set(key, hit)
    }
    return hit
  }
}

/** Trims and length-checks a free-text input; "" becomes undefined. */
export function cleanText(value: string | undefined, max: number, what: string) {
  if (value === undefined) return undefined
  const text = value.trim()
  if (text.length > max) throw new Error(`The ${what} is too long (at most ${max} characters)`)
  return text === "" ? undefined : text
}

/** An ISO `YYYY-MM-DD` date, or a thrown error naming the field. */
export function checkIsoDate(value: string, what: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`The ${what} must be a date (YYYY-MM-DD)`)
  }
  return value
}
