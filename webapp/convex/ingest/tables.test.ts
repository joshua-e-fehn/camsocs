import { describe, expect, test } from "bun:test"
import { eventKey, personKey, relationshipKey, sourceKey } from "../../lib/keys"
import { internal } from "../_generated/api"
import { newTest, type TestConvex, withEnv } from "../lib/harness.testing"
import type { ClaimInput } from "./claims"
import { isDevDeployment, PURGE_READ_BYTES } from "./purge"

/**
 * The keyed side tables the pipeline writes besides claims: sources,
 * orgInternal, relationships, event organisers, broker inferences, the inbox,
 * term dates — and the guarded dev purge.
 */

const NOW = Date.now()

function orgClaims(key: string, name: string): ClaimInput[] {
  return [
    {
      entityType: "organisation",
      entityKey: key,
      field: "name",
      value: name,
      evidence: "primary",
      method: "parser",
      extractor: "test",
      sourceKey: "src-x",
      sourceUrl: `https://${key}.org/`,
      sourceType: "society_website",
      retrievedAt: NOW - 60_000,
    },
  ]
}

async function seedOrgs(t: TestConvex, ...keys: string[]) {
  await t.mutation(internal.ingest.claims.ingest, {
    claims: keys.flatMap((key) => orgClaims(key, key.slice(4).toUpperCase())),
  })
}

describe("sources", () => {
  const url = "https://www.cambridgesu.co.uk/organisation/6789/"
  const source = {
    key: sourceKey(url),
    url,
    sourceType: "su_profile" as const,
    httpStatus: 200,
    lastFetchedAt: NOW,
    robotsVerdict: "allowed" as const,
    robotsCheckedAt: NOW,
  }

  test("upsert by key, host derived, unchanged on repeat", async () => {
    const t = newTest()
    expect(await t.mutation(internal.ingest.sources.upsert, { sources: [source] })).toEqual({
      inserted: 1,
      updated: 0,
      unchanged: 0,
    })
    expect(await t.mutation(internal.ingest.sources.upsert, { sources: [source] })).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 1,
    })
    const row = await t.run(async (ctx) => await ctx.db.query("sources").first())
    expect(row).toMatchObject({ host: "cambridgesu.co.uk", yielded: [] })
  })

  test("a key that is not sourceKey(url) is refused", async () => {
    const t = newTest()
    await expect(
      t.mutation(internal.ingest.sources.upsert, { sources: [{ ...source, key: "src-nope" }] }),
    ).rejects.toThrow(/sourceKey/)
  })
})

describe("orgInternal", () => {
  test("patches leave absent fields alone and merge feed lists", async () => {
    const t = newTest()
    await t.mutation(internal.ingest.orgInternal.patch, {
      patches: [{ orgKey: "org-a", suOrgId: "6789", icsUrls: ["https://a.org/cal.ics"] }],
    })
    await t.mutation(internal.ingest.orgInternal.patch, {
      patches: [{ orgKey: "org-a", camdramSlug: "a-soc", icsUrls: ["https://lu.ma/a.ics"] }],
    })
    const row = await t.run(async (ctx) => await ctx.db.query("orgInternal").first())
    expect(row).toMatchObject({
      orgKey: "org-a",
      suOrgId: "6789",
      camdramSlug: "a-soc",
      icsUrls: ["https://a.org/cal.ics", "https://lu.ma/a.ics"],
      talksListIds: [],
    })
  })

  test("crosswalk pages every organisation with its source identifiers", async () => {
    const t = newTest()
    await seedOrgs(t, "org-a", "org-b", "org-c")
    await t.mutation(internal.ingest.orgInternal.patch, {
      patches: [{ orgKey: "org-b", suOrgId: "8391", instagramHandle: "cuentrepreneurs" }],
    })
    const first = await t.query(internal.ingest.orgInternal.crosswalk, { limit: 2 })
    expect(first.isDone).toBe(false)
    expect(first.rows.map((row) => row.orgKey)).toEqual(["org-a", "org-b"])
    expect(first.rows[1]).toMatchObject({
      name: "B",
      aliases: [],
      collegeKeys: [],
      isCounterpart: false,
      suOrgId: "8391",
      instagramHandle: "cuentrepreneurs",
    })
    expect(first.rows[0].suOrgId).toBeUndefined()
    const rest = await t.query(internal.ingest.orgInternal.crosswalk, {
      cursor: first.continueCursor,
      limit: 2,
    })
    expect(rest.rows.map((row) => row.orgKey)).toEqual(["org-c"])
    expect(rest.isDone).toBe(true)
  })
})

