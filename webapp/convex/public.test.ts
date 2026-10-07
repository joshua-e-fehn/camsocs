import { describe, expect, test } from "bun:test"
import { eventKey } from "../lib/keys"
import { api, internal } from "./_generated/api"
import type { ClaimInput } from "./ingest/claims"
import { newTest, signedInAs, type TestConvex, withEnv } from "./lib/harness.testing"

/**
 * The public read API (docs/webapp.md "Public API"): what a visitor, a
 * verified @cam.ac.uk user and the broker each see — and what none of them
 * ever see.
 */

const NOW = Date.now()
const DAY = 86_400_000

function claim(
  entityKey: string,
  field: string,
  value: unknown,
  overrides: Partial<ClaimInput> = {},
): ClaimInput {
  return {
    entityType: "organisation",
    entityKey,
    field,
    ...(value === undefined ? {} : { value }),
    evidence: "primary",
    method: "parser",
    extractor: "test",
    sourceKey: "src-site",
    sourceUrl: "https://example.org/",
    sourceType: "society_website",
    retrievedAt: NOW - 60_000,
    ...overrides,
  }
}

async function seed(t: TestConvex) {
  await t.mutation(internal.ingest.claims.ingest, {
    claims: [
      claim("org-chess", "name", "CU Chess Club"),
      claim("org-chess", "level", "university"),
      claim("org-chess", "orgType", "society"),
      claim("org-chess", "categories", ["hobbies_games"]),
      claim("org-chess", "email", "ab123@cam.ac.uk"),
      claim("org-chess", "roleEmails", [
        { role: "president", email: "president@cuchess.org" },
        { role: "secretary", email: "cd456@cam.ac.uk" },
      ]),
      claim("org-chess", "mailingList", {
        platform: "sympa",
        address: "soc-chess@lists.cam.ac.uk",
        signupUrl: "https://lists.cam.ac.uk/sympa/subscribe/soc-chess",
      }),
      claim("org-chess", "shortDescription", "Weekly chess", {
        sourceType: "mailing_list_email",
        sourceKey: "src-mail",
        sourceUrl: "inbound:<m1@lists.cam.ac.uk>",
      }),
      claim("org-choir", "name", "CU Choir"),
      claim("org-choir", "level", "university"),
      claim("org-choir", "categories", ["music"]),
      claim("org-trinity", "name", "Trinity College"),
      claim("org-trinity", "orgType", "college"),
      claim("org-trinity", "isCounterpart", true),
    ],
  })
  const event = (key: string, title: string, visibility: string, startsAt: number) =>
    ["title", "startsAt", "visibility", "source", "externalId", "sourceUrl"].map((field) =>
      claim(
        key,
        field,
        {
          title,
          startsAt,
          visibility,
          source: visibility === "public" ? "ics" : "mailing_list",
          externalId: title,
          sourceUrl: visibility === "public" ? "https://example.org/e" : `inbound:<${key}@lists>`,
        }[field],
        { entityType: "event" },
      ),
    )
  const keys = {
    open: eventKey("ics", "open"),
    cam: eventKey("mailing_list", "cam"),
    members: eventKey("ics", "members"),
  }
  await t.mutation(internal.ingest.claims.ingest, {
    claims: [
      ...event(keys.open, "Open simul", "public", NOW + 2 * DAY),
      ...event(keys.cam, "Cam-only blitz", "cam_only", NOW + 3 * DAY),
      ...event(keys.members, "Members AGM", "members_only", NOW + 4 * DAY),
    ],
  })
  await t.mutation(internal.ingest.relationships.setEventOrganisers, {
    events: Object.values(keys).map((key) => ({
      eventKey: key,
      organisers: [{ orgKey: "org-chess", role: "organiser" as const }],
    })),
  })
  return keys
}

