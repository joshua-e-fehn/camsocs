import { describe, expect, test } from "bun:test"
import { api, internal } from "../_generated/api"
import type { Doc } from "../_generated/dataModel"
import { newTest, signedInAs, type TestConvex } from "../lib/harness.testing"
import { MAX_BATCH } from "../lib/ingest"
import type { ClaimInput } from "./claims"

/**
 * `ingest.claims.ingest` against a real (convex-test) database: creation,
 * idempotency, supersession, conflicts, rejection, and the derived fields and
 * directory card it maintains.
 */

const NOW = Date.now()
const ORG = "org-cu-test-society"

function claim(field: string, value: unknown, overrides: Partial<ClaimInput> = {}): ClaimInput {
  return {
    entityType: "organisation",
    entityKey: ORG,
    field,
    ...(value === undefined ? {} : { value }),
    evidence: "primary",
    method: "parser",
    extractor: "test-rule",
    sourceKey: "src-site",
    sourceUrl: "https://cutest.org/",
    sourceType: "society_website",
    retrievedAt: NOW - 60_000,
    ...overrides,
  }
}

async function ingest(t: TestConvex, claims: ClaimInput[], runKey = "run-1") {
  return await t.mutation(internal.ingest.claims.ingest, { runKey, claims })
}

async function org(t: TestConvex, key = ORG): Promise<Doc<"organisations"> | null> {
  return await t.run(
    async (ctx) =>
      await ctx.db
        .query("organisations")
        .withIndex("by_key", (q) => q.eq("key", key))
        .unique(),
  )
}

describe("creating an organisation", () => {
  test("its first claims create the row, with meta for every field and derived fields", async () => {
    const t = newTest()
    const result = await ingest(t, [
      claim("name", "CU Test Society"),
      claim("orgType", "society"),
      claim("level", "university"),
      claim("email", "jf123@cam.ac.uk"),
      claim("categories", ["music"]),
    ])
    expect(result).toMatchObject({
      inserted: 5,
      updated: 0,
      unchanged: 0,
      entities: { created: 1, updated: 0, unchanged: 0 },
      rejected: [],
    })

    const row = await org(t)
    expect(row).toMatchObject({
      key: ORG,
      slug: "cu-test-society",
      name: "CU Test Society",
      orgType: "society",
      level: "university",
      email: "jf123@cam.ac.uk",
      emailType: "personal_crsid",
      categories: ["music"],
      aliases: [],
      socials: [],
      isCounterpart: false,
      status: "unknown",
    })
    expect(row?.meta.name).toMatchObject({ status: "found", confidence: 0.95, method: "parser" })
    expect(row?.meta.website).toEqual({ status: "missing", missingReason: "not_attempted" })
    // Sport fields do not apply to a music society; college fields not to a University one.
    expect(row?.meta["sport.blueStatus"]).toEqual({ status: "not_applicable" })
    expect(row?.meta.collegeKeys).toEqual({ status: "not_applicable" })
    expect(row?.missingFields).toContain("website")
    expect(row?.missingFields).not.toContain("email")
    expect(row?.missingFields).not.toContain("sport.blueStatus")
    expect(row?.searchText).toContain("cu test society")

    const card = await t.run(
      async (ctx) =>
        await ctx.db
          .query("orgCards")
          .withIndex("by_key", (q) => q.eq("key", ORG))
          .unique(),
    )
    expect(card).toMatchObject({
      slug: "cu-test-society",
      name: "CU Test Society",
      nameSort: "cu test society",
    })
  })

  test("without a name the row cannot be created and every claim is rejected", async () => {
    const t = newTest()
    const result = await ingest(t, [claim("website", "https://cutest.org")])
    expect(result.entities.created).toBe(0)
    expect(result.inserted).toBe(0)
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0].reason).toMatch(/no value for name/)
    expect(await org(t)).toBeNull()
  })
})

