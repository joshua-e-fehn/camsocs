import { describe, expect, test } from "bun:test"
import { eventKey } from "../lib/keys"
import { api, internal } from "./_generated/api"
import type { Doc } from "./_generated/dataModel"
import type { ClaimInput } from "./ingest/claims"
import { newTest, type TestConvex } from "./lib/harness.testing"

/**
 * The University's own listings on the calendar (ENG-24): an event read from
 * the University of Cambridge's public events programme (`uni_events_api`)
 * that names no student group is `fromUniversity`, derived in the projection
 * and never stored; `events.list`'s `university` argument hides it or lists
 * nothing else, and the organiser-card filters (category, college) never
 * match it. The calendar reads each listing stream through its own index
 * (`events.stream`, ENG-31), so a crowd of University listings never hides a
 * society's event. Every event here is invented.
 */

const NOW = Date.now()
const DAY = 86_400_000
const PROGRAMME = "https://events.example.ac.uk/programme/feed.ics"

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

function event(
  key: string,
  source: "ics" | "uni_events_api",
  title: string,
  startsAt: number,
  eventType = "other",
): ClaimInput[] {
  const values: Record<string, unknown> = {
    title,
    startsAt,
    visibility: "public",
    source,
    externalId: title,
    sourceUrl: `https://events.example.ac.uk/whats-on/${encodeURIComponent(title)}`,
    eventType,
  }
  return Object.entries(values).map(([field, value]) =>
    claim(key, field, value, {
      entityType: "event",
      sourceKey: source === "ics" ? "src-feed" : "src-programme",
      sourceUrl: source === "ics" ? "https://example.org/chess.ics" : PROGRAMME,
      sourceType: source === "ics" ? "ics_feed" : "uni_events_api",
    }),
  )
}

const keys = {
  society: eventKey("ics", "simul"),
  university: eventKey("uni_events_api", "lantern"),
  universityBySociety: eventKey("uni_events_api", "open-board"),
}

async function seed(t: TestConvex) {
  await t.mutation(internal.ingest.claims.ingest, {
    claims: [
      claim("org-chess", "name", "CU Chess Club"),
      claim("org-chess", "level", "university"),
      claim("org-chess", "orgType", "society"),
      claim("org-chess", "categories", ["hobbies_games"]),
    ],
  })
  await t.mutation(internal.ingest.claims.ingest, {
    claims: [
      ...event(keys.society, "ics", "Open simul", NOW + 2 * DAY, "social"),
      ...event(keys.university, "uni_events_api", "Lantern lecture", NOW + 3 * DAY, "talk"),
      // The programme lists a society's own event: that society's, not the University's.
      ...event(keys.universityBySociety, "uni_events_api", "Open board night", NOW + 4 * DAY),
    ],
  })
  await t.mutation(internal.ingest.relationships.setEventOrganisers, {
    events: [keys.society, keys.universityBySociety].map((key) => ({
      eventKey: key,
      organisers: [{ orgKey: "org-chess", role: "organiser" as const }],
    })),
  })
}

const window = { from: NOW, to: NOW + 30 * DAY }

describe("University listings (ENG-24)", () => {
  test("listed by default and flagged; a society's event from the programme stays the society's", async () => {
    const t = newTest()
    await seed(t)
    const listed = await t.query(api.events.list, window)
    expect(listed.map((e) => [e.title, e.fromUniversity])).toEqual([
      ["Open simul", false],
      ["Lantern lecture", true],
      ["Open board night", false],
    ])
    const lecture = listed.find((e) => e.fromUniversity)
    expect(lecture?.organisers).toEqual([])
    expect(lecture?.hosting).toBe("hosts")
  })

  test("`hide` leaves the University's listings out; `only` lists nothing else", async () => {
    const t = newTest()
    await seed(t)
    const hidden = await t.query(api.events.list, { ...window, university: "hide" })
    expect(hidden.map((e) => e.title)).toEqual(["Open simul", "Open board night"])
    const only = await t.query(api.events.list, { ...window, university: "only" })
    expect(only.map((e) => e.title)).toEqual(["Lantern lecture"])
    // Narrowed further by type like any other event.
    expect(
      await t.query(api.events.list, { ...window, university: "only", eventTypes: ["social"] }),
    ).toEqual([])
  })

  test("category and college filters never match an event with no organiser card", async () => {
    const t = newTest()
    await seed(t)
    const games = await t.query(api.events.list, { ...window, categories: ["hobbies_games"] })
    expect(games.map((e) => e.title)).toEqual(["Open simul", "Open board night"])
    expect(
      await t.query(api.events.list, {
        ...window,
        university: "only",
        categories: ["hobbies_games"],
      }),
    ).toEqual([])
    const college = await t.query(api.events.list, { ...window, collegeKeys: ["org-trinity"] })
    expect(college.some((e) => e.fromUniversity)).toBe(false)
  })

  test("the details, the 404 gate and a society's page agree", async () => {
    const t = newTest()
    await seed(t)
    const details = await t.query(api.events.get, { key: keys.university })
    expect(details?.fromUniversity).toBe(true)
    expect(details?.source).toBe("uni_events_api")
    expect(details?.sourceUrl).toBe("https://events.example.ac.uk/whats-on/Lantern%20lecture")
    expect(await t.query(api.events.exists, { key: keys.university })).toBe(true)
    expect((await t.query(api.events.get, { key: keys.universityBySociety }))?.fromUniversity).toBe(
      false,
    )
    const page = await t.query(api.orgs.getBySlug, { slug: "chess" })
    expect(page?.events.map((e) => [e.title, e.fromUniversity])).toEqual([
      ["Open simul", false],
      ["Open board night", false],
    ])
  })
})

