import { describe, expect, test } from "bun:test"
import { internal } from "./_generated/api"
import { newTest } from "./lib/harness.testing"

/** The background walks: what time alone changes (data-model §6). */

const DAY = 86_400_000

describe("derive", () => {
  test("recomputeOrganisations turns an organisation dormant once its activity ages out", async () => {
    const t = newTest()
    const lastActive = Date.now() - 200 * DAY
    await t.mutation(internal.ingest.claims.ingest, {
      claims: [
        {
          entityType: "organisation",
          entityKey: "org-old",
          field: "name",
          value: "Old Society",
          evidence: "primary",
          method: "parser",
          extractor: "test",
          sourceKey: "src-x",
          sourceUrl: "https://old.org/",
          sourceType: "society_website",
          retrievedAt: Date.now() - DAY,
        },
      ],
    })
    // Simulate a row derived long ago, when the activity was recent.
    await t.run(async (ctx) => {
      const org = await ctx.db.query("organisations").first()
      if (org)
        await ctx.db.patch("organisations", org._id, { lastActiveAt: lastActive, status: "active" })
    })
    const result = await t.mutation(internal.derive.recomputeOrganisations, {})
    expect(result).toEqual({ processed: 1, changed: 1, done: true })
    const after = await t.run(async (ctx) => ({
      org: await ctx.db.query("organisations").first(),
      card: await ctx.db.query("orgCards").first(),
    }))
    expect(after.org?.status).toBe("dormant")
    expect(after.card?.status).toBe("dormant")
  })

  test("flagStalePeople flags rows whose staleAfter has passed", async () => {
    const t = newTest()
    await t.run(async (ctx) => {
      for (const [key, staleAfter] of [
        ["per-a", "2020-06-30"],
        ["per-b", "2999-06-30"],
      ] as const) {
        await ctx.db.insert("people", {
          key,
          name: key,
          orgKey: "org-a",
          role: "President",
          academicYear: "2019-20",
          staleAfter,
          stale: false,
          sourceUrl: "https://a.org",
          seenAt: 0,
          publicLinks: [],
          consentBasis: "public_source",
          method: "parser",
          archived: false,
          createdAt: 0,
          updatedAt: 0,
        })
      }
    })
    expect(await t.mutation(internal.derive.flagStalePeople, {})).toMatchObject({ changed: 1 })
    const stale = await t.run(async (ctx) =>
      (await ctx.db.query("people").take(10)).map((p) => [p.key, p.stale]),
    )
    expect(stale).toEqual([
      ["per-a", true],
      ["per-b", false],
    ])
  })
})