describe("the claim log", () => {
  test("re-posting the same observation writes nothing", async () => {
    const t = newTest()
    const claims = [claim("name", "CU Test Society"), claim("website", "https://cutest.org")]
    await ingest(t, claims)
    const before = await org(t)
    const again = await ingest(t, claims, "run-2")
    expect(again).toMatchObject({
      inserted: 0,
      updated: 0,
      unchanged: 2,
      entities: { created: 0, updated: 0, unchanged: 1 },
    })
    expect((await org(t))?.updatedAt).toBe(before?.updatedAt)
  })

  test("a re-observation a day later refreshes retrievedAt in meta", async () => {
    const t = newTest()
    const first = claim("name", "CU Test Society", { retrievedAt: NOW - 3 * 86_400_000 })
    await ingest(t, [first])
    const later = { ...first, retrievedAt: NOW - 60_000 }
    const result = await ingest(t, [later], "run-2")
    expect(result).toMatchObject({ inserted: 0, updated: 1 })
    expect((await org(t))?.meta.name.retrievedAt).toBe(NOW - 60_000)
  })

  test("a newer reading from the same source and method supersedes the old one", async () => {
    const t = newTest()
    await ingest(t, [claim("name", "CU Test Society"), claim("email", "old@cutest.org")])
    await ingest(
      t,
      [
        claim("email", "new@cutest.org", {
          retrievedAt: NOW - 1_000,
          contentSha256: "b".repeat(64),
        }),
      ],
      "run-2",
    )
    expect((await org(t))?.email).toBe("new@cutest.org")
    expect((await org(t))?.meta.email.status).toBe("found")

    const claims = await t.run(
      async (ctx) =>
        await ctx.db
          .query("fieldClaims")
          .withIndex("by_entity_field", (q) =>
            q.eq("entityType", "organisation").eq("entityKey", ORG).eq("field", "email"),
          )
          .collect(),
    )
    expect(claims.map((c) => [c.value, c.reviewStatus]).sort()).toEqual([
      ["new@cutest.org", "accepted"],
      ["old@cutest.org", "superseded"],
    ])
  })

  test("a superseded free-text reading keeps no unredacted original (DPIA R-12)", async () => {
    const t = newTest()
    await ingest(t, [
      claim("name", "CU Test Society"),
      claim("description", "Ask our President.", { valueRaw: "Ask our President, Anna." }),
      claim("website", "https://cutest.org/", { valueRaw: "cutest.org" }),
    ])
    await ingest(
      t,
      [
        claim("description", "Ask our Secretary.", {
          valueRaw: "Ask our Secretary, Ben.",
          retrievedAt: NOW,
        }),
        claim("website", "https://www.cutest.org/", { retrievedAt: NOW }),
      ],
      "run-2",
    )
    const claims = await t.run(async (ctx) => await ctx.db.query("fieldClaims").collect())
    const byValue = Object.fromEntries(claims.map((c) => [String(c.value), c]))
    expect(byValue["Ask our President."]).toMatchObject({ reviewStatus: "superseded" })
    expect(byValue["Ask our President."].valueRaw).toBeUndefined()
    expect(byValue["Ask our Secretary."].valueRaw).toBe("Ask our Secretary, Ben.")
    // Not free text: its original stays.
    expect(byValue["https://cutest.org/"].valueRaw).toBe("cutest.org")
  })

  test("an older reading posted late is stored already superseded", async () => {
    const t = newTest()
    await ingest(t, [claim("name", "CU Test Society"), claim("email", "new@cutest.org")])
    await ingest(t, [claim("email", "old@cutest.org", { retrievedAt: NOW - 86_400_000 })], "run-2")
    expect((await org(t))?.email).toBe("new@cutest.org")
  })

  test("a page that drops its email retracts it: missing, with the reason", async () => {
    const t = newTest()
    await ingest(t, [claim("name", "CU Test Society"), claim("email", "hello@cutest.org")])
    await ingest(
      t,
      [
        claim("email", undefined, {
          status: "missing",
          missingReason: "not_published",
          retrievedAt: NOW - 1_000,
        }),
      ],
      "run-2",
    )
    const row = await org(t)
    expect(row?.email).toBeUndefined()
    expect(row?.emailType).toBeUndefined()
    expect(row?.meta.email).toMatchObject({ status: "missing", missingReason: "not_published" })
    expect(row?.missingFields).toContain("email")
  })

  test("two primary sources disagreeing make the field conflicting", async () => {
    const t = newTest()
    await ingest(t, [
      claim("name", "CU Test Society"),
      claim("website", "https://cutest.org"),
      claim("website", "https://cutest.soc.srcf.net", {
        sourceKey: "src-linktree",
        sourceUrl: "https://linktr.ee/cutest",
        sourceType: "linktree",
        retrievedAt: NOW - 30_000,
      }),
    ])
    const row = await org(t)
    expect(row?.website).toBe("https://cutest.soc.srcf.net")
    expect(row?.meta.website.status).toBe("conflicting")
    expect(row?.meta.website.conflicts?.[0].value).toBe("https://cutest.org")
  })

  test("the server computes status and confidence; an unquoted LLM claim is inferred", async () => {
    const t = newTest()
    await ingest(t, [
      claim("name", "CU Test Society"),
      claim("howToJoin", "Turn up on Wednesdays.", {
        method: "llm",
        extractor: "gpt-6-luna",
        status: "found",
        quoteCheck: "absent",
        evidenceQuote: "Join us!",
      }),
    ])
    expect((await org(t))?.meta.howToJoin).toMatchObject({ status: "inferred", confidence: 0.5 })
  })
})

