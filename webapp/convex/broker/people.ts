import { ConvexError, v } from "convex/values"
import { sensitiveBecause, sensitiveOfficerProblem } from "../../lib/broker/sensitive"
import { personKey } from "../../lib/keys"
import { CONSENT_BASES, type ConsentBasis } from "../../lib/vocab"
import type { Doc } from "../_generated/dataModel"
import { type MutationCtx, mutation, query } from "../_generated/server"
import { requireBrokerUser } from "../lib/auth"
import {
  brokerOrgRefs,
  checkIsoDate,
  cleanText,
  orgClassesOf,
  orgRefValidator,
  storedSensitiveProblems,
} from "../lib/brokerRows"
import { academicYearOf, londonIsoDate, nextHandoverDate } from "../lib/derived"
import { findOrganisation } from "../lib/entityStore"
import { isHttpUrl, isOrgKey } from "../lib/fields"
import { withoutSystemFields } from "../lib/ingest"
import { loadSuppressionIndex, MAX_NAME_WORDS, nameHash, nameWords } from "../lib/suppressions"
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
 * What a manual entry or edit may hold is limited twice over:
 *
 *  - **Suppressions, for everyone.** A person who objected (a `person`
 *    suppression of the same key, or a `name` suppression of their name) and
 *    anyone at a listing removed on request is refused, as the pipeline's
 *    route refuses them (convex/ingest/broker.ts, retention R8).
 *  - **Officers of sensitive societies** (faith, political, LGBTQ+, ethnic,
 *    national, health or disability identity: lib/broker/sensitive.ts) are
 *    kept under Art 9(2)(e) only as the society's own website lists them
 *    (DPIA-lite §5, R-7, ENG-42). For them the source must be a page of that
 *    website; no profile links and no notes; `staleAfter` no later than the
 *    next 30 June (R5) and never moved later; and `consent` (which R5 never
 *    deletes) only with the explicit consent recorded (`consentRecord`).
 *    The checks run on the row as it would be after the edit, so an edit
 *    that moves someone into such a society meets them too.
 *
 * Refusals are `ConvexError`s whose message the dashboard shows as it is
 * (hooks/convex/broker.ts `errorMessage`).
 *
 * ⚠ Every function here calls `requireBrokerUser` first.
 */

const MAX_PEOPLE = 5_000
const LIMITS = { name: 200, role: 120, notes: 5_000, links: 10, consentEvidence: 300 }
/** Where a manually entered person's details came from: the broker. */
export const MANUAL_SOURCE = "manual:broker"

const publicLink = v.object({ platform: v.string(), url: v.string() })
const consentRecordValidator = v.object({ recordedOn: v.string(), evidence: v.string() })
type ConsentRecord = { recordedOn: string; evidence: string }

function refuse(message: string): never {
  throw new ConvexError(message)
}

export const list = query({
  args: {},
  returns: v.array(
    v.object({
      ...personFields,
      org: v.union(v.null(), orgRefValidator),
      staleNow: v.boolean(),
      /** Why the organisation is a sensitive society ("Faith & Belief"), or
       * empty (lib/broker/sensitive.ts). */
      sensitiveBecause: v.array(v.string()),
      /** Why the stored row breaks the sensitive-society rules, or null. */
      sensitiveProblem: v.union(v.null(), v.string()),
    }),
  ),
  handler: async (ctx) => {
    await requireBrokerUser(ctx)
    const today = londonIsoDate(Date.now())
    const rows = await ctx.db.query("people").take(MAX_PEOPLE)
    const refs = brokerOrgRefs(ctx)
    const classes = orgClassesOf(ctx)
    const problems = storedSensitiveProblems(ctx)
    const out = []
    for (const person of rows) {
      const classified = await classes(person.orgKey)
      const because = classified ? sensitiveBecause(classified) : []
      out.push({
        ...withoutSystemFields<"people">(person),
        org: await refs(person.orgKey),
        // The daily cron sets `stale`; between runs the date decides.
        staleNow: person.stale || person.staleAfter < today,
        sensitiveBecause: because,
        sensitiveProblem: await problems(person, because),
      })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, "en"))
  },
})

