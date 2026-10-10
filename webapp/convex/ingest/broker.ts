import { v } from "convex/values"
import { NEED_OFFER_ITEMS } from "../../lib/vocab"
import type { Doc } from "../_generated/dataModel"
import { internalMutation } from "../_generated/server"
import { academicYearOf, nextHandoverDate } from "../lib/derived"
import { isHttpUrl, isOrgKey } from "../lib/fields"
import { assertBatchSize, sameFields } from "../lib/ingest"
import { loadSuppressionIndex } from "../lib/suppressions"
import { literalUnion } from "../lib/validators"

/**
 * `POST /api/pipeline/brokerInferences` — what the pipeline infers for the
 * private broker area from public sources (data-model §4):
 *
 *  - **needs / offers** per organisation, always `status: "inferred"`. The
 *    posted list *replaces* the organisation's previous inferred entries of
 *    that kind (the latest extraction is the pipeline's current reading), but
 *    a broker verdict — `confirmed` or `rejected` — is never touched, and its
 *    item is never re-inferred (a rejection is a tombstone).
 *  - **people**: named committee members *as published*, keyed
 *    `per-<sha1(orgKey:nameSlug)>`. A row whose `method` is `manual` belongs
 *    to the broker and is never overwritten. `staleAfter` defaults to the next
 *    30 June after the person was first seen, and a later sighting never moves
 *    it (nor `academicYear`) forward unless the source states a later academic
 *    year; a person retention deleted (R5, `expiredPeople`) is not added back
 *    on the same terms. `consentBasis` is `public_source`.
 *
 * Named people live only here — never in a public table (AGENTS.md). This
 * module is internal and reached only with the pipeline key; reading these
 * tables is for `convex/broker/*`, behind `requireBrokerUser`.
 */

const pipelineMethod = literalUnion(["parser", "llm"] as const)

const inferredItem = v.object({
  item: literalUnion(NEED_OFFER_ITEMS),
  evidenceQuote: v.optional(v.string()),
  sourceUrl: v.string(),
  method: pipelineMethod,
})

export const brokerProfileInputValidator = v.object({
  orgKey: v.string(),
  needs: v.optional(v.array(inferredItem)),
  offers: v.optional(v.array(inferredItem)),
})

export const personInputValidator = v.object({
  key: v.string(),
  orgKey: v.string(),
  name: v.string(),
  role: v.string(),
  academicYear: v.optional(v.string()),
  startDate: v.optional(v.string()),
  staleAfter: v.optional(v.string()),
  sourceUrl: v.string(),
  seenAt: v.number(),
  publicLinks: v.optional(v.array(v.object({ platform: v.string(), url: v.string() }))),
  method: pipelineMethod,
})

type NeedOffer = Doc<"orgBrokerProfiles">["needs"][number]

/** Broker verdicts (confirmed / rejected) stay and block re-inference of their
 * item; inferred entries are replaced by the incoming set. */
export function mergeNeedsOffers(
  existing: readonly NeedOffer[],
  incoming:
    | readonly {
        item: NeedOffer["item"]
        evidenceQuote?: string
        sourceUrl: string
        method: "parser" | "llm"
      }[]
    | undefined,
  now: number,
): NeedOffer[] {
  if (incoming === undefined) return [...existing]
  const confirmed = existing.filter((entry) => entry.status !== "inferred")
  const confirmedItems = new Set(confirmed.map((entry) => entry.item))
  const previous = new Map(
    existing.filter((entry) => entry.status === "inferred").map((entry) => [entry.item, entry]),
  )
  const inferred: NeedOffer[] = []
  const seen = new Set<string>()
  for (const entry of incoming) {
    if (confirmedItems.has(entry.item) || seen.has(entry.item)) continue
    seen.add(entry.item)
    const before = previous.get(entry.item)
    const same =
      before &&
      before.evidenceQuote === entry.evidenceQuote &&
      before.sourceUrl === entry.sourceUrl &&
      before.method === entry.method
    inferred.push({
      item: entry.item,
      status: "inferred",
      evidenceQuote: entry.evidenceQuote,
      sourceUrl: entry.sourceUrl,
      method: entry.method,
      updatedAt: same ? before.updatedAt : now,
    })
  }
  return [...confirmed, ...inferred]
}

/** A profile with nothing known yet — shared with convex/broker/orgs.ts. */
export function emptyProfile(orgKey: string) {
  return {
    orgKey,
    needs: [],
    offers: [],
    optIns: {},
    pecrSubscriberType: "unknown" as const,
    suppressed: false,
    ethicsFlags: [],
    pastSponsorKeys: [],
  }
}

const counts = v.object({ inserted: v.number(), updated: v.number(), unchanged: v.number() })