describe("re-readings", () => {
  test("a source that goes back to an earlier value is believed again (X → Y → X)", async () => {
    const t = newTest()
    const key = "evt-0123456789abcdef0123456789abcdef01234567"
    const event = (field: string, value: unknown, retrievedAt: number) =>
      claim(field, value, {
        entityType: "event",
        entityKey: key,
        sourceType: "camdram",
        retrievedAt,
      })
    const at1830 = Date.UTC(2026, 9, 20, 17, 30)
    const at1845 = Date.UTC(2026, 9, 20, 17, 45)
    const base = (at: number) => [
      event("title", "Hamlet", at),
      event("visibility", "public", at),
      event("source", "camdram", at),
      event("externalId", "show-1", at),
      event("sourceUrl", "https://www.camdram.net/shows/hamlet", at),
    ]
    const startsAt = async () =>
      (
        await t.run(
          async (ctx) =>
            await ctx.db
              .query("events")
              .withIndex("by_key", (q) => q.eq("key", key))
              .unique(),
        )
      )?.startsAt
    await ingest(t, [...base(NOW - 3 * 3_600_000), event("startsAt", at1830, NOW - 3 * 3_600_000)])
    await ingest(t, [event("startsAt", at1845, NOW - 2 * 3_600_000)], "run-2")
    expect(await startsAt()).toBe(at1845)
    const third = await ingest(t, [event("startsAt", at1830, NOW - 3_600_000)], "run-3")
    expect(third).toMatchObject({ inserted: 0, updated: 1 })
    expect(await startsAt()).toBe(at1830)

    // Re-posting the old reading itself changes nothing.
    await ingest(t, [event("startsAt", at1845, NOW - 2 * 3_600_000)], "run-4")
    expect(await startsAt()).toBe(at1830)
  })

  test("the same reading of a page whose bytes changed is one claim", async () => {
    const t = newTest()
    await ingest(t, [claim("name", "CU Test Society", { contentSha256: "a".repeat(64) })])
    const again = await ingest(
      t,
      [claim("name", "CU Test Society", { contentSha256: "b".repeat(64) })],
      "run-2",
    )
    expect(again).toMatchObject({ inserted: 0, unchanged: 1 })
  })
})

describe("event visibility", () => {
  const key = "evt-1123456789abcdef0123456789abcdef01234567"
  const mail = (id: string, field: string, value: unknown, retrievedAt: number) =>
    claim(field, value, {
      entityType: "event",
      entityKey: key,
      method: "llm",
      extractor: "gpt-6-luna",
      sourceKey: `src-${id}`,
      sourceUrl: `inbound:<${id}@lists.cam.ac.uk>`,
      sourceType: "mailing_list_email",
      retrievedAt,
    })
  const reading = (id: string, visibility: string, retrievedAt: number) => [
    mail(id, "title", "Committee drinks", retrievedAt),
    mail(id, "startsAt", Date.UTC(2026, 9, 22, 19), retrievedAt),
    mail(id, "visibility", visibility, retrievedAt),
    mail(id, "source", "mailing_list", retrievedAt),
    mail(id, "externalId", "org-cu-test-society:2026-10-22:committee-drinks", retrievedAt),
    mail(id, "sourceUrl", `inbound:<${id}@lists.cam.ac.uk>`, retrievedAt),
  ]

  test("a later mail without 'members only' never opens a members_only event", async () => {
    const t = newTest()
    await ingest(t, reading("m1", "members_only", NOW - 2 * 86_400_000))
    await ingest(t, reading("m2", "cam_only", NOW - 86_400_000), "run-2")
    const cam = await signedInAs(t, "xy789@cam.ac.uk")
    expect(await cam.query(api.events.get, { key })).toBeNull()
    const row = await t.run(
      async (ctx) =>
        await ctx.db
          .query("events")
          .withIndex("by_key", (q) => q.eq("key", key))
          .unique(),
    )
    expect(row?.visibility).toBe("members_only")
  })

  test("a mailing-list event is never public", async () => {
    const t = newTest()
    const result = await ingest(t, reading("m1", "public", NOW - 86_400_000))
    expect(result.rejected.map((r) => r.reason)).toContain(
      "mailing-list events are never public (source-research §16)",
    )
    expect(result.entities.created).toBe(0)
  })
})

