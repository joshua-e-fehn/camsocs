import { describe, expect, test } from "bun:test"
import { addDays, londonIsoDate, londonMidnight, startOfWeek } from "../lib/calendar"
import { eventKey } from "../lib/keys"
import { api, internal } from "./_generated/api"
import type { ClaimInput } from "./ingest/claims"
import { newTest, type TestConvex } from "./lib/harness.testing"

/**
 * The directory's discovery reads (convex/orgs.ts): the `sort` order and each
 * card's activity in `orgs.list`, the "Busy this week" shelf (`orgs.busy`)
 * and a profile's related listings (`orgs.related`).
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

function org(key: string, name: string, extra: Record<string, unknown> = {}): ClaimInput[] {
  return [
    claim(key, "name", name),
    claim(key, "level", "university"),
    claim(key, "orgType", "society"),
    ...Object.entries(extra).map(([field, value]) => claim(key, field, value)),
  ]
}

function event(key: string, title: string, startsAt: number, extra: Record<string, unknown> = {}) {
  const fields: Record<string, unknown> = {
    title,
    startsAt,
    visibility: "public",
    source: "ics",
    externalId: title,
    sourceUrl: "https://example.org/e",
    ...extra,
  }
  return Object.entries(fields).map(([field, value]) =>
    claim(key, field, value, { entityType: "event" }),
  )
}

/** Term dates around now, so "this term" and "this week" hold the seeds. */
async function seedTerm(t: TestConvex) {
  await t.mutation(internal.ingest.termDates.upsert, {
    terms: [
      {
        academicYear: "2026-27",
        term: "michaelmas",
        fullTermStart: addDays(londonIsoDate(NOW), -20),
        fullTermEnd: addDays(londonIsoDate(NOW), 40),
        sourceUrl: "https://example.org/terms",
      },
    ],
  })
}

async function seed(t: TestConvex) {
  await seedTerm(t)
  await t.mutation(internal.ingest.claims.ingest, {
    claims: [
      ...org("org-astro", "Astronomy Society", { categories: ["science_tech"] }),
      ...org("org-chess", "Chess Club", { categories: ["hobbies_games"] }),
      ...org("org-go", "Go Society", { categories: ["hobbies_games"] }),
      ...org("org-rowing", "Rowing Club", { categories: ["sport"] }),
    ],
  })
  const keys = {
    chess1: eventKey("ics", "chess-1"),
    chess2: eventKey("ics", "chess-2"),
    chessPast: eventKey("ics", "chess-past"),
    goCam: eventKey("ics", "go-cam"),
    goTakesPart: eventKey("ics", "go-ctf"),
    rowing: eventKey("ics", "rowing-1"),
  }
  await t.mutation(internal.ingest.claims.ingest, {
    claims: [
      ...event(keys.chess1, "Blitz night", NOW + 1 * DAY),
      ...event(keys.chess2, "Simul", NOW + 2 * DAY, { cancelled: true }),
      ...event(keys.chessPast, "Freshers' chess", NOW - 3 * DAY),
      ...event(keys.goCam, "Members' go", NOW + 1 * DAY, {
        visibility: "cam_only",
        source: "mailing_list",
        sourceUrl: "inbound:<go@lists>",
      }),
      ...event(keys.goTakesPart, "Someone's tournament", NOW + 1 * DAY, { hosting: "takes_part" }),
      ...event(keys.rowing, "Novice outing", NOW + 2 * DAY),
    ],
  })
  await t.mutation(internal.ingest.relationships.setEventOrganisers, {
    events: [
      { eventKey: keys.chess1, organisers: [{ orgKey: "org-chess", role: "organiser" as const }] },
      { eventKey: keys.chess2, organisers: [{ orgKey: "org-chess", role: "organiser" as const }] },
      {
        eventKey: keys.chessPast,
        organisers: [{ orgKey: "org-chess", role: "organiser" as const }],
      },
      { eventKey: keys.goCam, organisers: [{ orgKey: "org-go", role: "organiser" as const }] },
      {
        eventKey: keys.goTakesPart,
        organisers: [{ orgKey: "org-go", role: "organiser" as const }],
      },
      { eventKey: keys.rowing, organisers: [{ orgKey: "org-rowing", role: "organiser" as const }] },
    ],
  })
  return keys
}