describe("relationships", () => {
  const sighting = {
    fromKey: "org-bank",
    toKey: "org-a",
    type: "sponsors" as const,
    evidence: { sourceUrl: "https://a.org/sponsors", seenAt: NOW },
    method: "parser" as const,
    evidenceKind: "primary" as const,
    visibility: "public" as const,
  }

  test("key minted by the server; evidence merged; public only when allowed", async () => {
    const t = newTest()
    await t.mutation(internal.ingest.relationships.upsert, { relationships: [sighting] })
    await t.mutation(internal.ingest.relationships.upsert, {
      relationships: [
        {
          ...sighting,
          evidence: { sourceUrl: "https://bank.com/csr", seenAt: NOW + 1 },
          evidenceKind: "secondary",
        },
      ],
    })
    const edge = await t.run(async (ctx) => await ctx.db.query("relationships").first())
    expect(edge).toMatchObject({
      key: relationshipKey("org-bank", "sponsors", "org-a"),
      visibility: "public",
      confidence: 0.99,
    })
    expect(edge?.evidence.map((e) => e.sourceUrl)).toEqual([
      "https://bank.com/csr",
      "https://a.org/sponsors",
    ])
  })

  test("a sister_of edge, or secondary evidence, stays internal even when asked", async () => {
    const t = newTest()
    await t.mutation(internal.ingest.relationships.upsert, {
      relationships: [
        { ...sighting, type: "sister_of" },
        { ...sighting, fromKey: "org-c", evidenceKind: "secondary" },
      ],
    })
    const edges = await t.run(async (ctx) => await ctx.db.query("relationships").collect())
    expect(edges.map((e) => e.visibility)).toEqual(["internal", "internal"])
  })
})

