import { v } from "convex/values"
import type { Doc } from "../_generated/dataModel"
import { internalMutation } from "../_generated/server"
import {
  assertBatchSize,
  type BatchResult,
  emptyBatchResult,
  recordBatch,
  upsertRow,
} from "../lib/ingest"
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
      if (!/^org-[a-z0-9-]+$/.test(incoming.orgKey)) {
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
