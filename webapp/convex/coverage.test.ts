import { describe, expect, test } from "bun:test"
import type { FunctionReturnType } from "convex/server"
import { coverageStats, emptyCoverage, mergeCoverage } from "../lib/broker/coverage"
import { api, internal } from "./_generated/api"
import { ORG_PAGE } from "./coverage"
import type { ClaimInput } from "./ingest/claims"
import { newTest, signedInAs, type TestConvex, withEnv } from "./lib/harness.testing"

/**
 * Directory coverage is folded on the server, a page at a time, into one
 * snapshot the broker overview reads — the same numbers the old in-browser
 * fold over every broker row gave — and the overview reports the latest
 * resolve stage's quarantine counts.
 */

const BROKER = "broker@example.com"
const NOW = Date.now()
/** More organisations than one page, so the walk reschedules itself. */
const ORGS = ORG_PAGE + 20

function claim(entityKey: string, field: string, value: unknown): ClaimInput {
  return {
    entityType: "organisation",
    entityKey,
    field,
    value,
    evidence: "primary",
    method: "parser",
    extractor: "test",
    sourceKey: "src-reg",
    sourceUrl: "https://register.example/",
    sourceType: "su_directory",
    retrievedAt: NOW - 60_000,
  }
}

async function seed(t: TestConvex) {
  const claims: ClaimInput[] = []
  for (let i = 0; i < ORGS; i++) {
    const key = `org-society-${String(i).padStart(3, "0")}`
    claims.push(claim(key, "name", `Society ${i}`))
    if (i % 2 === 0) claims.push(claim(key, "website", `https://soc${i}.example/`))
    if (i % 3 === 0) claims.push(claim(key, "level", "university"))
  }
  claims.push(claim("org-bank", "name", "Example Bank"), claim("org-bank", "isCounterpart", true))
  for (let start = 0; start < claims.length; start += 100) {
    await t.mutation(internal.ingest.claims.ingest, { claims: claims.slice(start, start + 100) })
  }
}

describe("coverage", () => {
  test("the server-side snapshot equals the fold over every broker row", async () => {
    await withEnv({ BROKER_EMAILS: BROKER }, async () => {
      const t = newTest()
      await seed(t)
      const broker = (await signedInAs(t, BROKER)) as unknown as TestConvex
      expect((await broker.query(api.broker.overview.summary, {})).coverage).toBeNull()

      await broker.mutation(api.broker.overview.refreshCoverage, {})
      await t.finishAllScheduledFunctions(() => {})

      const rows = []
      let cursor: string | null = null
      for (;;) {
        const page: FunctionReturnType<typeof api.broker.orgs.page> = await broker.query(
          api.broker.orgs.page,
          { paginationOpts: { numItems: 250, cursor } },
        )
        rows.push(...page.page)
        if (page.isDone) break
        cursor = page.continueCursor
      }
      const { coverage } = await broker.query(api.broker.overview.summary, {})
      expect(coverage?.rows).toBe(ORGS + 1)
      const expected = coverageStats(rows)
      expect(coverage?.stats).toEqual(expected)
      expect(coverage?.stats.total).toBe(ORGS)
      expect(coverage?.stats.counterparts).toBe(1)
      expect(coverage?.stats.headline.website).toBe(ORGS / 2)
      expect(coverage?.stats.held.name).toBe(ORGS)
      expect(coverage?.stats.byLevel.university).toBe(Math.ceil(ORGS / 3))
    })
  })

  test("the pipeline's pages add up to the same counts", async () => {
    const t = newTest()
    await seed(t)
    await t.mutation(internal.coverage.recompute, {})
    await t.finishAllScheduledFunctions(() => {})
    let total = emptyCoverage()
    let cursor: string | null = null
    for (;;) {
      const page: {
        counts: ReturnType<typeof emptyCoverage>
        isDone: boolean
        continueCursor: string
      } = await t.query(internal.coverage.page, { cursor, limit: 50 })
      total = mergeCoverage(total, page.counts)
      if (page.isDone) break
      cursor = page.continueCursor
    }
    const snapshot = await t.run(async (ctx) => await ctx.db.query("coverageSnapshots").first())
    const {
      share: _share,
      missingTop: _top,
      ...counts
    } = snapshot?.stats ?? {
      share: undefined,
      missingTop: undefined,
    }
    expect(total).toEqual(counts as typeof total)
  })

  test("upcoming events by source, for the coverage report", async () => {
    const t = newTest()
    const event = (key: string, startsAt: number, source: string) =>
      [
        ["title", `Event ${key}`],
        ["startsAt", startsAt],
        ["visibility", "public"],
        ["source", source],
        ["externalId", key],
        ["sourceUrl", `https://example.org/${key}`],
      ].map(([field, value]) => ({
        entityType: "event" as const,
        entityKey: key,
        field: field as string,
        value,
        evidence: "primary" as const,
        method: "parser" as const,
        extractor: "test",
        sourceKey: `src-${key}`,
        sourceUrl: `https://example.org/${key}`,
        sourceType: "ics_feed" as const,
        retrievedAt: NOW - 60_000,
      }))
    await t.mutation(internal.ingest.claims.ingest, {
      claims: [
        ...event("evt-a", NOW + 86_400_000, "camdram"),
        ...event("evt-b", NOW + 2 * 86_400_000, "camdram"),
        ...event("evt-c", NOW + 3 * 86_400_000, "talks_cam"),
        ...event("evt-past", NOW - 86_400_000, "camdram"),
      ],
    })
    const page = await t.query(internal.coverage.eventsPage, { from: NOW })
    expect(page).toMatchObject({
      bySource: { camdram: 2, talks_cam: 1 },
      byVisibility: { public: 3 },
      cancelled: 0,
      rows: 3,
      isDone: true,
    })
  })

  test("the overview reports the latest resolve stage's quarantine", async () => {
    await withEnv({ BROKER_EMAILS: BROKER }, async () => {
      const t = newTest()
      const broker = (await signedInAs(t, BROKER)) as unknown as TestConvex
      const stage = (name: string, metrics?: Record<string, number>) => ({
        name,
        status: "ok" as const,
        inserted: 0,
        updated: 0,
        unchanged: 0,
        skipped: 0,
        error: null,
        notes: [],
        ...(metrics ? { metrics } : {}),
      })
      for (const [runKey, stages] of [
        [
          "run-1",
          [stage("resolve", { quarantineHeld: 8, quarantineDropped: 1, quarantineReview: 18 })],
        ],
        ["run-2", [stage("load")]],
      ] as const) {
        await t.mutation(internal.runs.start, {
          runKey,
          command: "sync",
          requestedStages: stages.map((s) => s.name),
          pipelineVersion: "0.1.0",
        })
        await t.mutation(internal.runs.finish, {
          runKey,
          stages: [...stages],
          warnings: [],
          error: null,
        })
      }
      await t.finishAllScheduledFunctions(() => {})
      const { quarantine } = await broker.query(api.broker.overview.summary, {})
      expect(quarantine).toMatchObject({ held: 8, dropped: 1, review: 18, runKey: "run-1" })
    })
  })
})