describe("eventOrganisers", () => {
  const key = eventKey("camdram", "show-9")
  const event = (field: string, value: unknown): ClaimInput => ({
    ...orgClaims("org-x", "x")[0],
    entityType: "event",
    entityKey: key,
    field,
    value,
    sourceType: "camdram",
    sourceUrl: "https://www.camdram.net/shows/x",
  })

  test("replaces the set, mirrors it on the event, implies edges and activity", async () => {
    const t = newTest()
    await seedOrgs(t, "org-adc", "org-footlights", "org-bank")
    const past = NOW - 5 * 86_400_000
    await t.mutation(internal.ingest.claims.ingest, {
      claims: [
        event("title", "Revue"),
        event("startsAt", past),
        event("visibility", "public"),
        event("source", "camdram"),
        event("externalId", "show-9"),
        event("sourceUrl", "https://www.camdram.net/shows/x"),
      ],
    })
    const result = await t.mutation(internal.ingest.relationships.setEventOrganisers, {
      events: [
        {
          eventKey: key,
          organisers: [
            { orgKey: "org-adc", role: "organiser" },
            { orgKey: "org-footlights", role: "co_host" },
            { orgKey: "org-bank", role: "sponsor" },
          ],
        },
        { eventKey: "evt-missing", organisers: [] },
      ],
    })
    expect(result.missingEvents).toEqual(["evt-missing"])

    const state = await t.run(async (ctx) => ({
      event: await ctx.db
        .query("events")
        .withIndex("by_key", (q) => q.eq("key", key))
        .unique(),
      links: await ctx.db.query("eventOrganisers").collect(),
      edges: await ctx.db.query("relationships").collect(),
      adc: await ctx.db
        .query("organisations")
        .withIndex("by_key", (q) => q.eq("key", "org-adc"))
        .unique(),
    }))
    expect(state.event).toMatchObject({
      organiserKeys: ["org-adc"],
      coHostKeys: ["org-footlights"],
      sponsorKeys: ["org-bank"],
    })
    expect(state.links).toHaveLength(3)
    expect(state.links.every((l) => l.startsAt === past && l.visibility === "public")).toBe(true)
    expect(state.edges.map((e) => [e.fromKey, e.type, e.toKey]).sort()).toEqual([
      ["org-adc", "co_hosted", "org-footlights"],
      ["org-bank", "sponsors", "org-adc"],
    ])
    // The past event makes its organiser active — and lastActiveAt's meta
    // says where that came from (the event's page), not "not attempted".
    expect(state.adc).toMatchObject({ lastActiveAt: past, status: "active" })
    expect(state.adc?.meta.lastActiveAt).toMatchObject({
      status: "found",
      sourceUrl: "https://www.camdram.net/shows/x",
      sourceType: "camdram",
      method: "parser",
    })

    // Replacing the set removes what is no longer listed.
    await t.mutation(internal.ingest.relationships.setEventOrganisers, {
      events: [{ eventKey: key, organisers: [{ orgKey: "org-adc", role: "organiser" }] }],
    })
    const links = await t.run(async (ctx) => await ctx.db.query("eventOrganisers").collect())
    expect(links.map((l) => l.orgKey)).toEqual(["org-adc"])
  })

  test("a merge set (some organisers unresolved) adds and never removes", async () => {
    const t = newTest()
    await seedOrgs(t, "org-adc", "org-footlights")
    await t.mutation(internal.ingest.claims.ingest, {
      claims: [
        event("title", "Revue"),
        event("startsAt", NOW + 86_400_000),
        event("visibility", "public"),
        event("source", "camdram"),
        event("externalId", "show-9"),
        event("sourceUrl", "https://www.camdram.net/shows/x"),
      ],
    })
    await t.mutation(internal.ingest.relationships.setEventOrganisers, {
      events: [{ eventKey: key, organisers: [{ orgKey: "org-adc", role: "organiser" }] }],
    })
    await t.mutation(internal.ingest.relationships.setEventOrganisers, {
      events: [{ eventKey: key, organisers: [], mode: "merge" }],
    })
    await t.mutation(internal.ingest.relationships.setEventOrganisers, {
      events: [
        {
          eventKey: key,
          organisers: [{ orgKey: "org-footlights", role: "co_host" }],
          mode: "merge",
        },
      ],
    })
    const state = await t.run(async (ctx) => ({
      links: await ctx.db.query("eventOrganisers").collect(),
      event: await ctx.db
        .query("events")
        .withIndex("by_key", (q) => q.eq("key", key))
        .unique(),
    }))
    expect(state.links.map((l) => l.orgKey).sort()).toEqual(["org-adc", "org-footlights"])
    expect(state.event).toMatchObject({
      organiserKeys: ["org-adc"],
      coHostKeys: ["org-footlights"],
    })
  })

  test("only public events move an organiser's public activity", async () => {
    const t = newTest()
    await seedOrgs(t, "org-adc")
    const mailKey = eventKey("mailing_list", "org-adc:agm")
    const past = NOW - 5 * 86_400_000
    const mail = (field: string, value: unknown): ClaimInput => ({
      ...event(field, value),
      entityKey: mailKey,
      sourceType: "mailing_list_email",
      sourceUrl: "inbound:<agm@lists>",
    })
    await t.mutation(internal.ingest.claims.ingest, {
      claims: [
        mail("title", "Members' AGM"),
        mail("startsAt", past),
        mail("visibility", "members_only"),
        mail("source", "mailing_list"),
        mail("externalId", "org-adc:agm"),
        mail("sourceUrl", "inbound:<agm@lists>"),
      ],
    })
    await t.mutation(internal.ingest.relationships.setEventOrganisers, {
      events: [{ eventKey: mailKey, organisers: [{ orgKey: "org-adc", role: "organiser" }] }],
    })
    const adc = await t.run(
      async (ctx) =>
        await ctx.db
          .query("organisations")
          .withIndex("by_key", (q) => q.eq("key", "org-adc"))
          .unique(),
    )
    expect(adc?.lastActiveAt).toBeUndefined()
    expect(adc?.meta.lastActiveAt).toEqual({ status: "missing", missingReason: "not_attempted" })
  })
})