export const ingest = internalMutation({
  args: {
    profiles: v.optional(v.array(brokerProfileInputValidator)),
    people: v.optional(v.array(personInputValidator)),
  },
  returns: v.object({
    inserted: v.number(),
    updated: v.number(),
    unchanged: v.number(),
    profiles: counts,
    people: v.object({
      inserted: v.number(),
      updated: v.number(),
      unchanged: v.number(),
      /** Rows the broker owns (`method: "manual"`) and the pipeline left alone. */
      protected: v.number(),
      /** People retention deleted at handover, still on an unchanged page (R5). */
      expired: v.number(),
    }),
    /** Rows of a listing or person removed on request (convex/lib/suppressions.ts), skipped. */
    suppressed: v.number(),
  }),
  handler: async (ctx, args) => {
    const profiles = args.profiles ?? []
    const people = args.people ?? []
    assertBatchSize(profiles.length + people.length, "broker inferences")
    const now = Date.now()
    const profileCounts = { inserted: 0, updated: 0, unchanged: 0 }
    const peopleCounts = { inserted: 0, updated: 0, unchanged: 0, protected: 0, expired: 0 }
    const suppressions = await loadSuppressionIndex(ctx)
    let suppressed = 0

    for (const profile of profiles) {
      assertOrgKey(profile.orgKey)
      if (suppressions.organisations.has(profile.orgKey)) {
        suppressed++
        continue
      }
      for (const entry of [...(profile.needs ?? []), ...(profile.offers ?? [])]) {
        if (!isHttpUrl(entry.sourceUrl)) throw new Error(`Not an http(s) URL: ${entry.sourceUrl}`)
      }
      const existing = await ctx.db
        .query("orgBrokerProfiles")
        .withIndex("by_orgKey", (q) => q.eq("orgKey", profile.orgKey))
        .unique()
      const base = existing ?? { ...emptyProfile(profile.orgKey), createdAt: now, updatedAt: now }
      const fields = {
        needs: mergeNeedsOffers(base.needs, profile.needs, now),
        offers: mergeNeedsOffers(base.offers, profile.offers, now),
      }
      if (!existing) {
        await ctx.db.insert("orgBrokerProfiles", { ...base, ...fields })
        profileCounts.inserted++
      } else if (sameFields(existing, fields)) {
        profileCounts.unchanged++
      } else {
        await ctx.db.patch("orgBrokerProfiles", existing._id, { ...fields, updatedAt: now })
        profileCounts.updated++
      }
    }

    for (const person of people) {
      assertOrgKey(person.orgKey)
      if (!/^per-[0-9a-f]{40}$/.test(person.key)) throw new Error(`Not a person key: ${person.key}`)
      if (suppressions.organisations.has(person.orgKey) || suppressions.people.has(person.key)) {
        suppressed++
        continue
      }
      if (!isHttpUrl(person.sourceUrl)) throw new Error(`Not an http(s) URL: ${person.sourceUrl}`)
      const existing = await ctx.db
        .query("people")
        .withIndex("by_key", (q) => q.eq("key", person.key))
        .unique()
      if (existing && existing.method !== "parser" && existing.method !== "llm") {
        peopleCounts.protected++
        continue
      }
      // R5: a re-sighting is no news. A row keeps the year and handover it was
      // first listed for, and a person retention deleted is not added back,
      // unless the source states a later academic year (a page that is never
      // updated keeps listing last year's committee).
      const stated = person.academicYear
      const expired = await ctx.db
        .query("expiredPeople")
        .withIndex("by_key", (q) => q.eq("key", person.key))
        .unique()
      if (expired && !(stated && stated > expired.academicYear)) {
        peopleCounts.expired++
        continue
      }
      if (expired) await ctx.db.delete("expiredPeople", expired._id)
      const renewed = !existing || (stated !== undefined && stated > existing.academicYear)
      const staleAfter = renewed
        ? (person.staleAfter ?? nextHandoverDate(person.seenAt))
        : existing.staleAfter
      const fields = {
        key: person.key,
        name: person.name,
        orgKey: person.orgKey,
        role: person.role,
        academicYear: renewed
          ? (stated ?? academicYearOf(person.seenAt))
          : (existing?.academicYear ?? academicYearOf(person.seenAt)),
        startDate: person.startDate,
        staleAfter,
        stale: staleAfter < new Date(now).toISOString().slice(0, 10),
        sourceUrl: person.sourceUrl,
        seenAt: person.seenAt,
        publicLinks: person.publicLinks ?? [],
        consentBasis: "public_source" as const,
        method: person.method,
      }
      if (!existing) {
        await ctx.db.insert("people", {
          ...fields,
          archived: false,
          createdAt: now,
          updatedAt: now,
        })
        peopleCounts.inserted++
      } else if (sameFields(existing, fields)) {
        peopleCounts.unchanged++
      } else {
        await ctx.db.patch("people", existing._id, { ...fields, updatedAt: now })
        peopleCounts.updated++
      }
    }

    return {
      inserted: profileCounts.inserted + peopleCounts.inserted,
      updated: profileCounts.updated + peopleCounts.updated,
      unchanged: profileCounts.unchanged + peopleCounts.unchanged,
      profiles: profileCounts,
      people: peopleCounts,
      suppressed,
    }
  },
})

function assertOrgKey(key: string): void {
  if (!isOrgKey(key)) throw new Error(`Not an organisation key: ${key}`)
}