const firstPage = { numItems: 10, cursor: null }

describe("orgs.list sort and activity", () => {
  test("A–Z by default, busiest first with sort=active (ties keep A–Z)", async () => {
    const t = newTest()
    await seed(t)
    const names = async (sort?: "active" | "name") =>
      (await t.query(api.orgs.list, { sort, paginationOpts: firstPage })).page.map((c) => c.name)
    expect(await names()).toEqual(["Astronomy Society", "Chess Club", "Go Society", "Rowing Club"])
    expect(await names("name")).toEqual(await names())
    // Chess: 2 this term (a past one still counts, the cancelled one not);
    // rowing 1; go's Cambridge-only and taking-part events count for nothing.
    expect(await names("active")).toEqual([
      "Chess Club",
      "Rowing Club",
      "Astronomy Society",
      "Go Society",
    ])
  })

  test("each card carries its count this term and its next event that is still on", async () => {
    const t = newTest()
    const keys = await seed(t)
    const { page } = await t.query(api.orgs.list, { paginationOpts: firstPage })
    const byName = Object.fromEntries(page.map((card) => [card.name, card.activity]))
    // The cancelled simul is not counted (as on the Busy shelf).
    expect(byName["Chess Club"]).toMatchObject({ count: 2, inTerm: true })
    expect(byName["Chess Club"]?.next?.startsAt).toBe(NOW + 1 * DAY)
    expect(byName["Go Society"]).toMatchObject({ count: 0, inTerm: true })
    expect(byName["Go Society"]?.next).toBeUndefined()
    expect(byName["Rowing Club"]?.next?.startsAt).toBe(NOW + 2 * DAY)
    // The cancelled simul is never the next event.
    expect(byName["Chess Club"]?.next?.startsAt).not.toBe(NOW + 2 * DAY)
    expect(keys.chess2).toBeDefined()
  })

  test("a show's nights count as one run, on the cards, the sort and the Busy shelf", async () => {
    // Review 2026-10-31: a theatre company with one six-night run topped
    // "active this term" and the Busy shelf over societies with six events.
    const t = newTest()
    await seed(t)
    await t.mutation(internal.ingest.claims.ingest, {
      claims: org("org-drama", "Drama Society", { categories: ["theatre_film_dance"] }),
    })
    // Six nights from now, the same title (Camdram lists each as an event);
    // the week window may cut them, so the shelf is checked against itself.
    // A run is per London week (Monday start, convex/lib/orgActivity.ts), so
    // the nights must not straddle a Monday midnight: on a Sunday evening they
    // move to next Monday morning, which is still in the same term week
    // (Thursday to Wednesday) and within the next seven days out of term.
    const firstNight = (() => {
      const start = NOW + 60_000
      const weekOf = (ms: number) => startOfWeek(londonIsoDate(ms))
      if (weekOf(start) === weekOf(start + 5 * 3_600_000)) return start
      return londonMidnight(addDays(weekOf(start), 7)) + 10 * 3_600_000
    })()
    const nights = Array.from({ length: 6 }, (_, i) => eventKey("camdram", `top-girls-${i}`))
    await t.mutation(internal.ingest.claims.ingest, {
      claims: nights.flatMap((key, i) =>
        event(key, i === 5 ? "TOP GIRLS" : "Top Girls", firstNight + i * 3_600_000, {
          externalId: `top-girls-${i}`,
        }),
      ),
    })
    await t.mutation(internal.ingest.relationships.setEventOrganisers, {
      events: nights.map((key) => ({
        eventKey: key,
        organisers: [{ orgKey: "org-drama", role: "organiser" as const }],
      })),
    })
    const { page } = await t.query(api.orgs.list, { sort: "active", paginationOpts: firstPage })
    const drama = page.find((card) => card.name === "Drama Society")
    expect(drama?.activity?.count).toBe(1)
    // Chess (two events) outranks the one run.
    expect(page.map((card) => card.name).slice(0, 2)).toEqual(["Chess Club", "Drama Society"])
    const busy = await t.query(api.orgs.busy, {})
    const shelf = Object.fromEntries(busy.orgs.map(({ card, count }) => [card.name, count]))
    // The shelf's own window decides: in the last minute before a term week
    // ends (Wednesday 23:59 London) every night already falls in the next one.
    const onShelf = nights.some((_, i) => {
      const startsAt = firstNight + i * 3_600_000
      return startsAt >= busy.from && startsAt < busy.to
    })
    expect(shelf["Drama Society"]).toBe(onShelf ? 1 : undefined)
    // The organiser rows carry the run and cancelled copies the counts read.
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("eventOrganisers")
        .withIndex("by_org_startsAt", (q) => q.eq("orgKey", "org-drama"))
        .collect(),
    )
    expect(new Set(rows.map((row) => row.runKey)).size).toBe(1)
    expect(rows.every((row) => row.cancelled === false)).toBe(true)
  })

  test("cancelling an event updates its organiser rows, so it stops counting", async () => {
    const t = newTest()
    const keys = await seed(t)
    await t.mutation(internal.ingest.claims.ingest, {
      claims: [claim(keys.chess1, "cancelled", true, { entityType: "event" })],
    })
    const { page } = await t.query(api.orgs.list, { paginationOpts: firstPage })
    expect(page.find((card) => card.name === "Chess Club")?.activity?.count).toBe(1)
  })

  test("sort=name orders a text search A–Z instead of by rank", async () => {
    const t = newTest()
    await seed(t)
    const names = (
      await t.query(api.orgs.list, { q: "club", sort: "name", paginationOpts: firstPage })
    ).page.map((card) => card.name)
    expect(names).toEqual(["Chess Club", "Rowing Club"])
  })
})

