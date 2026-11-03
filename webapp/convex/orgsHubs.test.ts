import { describe, expect, test } from "bun:test"
import { eventKey } from "../lib/keys"
import { api, internal } from "./_generated/api"
import type { ClaimInput } from "./ingest/claims"
import { newTest, type TestConvex } from "./lib/harness.testing"

/**
 * The directory's hubs, sitemap and talks invariant (SEO audit 2026-11-02;
 * owner decisions G1, G3, G13): `orgs.hub`, `orgs.sitemap`,
 * `getBySlug.hasPublicEvents`, and no talks.cam link in any card. Synthetic
 * listings only.
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
    value,
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
      // A described university society.
      claim("org-chess", "name", "Chess Club"),
      claim("org-chess", "level", "university"),
      claim("org-chess", "categories", ["hobbies_games"]),
      claim("org-chess", "description", "We play chess every week."),
      claim(
        "org-chess",
        "shortDescription",
        "Weekly chess; talks at [our list](https://talks.cam.ac.uk/show/index/1).",
      ),
      // A college boat club with nothing but its name: thin, until an event.
      claim("org-boat", "name", "Example Boat Club"),
      claim("org-boat", "level", "college"),
      claim("org-boat", "orgType", "college_boat_club"),
      claim("org-boat", "categories", ["sport"]),
      claim("org-boat", "collegeKeys", ["org-example"]),
      // A sports club with a website only.
      claim("org-netball", "name", "Netball Club"),
      claim("org-netball", "categories", ["sport"]),
      claim("org-netball", "website", "https://netball.example.org/"),
      // A thin listing.
      claim("org-empty", "name", "Empty Society"),
      claim("org-empty", "categories", ["music"]),
      // Colleges: one with a listing, one without.
      claim("org-example", "name", "Example College"),
      claim("org-example", "orgType", "college"),
      claim("org-example", "isCounterpart", true),
      claim("org-other", "name", "Other College"),
      claim("org-other", "orgType", "college"),
      claim("org-other", "isCounterpart", true),
    ],
  })
}

async function addEvent(t: TestConvex, orgKey: string, startsAt: number, fromTalks = false) {
  const source = fromTalks ? "talks_cam" : "ics"
  const key = eventKey(source, `${orgKey}-${startsAt}`)
  const values: Record<string, unknown> = {
    title: fromTalks ? "Invented seminar" : "Invented outing",
    startsAt,
    visibility: "public",
    source,
    externalId: `${orgKey}-${startsAt}`,
    sourceUrl: fromTalks ? "https://talks.cam.ac.uk/talk/index/1" : "https://example.org/cal.ics",
  }
  await t.mutation(internal.ingest.claims.ingest, {
    claims: Object.entries(values).map(([field, value]) =>
      claim(key, field, value, { entityType: "event" }),
    ),
  })
  await t.mutation(internal.ingest.relationships.setEventOrganisers, {
    events: [{ eventKey: key, organisers: [{ orgKey, role: "organiser" as const }] }],
  })
}

describe("orgs.hub", () => {
  test("a category's listings, by name, without counterparts", async () => {
    const t = newTest()
    await seed(t)
    const sport = await t.query(api.orgs.hub, { category: "sport" })
    expect(sport.map((card) => card.slug)).toEqual(["boat", "netball"])
    expect(sport[0]).toMatchObject({
      name: "Example Boat Club",
      orgType: "college_boat_club",
      collegeKeys: ["org-example"],
    })
  })

  test("a college's listings", async () => {
    const t = newTest()
    await seed(t)
    const college = await t.query(api.orgs.hub, { collegeKey: "org-example" })
    expect(college.map((card) => card.slug)).toEqual(["boat"])
    expect(await t.query(api.orgs.hub, { collegeKey: "org-other" })).toEqual([])
  })
})

describe("the talks invariant on cards (G1)", () => {
  test("no card text carries a talks.cam link", async () => {
    const t = newTest()
    await seed(t)
    const lists = [
      await t.query(api.orgs.hub, { category: "hobbies_games" }),
      (await t.query(api.orgs.list, { paginationOpts: { numItems: 10, cursor: null } })).page,
      await t.query(api.orgs.related, { slug: "boat" }),
    ]
    for (const list of lists) expect(JSON.stringify(list)).not.toContain("talks.cam")
    const [chess] = lists[0]
    expect(chess.shortDescription).toBe("Weekly chess; talks at our list.")
  })
})

describe("orgs.sitemap (G3, G13)", () => {
  test("every listing and college hub, thin ones and empty hubs marked not indexable", async () => {
    const t = newTest()
    await seed(t)
    const result = await t.query(api.orgs.sitemap, {})
    expect(result.isDone).toBe(true)
    expect(
      Object.fromEntries(result.page.map((entry) => [entry.slug, [entry.kind, entry.indexable]])),
    ).toEqual({
      boat: ["listing", false],
      chess: ["listing", true],
      empty: ["listing", false],
      netball: ["listing", true],
      example: ["college", true],
      other: ["college", false],
    })
    for (const entry of result.page) expect(entry.updatedAt).toBeGreaterThan(0)
  })

  test("an event, past or upcoming, lifts a thin listing", async () => {
    const t = newTest()
    await seed(t)
    await addEvent(t, "org-boat", NOW - 30 * DAY)
    const page = await t.query(api.orgs.getBySlug, { slug: "boat" })
    expect(page?.hasPublicEvents).toBe(true)
    expect(page?.events).toEqual([])
    const entry = (await t.query(api.orgs.sitemap, {})).page.find((item) => item.slug === "boat")
    expect(entry?.indexable).toBe(true)
    expect((await t.query(api.orgs.getBySlug, { slug: "empty" }))?.hasPublicEvents).toBe(false)
  })

  test("pages by offset", async () => {
    const t = newTest()
    await seed(t)
    const first = await t.query(api.orgs.sitemap, { numItems: 4 })
    expect(first).toMatchObject({ isDone: false, continueCursor: "4" })
    const second = await t.query(api.orgs.sitemap, { cursor: first.continueCursor, numItems: 4 })
    expect(second.isDone).toBe(true)
    expect([...first.page, ...second.page]).toHaveLength(6)
  })
})

describe("orgs.getBySlug carries the talks invariant itself (G1)", () => {
  test("no talks.cam event, link or source in what any caller receives", async () => {
    const t = newTest()
    await seed(t)
    await t.mutation(internal.ingest.claims.ingest, {
      claims: [
        claim("org-empty", "website", "https://talks.cam.ac.uk/show/index/9"),
        claim("org-empty", "howToJoin", "Copied from an invented talks listing.", {
          sourceUrl: "https://talks.cam.ac.uk/show/index/9",
          sourceType: "talks_list",
        }),
      ],
    })
    await addEvent(t, "org-empty", NOW + 2 * DAY, true)
    await addEvent(t, "org-empty", NOW - 2 * DAY, true)
    const page = await t.query(api.orgs.getBySlug, { slug: "empty" })
    expect(page).not.toBeNull()
    expect(JSON.stringify(page)).not.toContain("talks.cam")
    expect(JSON.stringify(page)).not.toContain("Invented seminar")
    expect(page?.org.website).toBeUndefined()
    expect(page?.org.howToJoin).toBeUndefined()
    expect(page?.events).toEqual([])
  })
})

describe("thinness agrees between the page and the sitemap (G1, G3)", () => {
  test("talks.cam events alone do not lift a thin listing", async () => {
    const t = newTest()
    await seed(t)
    await addEvent(t, "org-empty", NOW - 2 * DAY, true)
    expect((await t.query(api.orgs.getBySlug, { slug: "empty" }))?.hasPublicEvents).toBe(false)
    const entry = (await t.query(api.orgs.sitemap, {})).page.find((item) => item.slug === "empty")
    expect(entry?.indexable).toBe(false)
  })

  test("a website on talks.cam is no website", async () => {
    const t = newTest()
    await seed(t)
    await t.mutation(internal.ingest.claims.ingest, {
      claims: [claim("org-empty", "website", "https://talks.cam.ac.uk/show/index/9")],
    })
    const entry = (await t.query(api.orgs.sitemap, {})).page.find((item) => item.slug === "empty")
    expect(entry?.indexable).toBe(false)
  })

  test("a description removed on request leaves the listing thin; a removed listing leaves", async () => {
    const t = newTest()
    await seed(t)
    await t.run(async (ctx) => {
      await ctx.db.insert("suppressions", {
        key: "sup-chess-description",
        scope: "field",
        orgKey: "org-chess",
        field: "description",
        createdAt: NOW,
      })
      await ctx.db.insert("suppressions", {
        key: "sup-chess-short",
        scope: "field",
        orgKey: "org-chess",
        field: "shortDescription",
        createdAt: NOW,
      })
      await ctx.db.insert("suppressions", {
        key: "sup-netball",
        scope: "organisation",
        orgKey: "org-netball",
        createdAt: NOW,
      })
    })
    const page = (await t.query(api.orgs.sitemap, {})).page
    expect(page.find((item) => item.slug === "chess")?.indexable).toBe(false)
    expect(page.some((item) => item.slug === "netball")).toBe(false)
  })
})
