import { describe, expect, test } from "bun:test"
import { eventKey } from "../lib/keys"
import { api, internal } from "./_generated/api"
import type { ClaimInput } from "./ingest/claims"
import { newTest, type TestConvex } from "./lib/harness.testing"

/**
 * Event keys a higher-ranked source superseded (ENG-47,
 * convex/ingest/superseded.ts): a society's page posted an evening as its own
 * event before the University's programme listed it (ENG-24); the page's
 * reading now folds into the University's event and its own key is never
 * posted again. The load retires that key to the survivor: it leaves every
 * public list, and its URL answers with the survivor (`events.locate`).
 * Invented data only.
 */

const NOW = Date.now()
const DAY = 86_400_000
const ORG = "org-jazz"

function claim(
  entityKey: string,
  field: string,
  value: unknown,
  overrides: Partial<ClaimInput> = {},
): ClaimInput {
  return {
    entityType: "event",
    entityKey,
    field,
    value,
    evidence: "primary",
    method: "parser",
    extractor: "test",
    sourceKey: "src-test",
    sourceUrl: "https://example.org/",
    sourceType: "society_website",
    retrievedAt: NOW - 60_000,
    ...overrides,
  }
}

/** A reading posted under its own key, with its identity claims (the
 * pipeline's `claims_for_event` for a primary). */
async function posted(
  t: TestConvex,
  source: "website" | "uni_events_api" | "talks_cam",
  externalId: string,
  title: string,
  startsAt: number,
  extra: Record<string, unknown> = {},
) {
  const key = eventKey(source, externalId)
  const sourceUrl = `https://${source}.example.org/${externalId}`
  const sourceType = {
    website: "society_website",
    uni_events_api: "uni_events_api",
    talks_cam: "talks_list",
  }[source] as ClaimInput["sourceType"]
  const fields = { title, startsAt, visibility: "public", source, externalId, sourceUrl, ...extra }
  await t.mutation(internal.ingest.claims.ingest, {
    claims: Object.entries(fields).map(([field, value]) =>
      claim(key, field, value, { sourceUrl, sourceType, sourceKey: `src-${source}` }),
    ),
  })
  await t.mutation(internal.ingest.relationships.setEventOrganisers, {
    events: [{ eventKey: key, organisers: [{ orgKey: ORG, role: "organiser" as const }] }],
  })
  return key
}

async function seed(t: TestConvex) {
  await t.mutation(internal.ingest.claims.ingest, {
    claims: [
      claim(ORG, "name", "Invented Jazz Orchestra", { entityType: "organisation" }),
      claim(ORG, "level", "university", { entityType: "organisation" }),
      claim(ORG, "shortDescription", "Big band.", { entityType: "organisation" }),
    ],
  })
  const startsAt = NOW + 10 * DAY
  const title = "An Invented Soloist & the Jazz Orchestra"
  const old = await posted(t, "website", "org-jazz:2026-11-15:soloist", title, startsAt)
  const survivor = await posted(
    t,
    "uni_events_api",
    "aaaa1111-0000-4000-8000-000000000003/20261115T193000Z",
    title,
    startsAt,
  )
  return { old, survivor }
}

async function supersede(t: TestConvex, events: { key: string; by: string }[]) {
  return await t.mutation(internal.ingest.superseded.supersede, { events })
}

const window = { from: NOW, to: NOW + 30 * DAY }
const sitemapPage = { paginationOpts: { numItems: 200, cursor: null } }

