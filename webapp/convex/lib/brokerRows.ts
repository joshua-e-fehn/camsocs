import { type Infer, v } from "convex/values"
import type { CoverageRow } from "../../lib/broker/coverage"
import { type Classified, sensitiveOfficerProblem } from "../../lib/broker/sensitive"
import {
  CATEGORIES,
  EMAIL_TYPES,
  type EmailType,
  INTERNAL_SOURCE_TYPES,
  NEED_OFFER_ITEMS,
  NEED_OFFER_STATUSES,
  ORG_LEVELS,
  ORG_STATUSES,
  ORG_TYPES,
  ROLES,
  type Role,
} from "../../lib/vocab"
import type { Doc } from "../_generated/dataModel"
import type { QueryCtx } from "../_generated/server"
import { classifyEmail, nextHandoverDate } from "./derived"
import { findOrganisation } from "./entityStore"
import { hostOf, isHttpUrl } from "./fields"
import type { FieldMeta } from "./resolve"
import { literalUnion } from "./validators"

/**
 * Read models for the private broker area (convex/broker/*). Only those
 * functions use these — every one behind `requireBrokerUser` — so they may
 * carry what the public projection drops (internal sources, hidden rows),
 * with one exception kept even here: the outreach (the Art 14 notice) goes
 * to a role address only — never a personal CRSid address, a lists.cam.ac.uk
 * mailing list (it would reach every member) or a webmail address (often one
 * officer's own). The webmail addresses are listed apart (`webmailAddresses`)
 * for the webmail-only export, which Joshua sends or not by his own choice.
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

/** Address kinds the outreach never writes to (see the module comment). */
const NOT_FOR_OUTREACH: ReadonlySet<EmailType> = new Set(["personal_crsid", "lists_cam", "webmail"])

type OutreachAddress = { email: string; role: Role | "general"; kind: EmailType }
type Addressed = Pick<Doc<"organisations">, "email" | "roleEmails">

/** The published addresses whose kind `accept` takes, best first: role
 * addresses in `ROLE_PREFERENCE` order, then the general address, each once. */
function publishedAddresses(
  org: Addressed,
  accept: (kind: EmailType) => boolean,
): OutreachAddress[] {
  const out: OutreachAddress[] = []
  const seen = new Set<string>()
  const add = (email: string, role: Role | "general") => {
    const kind = classifyEmail(email)
    const id = email.trim().toLowerCase()
    if (!accept(kind) || seen.has(id)) return
    seen.add(id)
    out.push({ email, role, kind })
  }
  for (const role of ROLE_PREFERENCE) {
    for (const item of org.roleEmails) if (item.role === role) add(item.email, role)
  }
  if (org.email) add(org.email, "general")
  return out
}

/**
 * Every published address the outreach may write to, best first. The first
 * is the one the notice goes to; the rest are where it goes next when that
 * one bounces (the export's `next_emails`).
 */
export function outreachAddresses(org: Addressed): OutreachAddress[] {
  return publishedAddresses(org, (kind) => !NOT_FOR_OUTREACH.has(kind))
}

/**
 * Every published webmail address (a society's @gmail.com and the like),
 * best first. The outreach never picks one; the webmail-only export
 * (`lib/broker/outreach.ts` `webmailOutreachCsv`) offers them for societies
 * with no other usable address. A CRSid or alumni address on any domain is
 * `personal_crsid`, not webmail (`classifyEmail`), so it is never here.
 */
export function webmailAddresses(org: Addressed): OutreachAddress[] {
  return publishedAddresses(org, (kind) => kind === "webmail")
}

/** The best published role address to send the outreach to, or undefined. */
export function bestRoleAddress(org: Addressed): OutreachAddress | undefined {
  return outreachAddresses(org)[0]
}

/** Whether the listing publishes any non-personal address (coverage's
 * "email"), whether or not the outreach may use it. */