describe("broker inferences", () => {
  test("inferred needs replace inferred ones, never confirmed or rejected ones", async () => {
    const t = newTest()
    await t.run(async (ctx) => {
      await ctx.db.insert("orgBrokerProfiles", {
        orgKey: "org-a",
        needs: [
          { item: "sponsorship", status: "confirmed", updatedAt: 1 },
          { item: "members", status: "rejected", updatedAt: 1 },
        ],
        offers: [],
        optIns: {},
        pecrSubscriberType: "unknown",
        suppressed: false,
        ethicsFlags: [],
        pastSponsorKeys: [],
        notes: "Spoke to the president",
        createdAt: 1,
        updatedAt: 1,
      })
    })
    const sourceUrl = "https://a.org/sponsors"
    await t.mutation(internal.ingest.broker.ingest, {
      profiles: [
        {
          orgKey: "org-a",
          needs: [
            { item: "sponsorship", sourceUrl, method: "llm" },
            { item: "speakers", sourceUrl, method: "llm", evidenceQuote: "We need speakers" },
          ],
        },
      ],
    })
    await t.mutation(internal.ingest.broker.ingest, {
      profiles: [
        {
          orgKey: "org-a",
          needs: [
            { item: "venue", sourceUrl, method: "llm" },
            // Rejected by the broker: never re-inferred.
            { item: "members", sourceUrl, method: "llm" },
          ],
        },
      ],
    })
    const profile = await t.run(async (ctx) => await ctx.db.query("orgBrokerProfiles").first())
    expect(profile?.needs.map((n) => [n.item, n.status])).toEqual([
      ["sponsorship", "confirmed"],
      ["members", "rejected"],
      ["venue", "inferred"],
    ])
    expect(profile?.notes).toBe("Spoke to the president")
  })

  test("people: upserted with a default staleAfter; manual rows are never overwritten", async () => {
    const t = newTest()
    const key = personKey("org-a", "Anna Example")
    const person = {
      key,
      orgKey: "org-a",
      name: "Anna Example",
      role: "President",
      sourceUrl: "https://a.org/committee",
      seenAt: Date.UTC(2026, 9, 7),
      method: "parser" as const,
    }
    const first = await t.mutation(internal.ingest.broker.ingest, { people: [person] })
    expect(first.people).toMatchObject({ inserted: 1 })
    const row = await t.run(async (ctx) => await ctx.db.query("people").first())
    expect(row).toMatchObject({
      staleAfter: "2027-06-30",
      academicYear: "2026-27",
      consentBasis: "public_source",
      stale: false,
      archived: false,
    })

    await t.run(async (ctx) => {
      if (row) await ctx.db.patch("people", row._id, { method: "manual", role: "Treasurer" })
    })
    const second = await t.mutation(internal.ingest.broker.ingest, { people: [person] })
    expect(second.people).toMatchObject({ protected: 1, updated: 0 })
    const after = await t.run(async (ctx) => await ctx.db.query("people").first())
    expect(after?.role).toBe("Treasurer")
  })
})

describe("inbound", () => {
  test("pending lists the oldest pending mail; mark records the outcome", async () => {
    const t = newTest()
    await t.run(async (ctx) => {
      for (const [messageId, receivedAt, extraction] of [
        ["<b@x>", 2, "pending"],
        ["<a@x>", 1, "pending"],
        ["<c@x>", 0, "done"],
      ] as const) {
        await ctx.db.insert("inboundEmails", {
          messageId,
          receivedAt,
          from: "list@lists.cam.ac.uk",
          subject: "Talk",
          text: "Come along",
          attachments: [],
          extraction,
          extractedEventKeys: [],
          createdAt: 0,
          updatedAt: 0,
        })
      }
    })
    const pending = await t.query(internal.ingest.inbound.pending, {})
    expect(pending.map((m) => m.messageId)).toEqual(["<a@x>", "<b@x>"])

    const marked = await t.mutation(internal.ingest.inbound.mark, {
      items: [
        { messageId: "<a@x>", extraction: "done", extractedEventKeys: ["evt-1"] },
        { messageId: "<zzz>", extraction: "failed" },
      ],
    })
    expect(marked).toMatchObject({ updated: 1, missing: ["<zzz>"] })
    expect((await t.query(internal.ingest.inbound.pending, {})).map((m) => m.messageId)).toEqual([
      "<b@x>",
    ])
  })
})

describe("termDates", () => {
  const term = {
    academicYear: "2026-27",
    term: "michaelmas" as const,
    fullTermStart: "2026-10-06",
    fullTermEnd: "2026-12-04",
    sourceUrl: "https://www.cam.ac.uk/about-the-university/term-dates-and-calendars",
  }

  test("upserts by (year, term) and validates dates", async () => {
    const t = newTest()
    expect(await t.mutation(internal.ingest.termDates.upsert, { terms: [term] })).toMatchObject({
      inserted: 1,
    })
    expect(await t.mutation(internal.ingest.termDates.upsert, { terms: [term] })).toMatchObject({
      unchanged: 1,
    })
    await expect(
      t.mutation(internal.ingest.termDates.upsert, {
        terms: [{ ...term, fullTermEnd: "2026-10-01" }],
      }),
    ).rejects.toThrow(/end after/)
  })
})