describe("a superseded event key (ENG-47)", () => {
  test("leaves the calendar, the event query, the sitemap and the society's profile", async () => {
    const t = newTest()
    const { old, survivor } = await seed(t)
    // Before: the same evening twice.
    expect((await t.query(api.events.list, window)).map((e) => e.key).sort()).toEqual(
      [old, survivor].sort(),
    )

    expect(await supersede(t, [{ key: old, by: survivor }])).toEqual({
      updated: 1,
      unchanged: 0,
      unknown: 0,
      rejected: [],
    })

    expect((await t.query(api.events.list, window)).map((e) => e.key)).toEqual([survivor])
    expect(await t.query(api.events.get, { key: old })).toBeNull()
    expect(await t.query(api.events.exists, { key: old })).toBe(false)
    const sitemap = await t.query(api.sitemap.events, sitemapPage)
    expect(sitemap.page.map((row) => row.key)).toEqual([survivor])
    const profile = await t.query(api.orgs.getBySlug, { slug: "jazz" })
    expect(profile?.events.map((e) => e.key)).toEqual([survivor])
    // Its organiser rows no longer count it as the society's activity.
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("eventOrganisers")
        .withIndex("by_event", (q) => q.eq("eventKey", old))
        .collect(),
    )
    expect(rows.map((row) => row.superseded)).toEqual([true])
  })

  test("its URL is located at the survivor, and only there", async () => {
    const t = newTest()
    const { old, survivor } = await seed(t)
    await supersede(t, [{ key: old, by: survivor }])
    expect(await t.query(api.events.locate, { key: old })).toEqual({
      supersededBy: survivor,
      talks: false,
    })
    expect(await t.query(api.events.locate, { key: survivor })).toBe("event")
  })

  test("a chain of retirements is followed; a loop or a missing survivor is a 404", async () => {
    const t = newTest()
    const { old, survivor } = await seed(t)
    const third = await posted(t, "website", "org-jazz:2026-11-15:solo", "Solo", NOW + 10 * DAY)
    await supersede(t, [{ key: third, by: old }])
    await supersede(t, [{ key: old, by: survivor }])
    expect(await t.query(api.events.locate, { key: third })).toEqual({
      supersededBy: survivor,
      talks: false,
    })
    // The survivor itself retired back into the chain: nothing to show.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("events")
        .withIndex("by_key", (q) => q.eq("key", survivor))
        .unique()
      if (row) await ctx.db.patch("events", row._id, { supersededBy: third })
    })
    expect(await t.query(api.events.locate, { key: third })).toBe("missing")
    expect(await t.query(api.events.locate, { key: old })).toBe("missing")
  })

  test("a talks.cam-derived survivor is located under /talks (G1)", async () => {
    const t = newTest()
    const { old } = await seed(t)
    const talk = await posted(t, "talks_cam", "900001", "A talk", NOW + 10 * DAY)
    await supersede(t, [{ key: old, by: talk }])
    expect(await t.query(api.events.locate, { key: old })).toEqual({
      supersededBy: talk,
      talks: true,
    })
  })

  test("comes back when its own reading is the primary again", async () => {
    const t = newTest()
    const { old, survivor } = await seed(t)
    await supersede(t, [{ key: old, by: survivor }])
    // The University dropped the evening: the page's reading is posted under
    // its own key again, identity claims and all — re-posted unchanged, so
    // nothing else about the event changes.
    await t.mutation(internal.ingest.claims.ingest, {
      claims: [
        claim(old, "externalId", "org-jazz:2026-11-15:soloist", {
          sourceUrl: "https://website.example.org/org-jazz:2026-11-15:soloist",
          sourceKey: "src-website",
        }),
      ],
    })
    expect(await t.query(api.events.locate, { key: old })).toBe("event")
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("eventOrganisers")
        .withIndex("by_event", (q) => q.eq("eventKey", old))
        .collect(),
    )
    expect(rows.map((row) => row.superseded)).toEqual([undefined])
  })

  test("a reading folded as a duplicate (no identity claims) does not bring it back", async () => {
    const t = newTest()
    const { old, survivor } = await seed(t)
    await supersede(t, [{ key: old, by: survivor }])
    await t.mutation(internal.ingest.claims.ingest, {
      claims: [claim(old, "description", "More words", { retrievedAt: NOW })],
    })
    expect(await t.query(api.events.get, { key: old })).toBeNull()
  })

  test("keys that never had an event are counted; bad pairs are refused one by one", async () => {
    const t = newTest()
    const { old, survivor } = await seed(t)
    const never = eventKey("website", "org-jazz:2026-11-15:never-posted")
    const result = await supersede(t, [
      { key: never, by: survivor },
      { key: old, by: old },
      { key: "org-jazz", by: survivor },
      { key: old, by: eventKey("uni_events_api", "not-posted") },
      { key: old, by: survivor },
      { key: old, by: survivor },
    ])
    expect(result.updated).toBe(1)
    expect(result.unchanged).toBe(1)
    expect(result.unknown).toBe(2)
    expect(result.rejected.map((row) => row.index)).toEqual([1, 2])
  })
})