describe("rejection", () => {
  test("bad claims are rejected one by one with a reason; the rest land", async () => {
    const t = newTest()
    const result = await ingest(t, [
      claim("name", "CU Test Society"),
      claim("website", "javascript:alert(1)"),
      claim("email", null),
      claim("nonsense", "x"),
      claim("email", undefined),
      claim("categories", ["not-a-category"]),
      claim("name", "Other", { entityKey: "evt-wrong-prefix" }),
      claim("chatChannels", [{ platform: "whatsapp", howToJoin: "https://chat.whatsapp.com/x" }]),
      claim("logo", { storageId: "kg2bogus" }),
      claim("website", "https://cutest.org", { retrievedAt: NOW + 7 * 86_400_000 }),
    ])
    expect(result.inserted).toBe(1)
    expect(result.rejected.map((r) => r.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(result.rejected[1].reason).toMatch(/null is never a value/)
    expect(result.rejected[3].reason).toMatch(/needs status "missing"/)
    expect(result.rejected[6].reason).toMatch(/never stored/)
    expect(result.rejected[7].reason).toMatch(/storageId/)
    expect(result.rejected[8].reason).toMatch(/future/)
  })

  test("a batch over MAX_BATCH is refused whole", async () => {
    const t = newTest()
    const claims = Array.from({ length: MAX_BATCH + 1 }, () => claim("name", "X"))
    await expect(ingest(t, claims)).rejects.toThrow(/Batch too large/)
  })

  test("confidence is never accepted from the caller", async () => {
    const t = newTest()
    const withConfidence = { ...claim("name", "X"), confidence: 1 } as unknown as ClaimInput
    await expect(ingest(t, [withConfidence])).rejects.toThrow(/confidence/)
  })
})

describe("other entity types", () => {
  test("events need title, startsAt, visibility, source, externalId, sourceUrl; defaults fill the rest", async () => {
    const t = newTest()
    const key = "evt-0123456789abcdef0123456789abcdef01234567"
    const event = (field: string, value: unknown) =>
      claim(field, value, { entityType: "event", entityKey: key, sourceType: "camdram" })
    await t.mutation(internal.ingest.termDates.upsert, {
      terms: [
        {
          academicYear: "2026-27",
          term: "michaelmas",
          fullTermStart: "2026-10-06",
          fullTermEnd: "2026-12-04",
          sourceUrl: "https://www.cam.ac.uk/about-the-university/term-dates-and-calendars",
        },
      ],
    })
    const startsAt = Date.UTC(2026, 9, 15, 18, 30)
    const result = await ingest(t, [
      event("title", "Hamlet"),
      event("startsAt", startsAt),
      event("visibility", "public"),
      event("source", "camdram"),
      event("externalId", "show-1"),
      event("sourceUrl", "https://www.camdram.net/shows/hamlet"),
    ])
    expect(result.entities.created).toBe(1)
    const row = await t.run(
      async (ctx) =>
        await ctx.db
          .query("events")
          .withIndex("by_key", (q) => q.eq("key", key))
          .unique(),
    )
    expect(row).toMatchObject({
      title: "Hamlet",
      startsAt,
      allDay: false,
      cancelled: false,
      status: "confirmed",
      eventType: "other",
      organiserKeys: [],
      speakers: [],
      termWeekLabel: "MT26 Wk 2",
      confidence: 0.95,
    })
  })

  test("teams and sessions are created against an organisation key", async () => {
    const t = newTest()
    const result = await ingest(t, [
      claim("orgKey", ORG, { entityType: "team", entityKey: "team-cu-test-society--blues" }),
      claim("name", "Blues", { entityType: "team", entityKey: "team-cu-test-society--blues" }),
      claim("orgKey", ORG, { entityType: "session", entityKey: "ses-abc" }),
      claim("title", "Training", { entityType: "session", entityKey: "ses-abc" }),
      claim("dayOfWeek", 3, { entityType: "session", entityKey: "ses-abc" }),
      claim("name", "Fenner's", { entityType: "venue", entityKey: "ven-fenners" }),
    ])
    expect(result.entities.created).toBe(3)
    expect(result.rejected).toEqual([])
  })
})