/** What a manual entry at `orgKey` may hold, for the dashboard's form. */
export const rules = query({
  args: { orgKey: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      name: v.string(),
      /** Empty unless it is a sensitive society. */
      sensitiveBecause: v.array(v.string()),
      /** Its recorded website: a sensitive society's officers come only from it. */
      website: v.optional(v.string()),
      /** The latest `staleAfter` a sensitive society's officer may have. */
      staleAfterLimit: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    await requireBrokerUser(ctx)
    const org = isOrgKey(args.orgKey) ? await findOrganisation(ctx, args.orgKey) : null
    if (!org) return null
    return {
      name: org.name,
      sensitiveBecause: sensitiveBecause(org),
      website: org.website,
      staleAfterLimit: nextHandoverDate(Date.now()),
    }
  },
})

function checkLinks(links: { platform: string; url: string }[]) {
  if (links.length > LIMITS.links) refuse(`At most ${LIMITS.links} links`)
  for (const link of links) {
    if (!isHttpUrl(link.url)) refuse(`Not an http(s) URL: ${link.url.slice(0, 100)}`)
  }
  return links.map((link) => ({ platform: link.platform.trim().slice(0, 40), url: link.url }))
}

function requireText(value: string, max: number, what: string): string {
  const text = cleanText(value, max, what)
  if (!text) refuse(`The ${what} is required`)
  return text
}

function checkConsentRecord(record: ConsentRecord, now: number): ConsentRecord {
  const recordedOn = checkIsoDate(record.recordedOn, "consent date")
  if (recordedOn > londonIsoDate(now)) refuse("The consent date is in the future")
  return {
    recordedOn,
    evidence: requireText(record.evidence, LIMITS.consentEvidence, "consent record"),
  }
}

/** A person as they would be stored after a create or an edit. */
type Draft = {
  orgKey: string
  name: string
  sourceUrl: string
  staleAfter: string
  consentBasis: ConsentBasis
  consentRecord?: ConsentRecord
  publicLinks: readonly unknown[]
  notes?: string
}

/**
 * Whether a typed name spells a name suppression (`names`: `nameHash`es)
 * anywhere in it, in any case and with or without initials: "Dr Jane Smith",
 * "Jane Smith (President)", "jane SMITH" and "Jane A. Smith" all name Jane
 * Smith. Stricter than `carriesSuppressedName`, which reads free text and so
 * needs capitals; a name field is only a name, so any run of its words counts
 * ("Mary Jane Smith" is refused too, which errs toward the objection).
 */
function namesSuppressedPerson(name: string, names: ReadonlySet<string>): boolean {
  if (names.size === 0) return false
  const words = nameWords(name)
  // Once as typed, once without single-letter initials ("Jane A. Smith").
  for (const run of [words, words.filter((word) => word.length > 1)]) {
    for (let first = 0; first < run.length; first++) {
      for (let size = 2; size <= MAX_NAME_WORDS && first + size <= run.length; size++) {
        if (names.has(nameHash(run.slice(first, first + size).join(" ")))) return true
      }
    }
  }
  return false
}

/** Refuses a person who objected, or anyone at a listing removed on request. */
async function checkNotSuppressed(ctx: MutationCtx, draft: Draft, keys: readonly string[]) {
  const index = await loadSuppressionIndex(ctx)
  if (index.organisations.has(draft.orgKey)) {
    refuse("This listing was removed on request, so no one is kept for it")
  }
  if (keys.some((key) => index.people.has(key)) || namesSuppressedPerson(draft.name, index.names)) {
    refuse("This person objected and is on the suppression list, so they cannot be added back")
  }
}

/**
 * The sensitive-society rules (module comment) for `draft` at `org`.
 * `previousStaleAfter`: the row's date before an edit, which may not move later.
 */