describe("orgs.getBySlug", () => {
  test("returns the public projection: no personal emails, no list address, no internal sources", async () => {
    const t = newTest()
    await seed(t)
    const page = await t.query(api.orgs.getBySlug, { slug: "chess" })
    expect(page).not.toBeNull()
    const org = page?.org
    expect(org?.name).toBe("CU Chess Club")
    expect(org?.email).toBeUndefined()
    expect(org?.meta.email).toEqual({ status: "missing", missingReason: "not_published" })
    expect(org?.roleEmails).toEqual([{ role: "president", email: "president@cuchess.org" }])
    expect(org?.mailingList).toEqual({
      platform: "sympa",
      signupUrl: "https://lists.cam.ac.uk/sympa/subscribe/soc-chess",
    })
    expect(org?.shortDescription).toBe("Weekly chess")
    expect(org?.meta.shortDescription.sourceUrl).toBeUndefined()
    expect(org?.meta.name.sourceUrl).toBe("https://example.org/")
    expect(JSON.stringify(page)).not.toContain("ab123")
    expect(JSON.stringify(page)).not.toContain("soc-chess@")
  })

  test("events are gated by visibility: public for all, cam_only for @cam.ac.uk, members_only never", async () => {
    await withEnv({ BROKER_EMAILS: "broker@example.com" }, async () => {
      const t = newTest()
      await seed(t)
      const titles = async (client: Pick<TestConvex, "query">) =>
        (await client.query(api.orgs.getBySlug, { slug: "chess" }))?.events.map((e) => e.title)

      expect(await titles(t)).toEqual(["Open simul"])
      expect(await titles(await signedInAs(t, "xy789@cam.ac.uk"))).toEqual([
        "Open simul",
        "Cam-only blitz",
      ])
      expect(await titles(await signedInAs(t, "zz1@cam.ac.uk", { emailVerified: false }))).toEqual([
        "Open simul",
      ])
      expect(await titles(await signedInAs(t, "someone@srcf.cam.ac.uk"))).toEqual(["Open simul"])
      expect(await titles(await signedInAs(t, "broker@example.com"))).toEqual([
        "Open simul",
        "Cam-only blitz",
      ])
    })
  })

  test("an unknown slug is null", async () => {
    expect(await newTest().query(api.orgs.getBySlug, { slug: "nope" })).toBeNull()
  })
})

describe("orgs.list / facets / colleges", () => {
  test("lists cards by name with filters, never counterparts, and paginates", async () => {
    const t = newTest()
    await seed(t)
    const all = await t.query(api.orgs.list, { paginationOpts: { numItems: 10, cursor: null } })
    expect(all.page.map((c) => c.name)).toEqual(["CU Chess Club", "CU Choir"])
    expect(all.isDone).toBe(true)

    const music = await t.query(api.orgs.list, {
      categories: ["music"],
      paginationOpts: { numItems: 10, cursor: null },
    })
    expect(music.page.map((c) => c.slug)).toEqual(["choir"])

    const first = await t.query(api.orgs.list, { paginationOpts: { numItems: 1, cursor: null } })
    expect(first).toMatchObject({ isDone: false, continueCursor: "1" })
    const second = await t.query(api.orgs.list, {
      paginationOpts: { numItems: 1, cursor: first.continueCursor },
    })
    expect(second.page.map((c) => c.name)).toEqual(["CU Choir"])
    expect(second.isDone).toBe(true)
  })

  test("facets count each value under the other filters", async () => {
    const t = newTest()
    await seed(t)
    const facets = await t.query(api.orgs.facets, { categories: ["music"] })
    expect(facets.total).toBe(1)
    expect(facets.categories).toEqual({ hobbies_games: 1, music: 1 })
    expect(facets.levels).toEqual({ university: 1 })
  })

  test("colleges lists the college counterparts", async () => {
    const t = newTest()
    await seed(t)
    expect(await t.query(api.orgs.colleges, {})).toEqual([
      { key: "org-trinity", slug: "trinity", name: "Trinity College" },
    ])
  })
})

describe("events.list / events.get", () => {
  test("a window of events the viewer may see, with organisers and no internal source URL", async () => {
    const t = newTest()
    const keys = await seed(t)
    const window = { from: NOW, to: NOW + 30 * DAY }
    const anonymous = await t.query(api.events.list, window)
    expect(anonymous.map((e) => e.title)).toEqual(["Open simul"])
    expect(anonymous[0].organisers).toEqual([
      { key: "org-chess", slug: "chess", name: "CU Chess Club", role: "organiser" },
    ])

    const cam = await signedInAs(t, "xy789@cam.ac.uk")
    const camEvents = await cam.query(api.events.list, window)
    expect(camEvents.map((e) => e.title)).toEqual(["Open simul", "Cam-only blitz"])
    expect(camEvents[1].sourceUrl).toBeUndefined()

    expect(await t.query(api.events.get, { key: keys.cam })).toBeNull()
    expect(await t.query(api.events.get, { key: keys.members })).toBeNull()
    expect((await cam.query(api.events.get, { key: keys.cam }))?.title).toBe("Cam-only blitz")
  })

  test("filters by organiser, category and type; refuses an unbounded window", async () => {
    const t = newTest()
    await seed(t)
    const window = { from: NOW, to: NOW + 30 * DAY }
    expect(await t.query(api.events.list, { ...window, orgKey: "org-choir" })).toEqual([])
    expect(
      (await t.query(api.events.list, { ...window, categories: ["hobbies_games"] })).length,
    ).toBe(1)
    expect(await t.query(api.events.list, { ...window, eventTypes: ["talk"] })).toEqual([])
    await expect(t.query(api.events.list, { from: NOW, to: NOW + 400 * DAY })).rejects.toThrow(
      /186 days/,
    )
  })
})

