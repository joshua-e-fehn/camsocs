import { paginationOptsValidator } from "convex/server"
import { v } from "convex/values"
import { EVENT_SOURCES, ORG_LEVELS, ORG_STATUSES, ORG_TYPES } from "../../lib/vocab"
import type { Doc } from "../_generated/dataModel"
import { internalMutation, internalQuery } from "../_generated/server"
import { isOrgKey, mailingListValidator } from "../lib/fields"
import {
  assertBatchSize,
  type BatchResult,
  emptyBatchResult,
  recordBatch,
  upsertRow,
} from "../lib/ingest"
import { literalUnion } from "../lib/validators"
import { orgInternalFields as f } from "../schema"

/**
 * `POST /api/pipeline/orgInternal` — feed and source identifiers per
 * organisation (data-model §3), never shown publicly.
 *
 * Patch semantics, by `orgKey`: a field absent from the patch is left alone.
 * List fields (`talksListIds`, `icsUrls`, …, and `playwaze` id lists)
 * **merge** — several harvesters contribute feed URLs for one organisation,
 * and one must not erase another's.
 */

const LIST_FIELDS = [
  "talksListIds",
  "icsUrls",
  "lumaCalendarIds",
  "googleCalendarIds",
  "ticketingUrls",
] as const

const list = v.optional(v.array(v.string()))

export const orgInternalPatchValidator = v.object({
  orgKey: v.string(),
  suOrgId: f.suOrgId,
  suSlug: f.suSlug,
  proctorsName: f.proctorsName,
  sportSlug: f.sportSlug,
  camdramSlug: f.camdramSlug,
  camdramId: f.camdramId,
  talksListIds: list,
  icsUrls: list,
  lumaCalendarIds: list,
  googleCalendarIds: list,
  playwaze: v.optional(
    v.object({ communityId: v.optional(v.string()), leagueIds: list, teamIds: list }),
  ),
  cucbcClub: f.cucbcClub,
  sympaList: f.sympaList,
  ticketingUrls: list,
  instagramHandle: f.instagramHandle,
  instagramBusiness: f.instagramBusiness,
  instagramUserId: f.instagramUserId,
  websiteDomain: f.websiteDomain,
  seniorTreasurer: f.seniorTreasurer,
  legalForm: f.legalForm,
  emailHealth: f.emailHealth,
  websiteHealth: f.websiteHealth,
})

function mergeList(
  existing: readonly string[] | undefined,
  incoming: readonly string[] | undefined,
) {
  return [...new Set([...(existing ?? []), ...(incoming ?? [])])]
}

type OrgInternalFields = Omit<
  Doc<"orgInternal">,
  "_id" | "_creationTime" | "createdAt" | "updatedAt"
>

export const patch = internalMutation({
  args: { patches: v.array(orgInternalPatchValidator) },
  returns: v.object({ inserted: v.number(), updated: v.number(), unchanged: v.number() }),
  handler: async (ctx, args): Promise<BatchResult> => {
    assertBatchSize(args.patches.length, "orgInternal patches")
    const now = Date.now()
    const result = emptyBatchResult()
    for (const incoming of args.patches) {
      if (!isOrgKey(incoming.orgKey)) {
        throw new Error(`Not an organisation key: ${incoming.orgKey}`)
      }
      const existing = await ctx.db
        .query("orgInternal")
        .withIndex("by_orgKey", (q) => q.eq("orgKey", incoming.orgKey))
        .unique()
      const { playwaze, ...rest } = incoming
      const fields: Record<string, unknown> = {}
      for (const [name, value] of Object.entries(rest)) {
        if (value !== undefined) fields[name] = value
      }
      for (const name of LIST_FIELDS) fields[name] = mergeList(existing?.[name], incoming[name])
      if (playwaze) {
        fields.playwaze = {
          communityId: playwaze.communityId ?? existing?.playwaze?.communityId,
          leagueIds: mergeList(existing?.playwaze?.leagueIds, playwaze.leagueIds),
          teamIds: mergeList(existing?.playwaze?.teamIds, playwaze.teamIds),
        }
      }
      const { outcome } = await upsertRow(
        ctx,
        "orgInternal",
        existing,
        fields as OrgInternalFields,
        now,
        { touchUpdatedAt: true },
      )
      recordBatch(result, outcome)
    }
    return result
  },
})

/** One organisation as the pipeline's identity resolver needs to know it. */
export const crosswalkRowValidator = v.object({
  orgKey: v.string(),
  name: v.optional(v.string()),
  aliases: v.array(v.string()),
  shortName: v.optional(v.string()),
  orgType: v.optional(literalUnion(ORG_TYPES)),
  level: v.optional(literalUnion(ORG_LEVELS)),
  collegeKeys: v.array(v.string()),
  isCounterpart: v.boolean(),
  suOrgId: f.suOrgId,
  suSlug: f.suSlug,
  proctorsName: f.proctorsName,
  sportSlug: f.sportSlug,
  camdramSlug: f.camdramSlug,
  camdramId: f.camdramId,
  cucbcClub: f.cucbcClub,
  instagramHandle: f.instagramHandle,
  websiteDomain: f.websiteDomain,
})

/** Organisations per page: a row is read in full (~10 KB with `meta`). */
const CROSSWALK_PAGE = 200