function checkSensitiveOfficer(
  org: Pick<Doc<"organisations">, "name" | "website" | "categories" | "audiences">,
  draft: Draft,
  now: number,
  previousStaleAfter?: string,
): void {
  const society = { name: org.name, website: org.website, because: sensitiveBecause(org) }
  const problem = sensitiveOfficerProblem(society, draft, nextHandoverDate(now), previousStaleAfter)
  if (problem) refuse(problem)
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
    consentRecord: v.optional(consentRecordValidator),
    publicLinks: v.optional(v.array(publicLink)),
    notes: v.optional(v.string()),
  },
  returns: v.object({ key: v.string() }),
  handler: async (ctx, args) => {
    await requireBrokerUser(ctx)
    const org = isOrgKey(args.orgKey) ? await findOrganisation(ctx, args.orgKey) : null
    if (!org) refuse("Pick the organisation this person belongs to")
    const name = requireText(args.name, LIMITS.name, "name")
    const key = personKey(args.orgKey, name)
    const clash = await ctx.db
      .query("people")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique()
    if (clash) refuse(`${clash.name} is already listed at this organisation`)
    const sourceUrl = args.sourceUrl?.trim() || undefined
    if (sourceUrl && !isHttpUrl(sourceUrl)) refuse("The source is not a URL")
    const now = Date.now()
    const staleAfter = args.staleAfter
      ? checkIsoDate(args.staleAfter, "stale-after date")
      : nextHandoverDate(now)
    const draft = {
      orgKey: args.orgKey,
      name,
      sourceUrl: sourceUrl ?? MANUAL_SOURCE,
      staleAfter,
      consentBasis: args.consentBasis ?? "legitimate_interest",
      consentRecord: args.consentRecord && checkConsentRecord(args.consentRecord, now),
      publicLinks: checkLinks(args.publicLinks ?? []),
      notes: cleanText(args.notes, LIMITS.notes, "note"),
    } satisfies Draft
    await checkNotSuppressed(ctx, draft, [key])
    checkSensitiveOfficer(org, draft, now)
    await ctx.db.insert("people", {
      ...draft,
      key,
      role: requireText(args.role, LIMITS.role, "role"),
      academicYear: cleanText(args.academicYear, 10, "academic year") ?? academicYearOf(now),
      startDate: args.startDate ? checkIsoDate(args.startDate, "start date") : undefined,
      stale: staleAfter < londonIsoDate(now),
      seenAt: now,
      method: "manual",
      archived: false,
      createdAt: now,
      updatedAt: now,
    })
    return { key }
  },
})

/** Edits a person; only the fields passed change (`""` clears a note,
 * `consentRecord: null` the consent record). */
export const update = mutation({
  args: {
    key: v.string(),
    orgKey: v.optional(v.string()),
    name: v.optional(v.string()),
    role: v.optional(v.string()),
    academicYear: v.optional(v.string()),
    startDate: v.optional(v.string()),
    staleAfter: v.optional(v.string()),
    sourceUrl: v.optional(v.string()),
    consentBasis: v.optional(literalUnion(CONSENT_BASES)),
    consentRecord: v.optional(v.union(v.null(), consentRecordValidator)),
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
    if (!person) refuse("That person was not found")
    const now = Date.now()
    const patch: Partial<typeof person> = { method: "manual", updatedAt: now }
    const orgKey = args.orgKey ?? person.orgKey
    const org = isOrgKey(orgKey) ? await findOrganisation(ctx, orgKey) : null
    if (!org) refuse("That organisation was not found")
    if (args.orgKey !== undefined) patch.orgKey = args.orgKey
    if (args.sourceUrl !== undefined) {
      const sourceUrl = args.sourceUrl.trim()
      if (sourceUrl && !isHttpUrl(sourceUrl)) refuse("The source is not a URL")
      patch.sourceUrl = sourceUrl || MANUAL_SOURCE
    }
    if (args.consentRecord !== undefined) {
      patch.consentRecord = args.consentRecord
        ? checkConsentRecord(args.consentRecord, now)
        : undefined
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
    const after = { ...person, ...patch }
    await checkNotSuppressed(ctx, after, [person.key, personKey(after.orgKey, after.name)])
    checkSensitiveOfficer(org, after, now, person.staleAfter)
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
    if (!person) refuse("That person was not found")
    await ctx.db.patch("people", person._id, {
      archived: args.archived,
      method: "manual",
      updatedAt: Date.now(),
    })
    return null
  },
})
