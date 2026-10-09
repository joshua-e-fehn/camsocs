import { v } from "convex/values"
import { internalQuery } from "../_generated/server"
import { MAX_SUPPRESSIONS } from "../lib/suppressions"

/**
 * `POST /api/pipeline/suppressions` — the suppression list
 * (convex/lib/suppressions.ts) as the pipeline's `load` stage filters by it
 * before posting anything: listings, fields of listings, contact addresses
 * (sha256 of the trimmed, lower-cased address, never the address) and broker
 * people keys removed on request. Internal: reached only with the pipeline
 * key. Holds no personal data.
 */
export const list = internalQuery({
  args: {},
  returns: v.object({
    organisations: v.array(v.string()),
    fields: v.array(v.object({ orgKey: v.string(), field: v.string() })),
    contactHashes: v.array(v.string()),
    people: v.array(v.string()),
    /** More rows than one read returns: the pipeline must not load. */
    truncated: v.boolean(),
  }),
  handler: async (ctx) => {
    const rows = await ctx.db.query("suppressions").take(MAX_SUPPRESSIONS + 1)
    const organisations = new Set<string>()
    const fields = new Map<string, { orgKey: string; field: string }>()
    const contactHashes = new Set<string>()
    const people = new Set<string>()
    for (const row of rows.slice(0, MAX_SUPPRESSIONS)) {
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
      truncated: rows.length > MAX_SUPPRESSIONS,
    }
  },
})