describe("events.restrictedCount", () => {
  test("counts the cam_only events a visitor cannot see, under the same filters", async () => {
    const t = newTest()
    await seed(t)
    const window = { from: NOW, to: NOW + 30 * DAY }
    // One cam_only event; the members_only one is never counted or shown.
    expect(await t.query(api.events.restrictedCount, window)).toEqual({ camOnly: 1 })
    expect(await t.query(api.events.restrictedCount, { ...window, eventTypes: ["talk"] })).toEqual({
      camOnly: 0,
    })
    expect(await t.query(api.events.restrictedCount, { ...window, orgKey: "org-chess" })).toEqual({
      camOnly: 1,
    })

    const cam = await signedInAs(t, "xy789@cam.ac.uk")
    expect(await cam.query(api.events.restrictedCount, window)).toEqual({ camOnly: 0 })
  })
})

describe("listingRequests.submit", () => {
  const request = {
    kind: "correct" as const,
    orgKey: "org-chess",
    submitterEmail: "President@CUChess.org",
    message: "Our training moved to Thursdays.",
    fields: { timeCommitment: "Thursdays 7pm" },
  }

  test("stores a validated request", async () => {
    const t = newTest()
    await seed(t)
    const { key } = await t.mutation(api.listingRequests.submit, request)
    const row = await t.run(async (ctx) => await ctx.db.query("listingRequests").first())
    expect(row).toMatchObject({ key, submitterEmail: "president@cuchess.org", status: "open" })
  })

  test("validates and rate-limits per address", async () => {
    const t = newTest()
    await seed(t)
    await expect(
      t.mutation(api.listingRequests.submit, { ...request, submitterEmail: "nope" }),
    ).rejects.toThrow(/valid email/)
    await expect(
      t.mutation(api.listingRequests.submit, { ...request, message: "short" }),
    ).rejects.toThrow(/10 to/)
    await expect(
      t.mutation(api.listingRequests.submit, { ...request, orgKey: "org-missing" }),
    ).rejects.toThrow(/not found/)
    for (let i = 0; i < 5; i++) {
      await t.mutation(api.listingRequests.submit, {
        ...request,
        message: `${request.message} ${i}`,
      })
    }
    await expect(t.mutation(api.listingRequests.submit, request)).rejects.toThrow(/Too many/)
  })
})

describe("listingRequests.submit — the form's other paths", () => {
  test("an add request needs no listing; every other kind does", async () => {
    const t = newTest()
    await seed(t)
    const base = { submitterEmail: "sec@newsoc.example", message: "Please add the Go Society." }
    const { key } = await t.mutation(api.listingRequests.submit, {
      ...base,
      kind: "add",
      fields: { name: "CU Go Society", website: "https://go.example.org/" },
    })
    expect(key).toMatch(/^lr-/)
    for (const kind of ["claim", "correct", "remove", "object"] as const) {
      await expect(t.mutation(api.listingRequests.submit, { ...base, kind })).rejects.toThrow(
        /Which listing/,
      )
    }
  })

  test("refuses field names that are not identifiers and oversized values", async () => {
    const t = newTest()
    await seed(t)
    const base = {
      kind: "correct" as const,
      orgKey: "org-chess",
      submitterEmail: "sec@cuchess.org",
      message: "Two corrections to the listing.",
    }
    await expect(
      t.mutation(api.listingRequests.submit, { ...base, fields: { "<script>": "x" } }),
    ).rejects.toThrow(/Not a field name/)
    await expect(
      t.mutation(api.listingRequests.submit, { ...base, fields: { website: "x".repeat(2_001) } }),
    ).rejects.toThrow(/too long/)
  })
})

describe("termDates.list / venues.list", () => {
  test("term dates in calendar order", async () => {
    const t = newTest()
    const sourceUrl = "https://www.cam.ac.uk/about-the-university/term-dates-and-calendars"
    await t.mutation(internal.ingest.termDates.upsert, {
      terms: [
        {
          academicYear: "2026-27",
          term: "lent",
          fullTermStart: "2027-01-19",
          fullTermEnd: "2027-03-19",
          sourceUrl,
        },
        {
          academicYear: "2026-27",
          term: "michaelmas",
          fullTermStart: "2026-10-06",
          fullTermEnd: "2026-12-04",
          sourceUrl,
        },
      ],
    })
    expect((await t.query(api.termDates.list, {})).map((term) => term.term)).toEqual([
      "michaelmas",
      "lent",
    ])
    expect(await t.query(api.venues.list, {})).toEqual([])
  })
})