/** The stored `stream` of each seeded event, by key. */
async function streams(t: TestConvex): Promise<Record<string, Doc<"events">["stream"]>> {
  const rows = await t.run((ctx) => ctx.db.query("events").collect())
  return Object.fromEntries(rows.map((row) => [row.key, row.stream]))
}

/** `count` University listings, written straight to the table (no claims):
 * a Festival-sized programme, one a minute from `startsAt`. */
async function insertUniversityListings(t: TestConvex, count: number, startsAt: number) {
  await t.run(async (ctx) => {
    for (let i = 0; i < count; i++) {
      await ctx.db.insert("events", {
        key: eventKey("uni_events_api", `festival-${i}`),
        title: `Festival talk ${i}`,
        startsAt: startsAt + i * 60_000,
        allDay: false,
        organiserKeys: [],
        coHostKeys: [],
        sponsorKeys: [],
        speakers: [],
        visibility: "public",
        eventType: "talk",
        cancelled: false,
        status: "confirmed",
        source: "uni_events_api",
        externalId: `festival-${i}`,
        sourceUrl: `https://events.example.ac.uk/whats-on/festival-${i}`,
        hosting: "hosts",
        lastSeenAt: NOW,
        stream: "university",
        confidence: 0.9,
        meta: {},
        createdAt: NOW,
        updatedAt: NOW,
      })
    }
  })
}

describe("Indexed listing stream (ENG-31)", () => {
  test("stored on ingest and kept in step with the organiser set", async () => {
    const t = newTest()
    await seed(t)
    expect(await streams(t)).toEqual({
      [keys.society]: "society",
      [keys.university]: "university",
      // Credited to the Chess Club after ingest: the society's now.
      [keys.universityBySociety]: "society",
    })
    // The club leaves the event: the programme's listing is the University's again.
    await t.mutation(internal.ingest.relationships.setEventOrganisers, {
      events: [{ eventKey: keys.universityBySociety, organisers: [] }],
    })
    expect((await streams(t))[keys.universityBySociety]).toBe("university")
    await t.mutation(internal.ingest.relationships.setEventOrganisers, {
      events: [
        {
          eventKey: keys.universityBySociety,
          organisers: [{ orgKey: "org-chess", role: "organiser" as const }],
        },
      ],
    })
    expect((await streams(t))[keys.universityBySociety]).toBe("society")
    // Removing the club altogether takes it off its events, and back again.
    await t.mutation(internal.ingest.purge.removeEntity, {
      entityType: "organisation",
      key: "org-chess",
    })
    expect(await streams(t)).toEqual({
      [keys.society]: "society",
      [keys.university]: "university",
      [keys.universityBySociety]: "university",
    })
  })

  test("rows from before the field are listed alike, and the daily walk backfills them", async () => {
    const t = newTest()
    await seed(t)
    const before = await Promise.all(
      [undefined, "hide" as const, "only" as const].map((university) =>
        t.query(api.events.list, { ...window, university }),
      ),
    )
    // As deployed before ENG-31: no row has a stream.
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("events").collect()) {
        await ctx.db.patch("events", row._id, { stream: undefined })
      }
    })
    expect(await t.query(internal.derive.streamBackfill, {})).toEqual({ unset: 3, atLeast: false })
    for (const [i, university] of [undefined, "hide" as const, "only" as const].entries()) {
      expect(await t.query(api.events.list, { ...window, university })).toEqual(before[i])
    }

    expect(await t.mutation(internal.derive.recomputeEvents, {})).toMatchObject({ done: true })
    expect(await t.query(internal.derive.streamBackfill, {})).toEqual({ unset: 0, atLeast: false })
    expect(await streams(t)).toEqual({
      [keys.society]: "society",
      [keys.university]: "university",
      [keys.universityBySociety]: "society",
    })
    for (const [i, university] of [undefined, "hide" as const, "only" as const].entries()) {
      expect(await t.query(api.events.list, { ...window, university })).toEqual(before[i])
    }
  })

  test("a Festival of University listings never pushes a society's event past the cap", async () => {
    const t = newTest()
    await seed(t)
    // 1,050 listings, all starting before the society events (days 2 and 4).
    await insertUniversityListings(t, 1_050, NOW + DAY)

    const all = await t.query(api.events.list, window)
    expect(all).toHaveLength(1_000)
    const societies = all.filter((e) => !e.fromUniversity).map((e) => e.title)
    expect(societies).toEqual(["Open simul", "Open board night"])
    // By start time; the University fills the 998 places left, earliest first.
    expect(all.map((e) => e.startsAt)).toEqual(all.map((e) => e.startsAt).sort((a, b) => a - b))
    const university = all.filter((e) => e.fromUniversity)
    expect(university[university.length - 1]?.title).toBe("Festival talk 997")

    const hidden = await t.query(api.events.list, { ...window, university: "hide" })
    expect(hidden.map((e) => e.title)).toEqual(["Open simul", "Open board night"])
    const only = await t.query(api.events.list, { ...window, university: "only" })
    expect(only).toHaveLength(1_000)
    expect(only.every((e) => e.fromUniversity)).toBe(true)
  })
})