function hasPublishedAddress(org: Addressed): boolean {
  if (org.email && !isPersonal(org.email)) return true
  return org.roleEmails.some((item) => !isPersonal(item.email))
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

const addressValidator = v.object({
  email: v.string(),
  role: v.union(literalUnion(ROLES), v.literal("general")),
  kind: literalUnion(EMAIL_TYPES),
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
  /** The outreach address (`bestRoleAddress`): a role address, never a
   * personal, mailing-list or webmail one. */
  bestAddress: v.optional(addressValidator),
  /** The other outreach addresses, in the order to try them when the notice
   * to `bestAddress` bounces (`outreachAddresses`). */
  nextAddresses: v.array(v.string()),
  /** The published webmail addresses, best first (`webmailAddresses`); the
   * webmail-only export uses them when there is no `bestAddress`. */
  webmailAddresses: v.array(addressValidator),
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

/** Which headline fields an organisation holds (coverage, the broker table). */
function headlineFields(org: Doc<"organisations">) {
  return {
    email: hasPublishedAddress(org),
    website: org.website !== undefined,
    instagram: org.socials.some((social) => social.platform === "instagram"),
    description: Boolean(org.description || org.shortDescription),
  }
}

/** One organisation as the coverage fold counts it (lib/broker/coverage.ts). */
export function coverageRowOf(org: Doc<"organisations">): CoverageRow {
  return {
    level: org.level,
    orgType: org.orgType,
    status: org.status,
    isCounterpart: org.isCounterpart,
    hidden: org.hidden === true,
    has: headlineFields(org),
    heldFields: heldFields(org.meta),
    missingFields: org.missingFields,
  }
}

export function brokerOrgRow(
  org: Doc<"organisations">,
  profile: Doc<"orgBrokerProfiles"> | null,
): BrokerOrgRow {
  const [best, ...next] = outreachAddresses(org)
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
    has: headlineFields(org),
    missingFields: org.missingFields,
    bestAddress: best,
    nextAddresses: next.map((address) => address.email),
    webmailAddresses: webmailAddresses(org),
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

/**
 * Looks up, once per organisation, what the sensitive-society rules need:
 * the small directory card first (categories and audiences, no website), the
 * full row only for a hidden organisation, which has no card.
 */
export function orgClassesOf(ctx: QueryCtx) {
  const cache = new Map<string, Promise<Classified | null>>()
  return (key: string): Promise<Classified | null> => {
    let hit = cache.get(key)
    if (!hit) {
      hit = (async () => {
        const card = await ctx.db
          .query("orgCards")
          .withIndex("by_key", (q) => q.eq("key", key))
          .unique()
        return card ?? (await findOrganisation(ctx, key))
      })()
      cache.set(key, hit)
    }
    return hit
  }
}

/** Website claims read per organisation when looking for the last one found. */
const WEBSITE_CLAIMS = 100

/**
 * The website a sensitive society's officers must come from (DPIA-lite §5,
 * ENG-42): its recorded `website`, or, when none is recorded because the
 * latest reading of it failed (the site was unreachable or answered 404 on
 * one run), the website it was last found at: the newest `found` reading,
 * accepted or superseded. The pipeline read the officers from that site
 * while it answered, so it is still the society's own; a failed fetch says
 * nothing about whose pages they were. A reading a suppression set aside
 * (`rejected`) never counts. Undefined when no website was ever found.
 *
 * Found on production 2026-11-04: 67 officers of 4 college bodies, all read
 * from the bodies' own sites, were flagged only because one failed reading
 * (`colleges.home`, `missing` / `unreachable` or `not_found`) had replaced
 * the site's `found` reading.
 */
export async function ownWebsiteOf(
  ctx: QueryCtx,
  org: Pick<Doc<"organisations">, "key" | "website">,
): Promise<string | undefined> {
  if (org.website !== undefined) return org.website
  let newest: { url: string; at: number } | undefined
  for (const reviewStatus of ["accepted", "superseded"] as const) {
    const claims = await ctx.db
      .query("fieldClaims")
      .withIndex("by_entity_field", (q) =>
        q
          .eq("entityType", "organisation")
          .eq("entityKey", org.key)
          .eq("field", "website")
          .eq("reviewStatus", reviewStatus),
      )
      .take(WEBSITE_CLAIMS)
    for (const claim of claims) {
      if (claim.status !== "found" || claim.setAsideBy !== undefined) continue
      if (typeof claim.value !== "string" || !isHttpUrl(claim.value)) continue
      if (!newest || claim.retrievedAt > newest.at) {
        newest = { url: claim.value, at: claim.retrievedAt }
      }
    }
  }
  return newest?.url
}

/**
 * Why each stored row at a sensitive society breaks the rules a manual entry
 * meets (`sensitiveOfficerProblem`), or null. The guard runs only on writes,
 * so a row stored before 2026-11-04, or before its society became sensitive,
 * may still hold notes, links or an off-site source; `broker.people.list`
 * flags those and `coverage.sensitiveOfficers` counts them (DPIA-lite §5).
 * The society's site is `ownWebsiteOf`'s.
 */
export function storedSensitiveProblems(ctx: QueryCtx) {
  const limit = nextHandoverDate(Date.now())
  const societies = new Map<string, Promise<{ name?: string; website?: string }>>()
  return async (person: Doc<"people">, because: readonly string[]): Promise<string | null> => {
    if (because.length === 0) return null
    let hit = societies.get(person.orgKey)
    if (!hit) {
      hit = (async () => {
        const org = await findOrganisation(ctx, person.orgKey)
        return org ? { name: org.name, website: await ownWebsiteOf(ctx, org) } : {}
      })()
      societies.set(person.orgKey, hit)
    }
    const org = await hit
    const society = { name: org.name ?? person.orgKey, website: org.website, because }
    return sensitiveOfficerProblem(society, person, limit)
  }
}