describe("orgs.busy", () => {
  test("the week's busiest listings, own public events only, with the term week", async () => {
    const t = newTest()
    await seed(t)
    // Two more this minute, so the current week holds them whatever the weekday.
    const soon = { blitz: eventKey("ics", "blitz-now"), rained: eventKey("ics", "go-off") }
    await t.mutation(internal.ingest.claims.ingest, {
      claims: [
        ...event(soon.blitz, "Lightning blitz", NOW + 60_000),
        ...event(soon.rained, "Go in the park", NOW + 60_000, { cancelled: true }),
      ],
    })
    await t.mutation(internal.ingest.relationships.setEventOrganisers, {
      events: [
        { eventKey: soon.blitz, organisers: [{ orgKey: "org-chess", role: "organiser" as const }] },
        { eventKey: soon.rained, organisers: [{ orgKey: "org-go", role: "organiser" as const }] },
      ],
    })
    const busy = await t.query(api.orgs.busy, {})
    expect(busy.label).toMatch(/^MT\d\d Wk \d$/)
    expect(busy.from).toBeLessThanOrEqual(NOW)
    expect(busy.to).toBeGreaterThan(NOW)
    const shelf = Object.fromEntries(busy.orgs.map(({ card, count }) => [card.name, count]))
    expect(shelf["Chess Club"]).toBeGreaterThanOrEqual(1)
    // Cancelled, Cambridge-only and taking-part events make nobody busy.
    expect(shelf["Go Society"]).toBeUndefined()
    expect(busy.orgs[0].card.name).toBe("Chess Club")
  })

  test("outside term: the next seven days, without a week label", async () => {
    const t = newTest()
    await t.mutation(internal.ingest.claims.ingest, {
      claims: org("org-chess", "Chess Club", { categories: ["hobbies_games"] }),
    })
    const busy = await t.query(api.orgs.busy, { limit: 3 })
    expect(busy.label).toBeUndefined()
    expect(busy.to - busy.from).toBeGreaterThanOrEqual(7 * DAY - 3_600_000)
    expect(busy.orgs).toEqual([])
  })
})

describe("orgs.related", () => {
  test("listings sharing a category, closest first; nothing for an unknown slug", async () => {
    const t = newTest()
    await seed(t)
    expect((await t.query(api.orgs.related, { slug: "chess" })).map((c) => c.name)).toEqual([
      "Go Society",
    ])
    expect(await t.query(api.orgs.related, { slug: "rowing" })).toEqual([])
    expect(await t.query(api.orgs.related, { slug: "nope" })).toEqual([])
  })
})