/**
 * `POST /api/pipeline/crosswalk` — every organisation key with the names and
 * source identifiers it is known by (the organisation row joined with its
 * `orgInternal` row), a page at a time in key order. The pipeline's resolver
 * (pipeline/.../resolve/crosswalk.py) reads it at the start of a run so a
 * machine without the local crosswalk cache still reuses every key already
 * loaded instead of minting duplicates. Internal: reached only with the
 * pipeline key.
 */
export const crosswalk = internalQuery({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    rows: v.array(crosswalkRowValidator),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const numItems = Math.max(1, Math.min(CROSSWALK_PAGE, Math.floor(args.limit ?? CROSSWALK_PAGE)))
    const page = await ctx.db
      .query("organisations")
      .withIndex("by_key")
      .paginate({ numItems, cursor: args.cursor ?? null })
    const rows = await Promise.all(
      page.page.map(async (org) => {
        const ids = await ctx.db
          .query("orgInternal")
          .withIndex("by_orgKey", (q) => q.eq("orgKey", org.key))
          .unique()
        return {
          orgKey: org.key,
          name: org.name,
          aliases: org.aliases,
          shortName: org.shortName,
          orgType: org.orgType,
          level: org.level,
          collegeKeys: org.collegeKeys,
          isCounterpart: org.isCounterpart,
          suOrgId: ids?.suOrgId,
          suSlug: ids?.suSlug,
          proctorsName: ids?.proctorsName,
          sportSlug: ids?.sportSlug,
          camdramSlug: ids?.camdramSlug,
          camdramId: ids?.camdramId,
          cucbcClub: ids?.cucbcClub,
          instagramHandle: ids?.instagramHandle,
          websiteDomain: ids?.websiteDomain,
        }
      }),
    )
    return { rows, isDone: page.isDone, continueCursor: page.continueCursor }
  },
})

// --- the mailing-list worklist (read by `camsocs worklist`) ------------------------------

/** The event feeds an organisation's `orgInternal` row names, as event sources. */
export function feedSources(row: Doc<"orgInternal"> | null): string[] {
  if (!row) return []
  const feeds: string[] = []
  if (row.camdramSlug || row.camdramId !== undefined) feeds.push("camdram")
  if (row.talksListIds.length) feeds.push("talks_cam")
  if (row.icsUrls.length) feeds.push("ics")
  if (row.lumaCalendarIds.length) feeds.push("luma")
  if (row.googleCalendarIds.length) feeds.push("google_calendar")
  if (row.playwaze?.leagueIds.length || row.playwaze?.teamIds.length) feeds.push("playwaze")
  if (row.cucbcClub) feeds.push("cucbc")
  if (row.instagramBusiness) feeds.push("instagram_api")
  return feeds
}

const worklistOrgValidator = v.object({
  key: v.string(),
  slug: v.string(),
  name: v.string(),
  shortName: v.optional(v.string()),
  aliases: v.array(v.string()),
  status: literalUnion(ORG_STATUSES),
  orgType: v.optional(literalUnion(ORG_TYPES)),
  level: v.optional(literalUnion(ORG_LEVELS)),
  mailingList: v.optional(mailingListValidator),
  sympaList: v.optional(v.string()),
  /** Event feeds on record (`feedSources`). */
  feeds: v.array(v.string()),
  /** Sources of its upcoming events (at most 10 looked at). */
  upcomingEventSources: v.array(literalUnion(EVENT_SOURCES)),
})

/**
 * `POST /api/pipeline/worklist` — one page of non-counterpart organisations
 * with what the mailing-list worklist ranks on: derived status, the mailing
 * list (address included: this route is internal), the Sympa list on record,
 * the event feeds on record and the sources of upcoming events. Paged, because
 * organisation rows are large; the pipeline follows `continueCursor`.
 */
export const worklistPage = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.object({
    page: v.array(worklistOrgValidator),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, { paginationOpts }) => {
    const result = await ctx.db
      .query("organisations")
      .withIndex("by_isCounterpart", (q) => q.eq("isCounterpart", false))
      .paginate({
        ...paginationOpts,
        numItems: Math.max(1, Math.min(paginationOpts.numItems, 200)),
      })
    const now = Date.now()
    const page = []
    for (const org of result.page) {
      const internal = await ctx.db
        .query("orgInternal")
        .withIndex("by_orgKey", (q) => q.eq("orgKey", org.key))
        .unique()
      const upcoming = await ctx.db
        .query("eventOrganisers")
        .withIndex("by_org_startsAt", (q) => q.eq("orgKey", org.key).gte("startsAt", now))
        .take(10)
      const sources = new Set<(typeof EVENT_SOURCES)[number]>()
      for (const link of upcoming) {
        const event = await ctx.db
          .query("events")
          .withIndex("by_key", (q) => q.eq("key", link.eventKey))
          .unique()
        if (event) sources.add(event.source)
      }
      page.push({
        key: org.key,
        slug: org.slug,
        name: org.name,
        shortName: org.shortName,
        aliases: org.aliases,
        status: org.status,
        orgType: org.orgType,
        level: org.level,
        mailingList: org.mailingList,
        sympaList: internal?.sympaList,
        feeds: feedSources(internal),
        upcomingEventSources: [...sources].sort(),
      })
    }
    return { page, isDone: result.isDone, continueCursor: result.continueCursor }
  },
})