describe("purge", () => {
  test("isDevDeployment matches only the dev deployment's cloud URL", () => {
    expect(isDevDeployment("https://hushed-rhinoceros-215.convex.cloud")).toBe(true)
    expect(isDevDeployment("https://some-prod-123.convex.cloud")).toBe(false)
    expect(isDevDeployment("https://evil.example/hushed-rhinoceros-215.convex.cloud")).toBe(false)
    expect(isDevDeployment(undefined)).toBe(false)
  })

  test("refuses on any other deployment", async () => {
    await withEnv({ CONVEX_CLOUD_URL: "https://prod-otter-1.convex.cloud" }, async () => {
      await expect(
        newTest().mutation(internal.ingest.purge.purge, { confirm: "PURGE-DEV" }),
      ).rejects.toThrow(/not the dev deployment/)
    })
  })

  test("on dev it empties pipeline tables and keeps the run log, inbox and broker rows", async () => {
    await withEnv({ CONVEX_CLOUD_URL: "https://hushed-rhinoceros-215.convex.cloud" }, async () => {
      const t = newTest()
      await seedOrgs(t, "org-a", "org-b")
      await t.mutation(internal.runs.start, {
        runKey: "r1",
        command: "sync",
        requestedStages: [],
        pipelineVersion: "0",
      })
      await t.run(async (ctx) => {
        await ctx.db.insert("interactions", {
          key: "int-1",
          date: 1,
          channel: "email",
          summary: "hi",
          createdAt: 1,
          updatedAt: 1,
        })
      })
      const result = await t.mutation(internal.ingest.purge.purge, { confirm: "PURGE-DEV" })
      expect(result.done).toBe(true)
      expect(result.deleted).toMatchObject({ organisations: 2, orgCards: 2, fieldClaims: 2 })
      const left = await t.run(async (ctx) => ({
        orgs: (await ctx.db.query("organisations").collect()).length,
        runs: (await ctx.db.query("harvestRuns").collect()).length,
        interactions: (await ctx.db.query("interactions").collect()).length,
      }))
      expect(left).toEqual({ orgs: 0, runs: 1, interactions: 1 })
    })
  })

  test("stops a call before the read limit when claims carry long texts", async () => {
    await withEnv({ CONVEX_CLOUD_URL: "https://hushed-rhinoceros-215.convex.cloud" }, async () => {
      const t = newTest()
      await seedOrgs(t, "org-a")
      // Long descriptions: a row count alone would read past Convex's 16 MiB.
      const long = "x".repeat(700_000)
      const copies = Math.ceil(PURGE_READ_BYTES / long.length) + 2
      await t.run(async (ctx) => {
        const claim = await ctx.db.query("fieldClaims").first()
        if (!claim) throw new Error("seed has no claim")
        const { _id, _creationTime, ...row } = claim
        for (let i = 0; i < copies; i++)
          await ctx.db.insert("fieldClaims", { ...row, valueRaw: long })
      })
      const first = await t.mutation(internal.ingest.purge.purge, { confirm: "PURGE-DEV" })
      expect(first.done).toBe(false)
      expect(first.deleted.fieldClaims).toBeLessThan(copies + 1)
      const second = await t.mutation(internal.ingest.purge.purge, { confirm: "PURGE-DEV" })
      expect(second.done).toBe(true)
      const left = await t.run(async (ctx) => (await ctx.db.query("fieldClaims").collect()).length)
      expect(left).toBe(0)
    })
  })

  test("removeEntity deletes one organisation with its claims, card and edges", async () => {
    const t = newTest()
    await seedOrgs(t, "org-a", "org-b")
    await t.mutation(internal.ingest.relationships.upsert, {
      relationships: [
        {
          fromKey: "org-a",
          toKey: "org-b",
          type: "sister_of",
          evidence: { sourceUrl: "https://a.org", seenAt: NOW },
          method: "parser",
          evidenceKind: "primary",
        },
      ],
    })
    const result = await t.mutation(internal.ingest.purge.removeEntity, {
      entityType: "organisation",
      key: "org-a",
    })
    expect(result.deleted).toMatchObject({
      organisations: 1,
      fieldClaims: 1,
      orgCards: 1,
      relationships: 1,
    })
    const left = await t.run(async (ctx) => (await ctx.db.query("organisations").collect()).length)
    expect(left).toBe(1)
  })
})
