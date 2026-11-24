import { describe, expect, test } from "bun:test"
import { addDays, londonIsoDate, londonMidnight } from "../lib/calendar"
import { eventKey } from "../lib/keys"
import { api, internal } from "./_generated/api"
import type { ClaimInput } from "./ingest/claims"
import {
  type ItemLocationInput,
  LOCATION_RETENTION_MS,
  MAX_ORGANISERS_EXPANDED,
  venueOsmUrl,
} from "./ingest/locations"
import { newTest, signedInAs, type TestConvex, withEnv } from "./lib/harness.testing"
import { placeLabel } from "./lib/locations"
import { talkKey } from "./lib/talks"

/**
 * Item locations and the map (docs/locations-and-map.md §1): the pipeline
 * routes (`locations/pending`, `venues/all`, `locations/batch`,
 * `locations/summary`), the prune, `locations.forItem`, `map.day`,
 * `map.weekCounts` and the broker's coverage. All data here is invented.
 */

const NOW = Date.now()
const DAY = 86_400_000
const HOUR = 3_600_000
/** A London day two days ahead, and an instant inside it. */
const DATE = londonIsoDate(NOW + 2 * DAY)
const NOON = londonMidnight(DATE) + 12 * HOUR

function claim(
  entityType: ClaimInput["entityType"],
  entityKey: string,
  field: string,
  value: unknown,
  sourceType: ClaimInput["sourceType"] = "society_website",
  sourceUrl = "https://example.org/",
): ClaimInput {
  return {
    entityType,
    entityKey,
    field,
    value,
    evidence: sourceType === "society_website" ? "primary" : "secondary",
    method: "parser",
    extractor: "test",
    sourceKey: `src-${sourceType}`,
    sourceUrl,
    sourceType,
    retrievedAt: NOW - 60_000,
  }
}

const KEYS = {
  lecture: eventKey("ics", "lecture"),
  festival: eventKey("ics", "festival"),
  camOnly: eventKey("ics", "cam-only"),
  zoom: eventKey("ics", "zoom"),
  members: eventKey("ics", "members"),
  cancelled: eventKey("ics", "cancelled"),
  talksCam: eventKey("talks_cam", "series"),
}
const VENUES = {
  ini: "ven-isaac-newton-institute",
  market: "ven-market-square",
  nocoords: "ven-somewhere-without-coordinates",
}
const TALKS = {
  cam: talkKey("talks_cam", "101"),
  dept: talkKey("dept_ics", "uid-202@hist.cam.ac.uk"),
}

async function seedVenues(t: TestConvex) {
  const osm = (key: string, field: string, value: unknown) =>
    claim("venue", key, field, value, "osm_nominatim", "https://www.openstreetmap.org/way/1")
  await t.mutation(internal.ingest.claims.ingest, {
    claims: [
      osm(VENUES.ini, "name", "Isaac Newton Institute"),
      osm(VENUES.ini, "address", "20 Clarkson Road, Cambridge CB3 0EH"),
      osm(VENUES.ini, "lat", 52.2101),
      osm(VENUES.ini, "lng", 0.0912),
      claim(
        "venue",
        VENUES.ini,
        "googlePlaceId",
        "ChIJinvented_place-id",
        "google_places",
        "https://www.google.com/maps/place/?q=place_id:ChIJinvented_place-id",
      ),
      osm(VENUES.market, "name", "Market Square"),
      osm(VENUES.market, "lat", 52.2053),
      osm(VENUES.market, "lng", 0.1192),
      osm(VENUES.nocoords, "name", "Somewhere without coordinates"),
    ],
  })
}

async function seedEvents(t: TestConvex) {
  await t.mutation(internal.ingest.claims.ingest, {
    claims: [
      claim("organisation", "org-maths", "name", "Invented Maths Society"),
      claim("organisation", "org-maths", "level", "university"),
    ],
  })
  const event = (
    key: string,
    title: string,
    startsAt: number,
    extra: Record<string, unknown> = {},
  ) =>
    Object.entries({
      title,
      startsAt,
      visibility: "public",
      source: "ics",
      sourceUrl: `https://example.org/${title.replace(/\W+/g, "-")}`,
      externalId: title,
      ...extra,
    }).map(([field, value]) => claim("event", key, field, value))
  await t.mutation(internal.ingest.claims.ingest, {
    claims: [
      ...event(KEYS.lecture, "Invented lecture on primes", NOON, {
        endsAt: NOON + HOUR,
        venueText: "Seminar Room 1, INI",
        description: "An invented abstract about primes.",
      }),
      // A three-day festival that started the day before DATE.
      ...event(KEYS.festival, "Invented maths festival", NOON - DAY, {
        endsAt: NOON + 2 * DAY,
        venueText: "Around town",
      }),
      ...event(KEYS.camOnly, "Invented members' social", NOON + 2 * HOUR, {
        visibility: "cam_only",
        venueText: "The usual pub",
      }),
      ...event(KEYS.zoom, "Invented online reading group", NOON + 3 * HOUR, {
        venueText: "Zoom",
      }),
      ...event(KEYS.members, "Invented members-only dinner", NOON + 4 * HOUR, {
        visibility: "members_only",
      }),
      ...event(KEYS.cancelled, "Invented cancelled talk", NOON + 5 * HOUR, { cancelled: true }),
      ...event(KEYS.talksCam, "Invented talks.cam seminar", NOON + 6 * HOUR, {
        source: "talks_cam",
        sourceUrl: "https://talks.cam.ac.uk/talk/index/9",
        venueText: "MR2, CMS",
      }),
    ],
  })
  await t.mutation(internal.ingest.relationships.setEventOrganisers, {
    events: Object.values(KEYS).map((key) => ({
      eventKey: key,
      organisers: [{ orgKey: "org-maths", role: "organiser" as const }],
    })),
  })
}

async function seedTalks(t: TestConvex) {
  await t.mutation(internal.ingest.talks.departmentsUpsert, {
    departments: [
      {
        key: "dept-history",
        slug: "history",
        name: "Faculty of History",
        shortName: "History",
        school: "arts_humanities",
        website: "https://www.hist.cam.ac.uk",
        aliases: [],
      },
    ],
  })
  const base = {
    speakers: [{ name: "Invented Speaker" }],
    departmentKeys: ["dept-history"],
    allDay: false,
    online: false,
    kind: "seminar" as const,
    cancelled: false,
    retrievedAt: NOW,
  }
  await t.mutation(internal.ingest.talks.batch, {
    runId: "run-1",
    talks: [
      {
        ...base,
        key: TALKS.cam,
        sourceType: "talks_cam",
        source: "talks_cam",
        externalId: "101",
        url: "https://talks.cam.ac.uk/talk/index/101",
        sourceUrl: "https://talks.cam.ac.uk/api/talks",
        title: "Invented talks.cam talk",
        series: "Invented History Seminar",
        startsAt: NOON + HOUR,
        endsAt: NOON + 2 * HOUR,
        venue: "Room 12, Faculty of History",
        abstract: "An invented abstract.",
      },
      {
        ...base,
        key: TALKS.dept,
        sourceType: "dept_ics",
        source: "dept-history#0",
        externalId: "uid-202@hist.cam.ac.uk",
        url: "https://www.hist.cam.ac.uk/events/202",
        sourceUrl: "https://www.hist.cam.ac.uk/events.ics",
        title: "Invented department talk",
        startsAt: NOON + 30 * 60_000,
        endsAt: NOON + 90 * 60_000,
        venue: "Seeley Library",
      },
    ],
  })
}

async function seed(t: TestConvex) {
  await seedVenues(t)
  await seedEvents(t)
  await seedTalks(t)
}

function row(overrides: Partial<ItemLocationInput> & Pick<ItemLocationInput, "itemKey">) {
  return {
    kind: "event" as const,
    startsAt: NOON,
    precision: "exact" as const,
    venueKey: VENUES.ini,
    method: "llm" as const,
    model: "gpt-6-luna",
    promptVersion: "locate_v1",
    inputHash: "h1",
    ...overrides,
  }
}

async function locateAll(t: TestConvex) {
  return await t.mutation(internal.ingest.locations.batch, {
    locations: [
      row({ itemKey: KEYS.lecture, room: "Seminar Room 1" }),
      row({
        itemKey: KEYS.festival,
        startsAt: NOON - DAY,
        precision: "area",
        venueKey: VENUES.market,
        areaLabel: "Central Cambridge",
      }),
      row({ itemKey: KEYS.camOnly, venueKey: VENUES.nocoords, precision: "building" }),
      row({ itemKey: KEYS.zoom, precision: "online", venueKey: undefined, method: "alias" }),
      row({ itemKey: KEYS.talksCam, room: "MR2" }),
      row({
        kind: "talk",
        itemKey: TALKS.cam,
        startsAt: NOON + HOUR,
        room: "Room 12",
      }),
    ],
  })
}

describe("locations/batch", () => {
  test("inserts, then reports unchanged, then updates a changed row", async () => {
    const t = newTest()
    await seed(t)
    expect(await locateAll(t)).toEqual({ inserted: 6, updated: 0, unchanged: 0, rejected: [] })
    expect(await locateAll(t)).toEqual({ inserted: 0, updated: 0, unchanged: 6, rejected: [] })
    const changed = await t.mutation(internal.ingest.locations.batch, {
      locations: [row({ itemKey: KEYS.lecture, inputHash: "h2" })],
    })
    expect(changed).toEqual({ inserted: 0, updated: 1, unchanged: 0, rejected: [] })
    // Written whole: the room the first row had is gone.
    const stored = await t.run(async (ctx) =>
      ctx.db
        .query("itemLocations")
        .withIndex("by_kind_item", (q) => q.eq("kind", "event").eq("itemKey", KEYS.lecture))
        .unique(),
    )
    expect(stored?.room).toBeUndefined()
    expect(stored?.inputHash).toBe("h2")
  })

  test("rejects bad keys, missing venues and items, and text over the limits", async () => {
    const t = newTest()
    await seed(t)
    const result = await t.mutation(internal.ingest.locations.batch, {
      locations: [
        row({ itemKey: "talk-abc" }),
        row({ itemKey: KEYS.lecture, venueKey: "Isaac Newton" }),
        row({ itemKey: KEYS.lecture, venueKey: "ven-nowhere" }),
        row({ itemKey: KEYS.lecture, venueKey: undefined }),
        row({ itemKey: KEYS.zoom, precision: "online" }),
        row({ itemKey: KEYS.festival, precision: "area" }),
        row({ itemKey: KEYS.lecture, room: "x".repeat(121) }),
        row({ itemKey: KEYS.lecture, note: "two\nlines" }),
        row({ itemKey: KEYS.lecture, inputHash: "" }),
        row({ itemKey: eventKey("ics", "never-posted") }),
        row({ itemKey: KEYS.cancelled }),
        row({ itemKey: KEYS.cancelled }),
      ],
    })
    expect(result.inserted).toBe(1)
    expect(result.rejected.map((r) => r.reason)).toEqual([
      "itemKey: not a event key",
      "venueKey: not a venue key",
      "venueKey: venue ven-nowhere does not exist",
      "venueKey: required for precision exact",
      "venueKey: not allowed for precision online",
      "areaLabel: required for precision area",
      "room: must be one line of 1..120 characters",
      "note: must be one line of 1..200 characters",
      "inputHash: must be 1..128 characters of [A-Za-z0-9:_-]",
      "no event with this key",
      "duplicate item in this batch",
    ])
  })

  test("a film row has no venue: refused with one, placed on the map's Films list", async () => {
    const t = newTest()
    await seed(t)
    const result = await t.mutation(internal.ingest.locations.batch, {
      locations: [
        row({ itemKey: KEYS.zoom, precision: "film" }),
        row({ itemKey: KEYS.lecture, precision: "film", venueKey: undefined, method: "source" }),
      ],
    })
    expect(result.inserted).toBe(1)
    expect(result.rejected.map((r) => r.reason)).toEqual([
      "venueKey: not allowed for precision film",
    ])
    expect(await t.query(api.locations.forItem, { kind: "event", itemKey: KEYS.lecture })).toEqual({
      precision: "film",
      venue: null,
    })
    const day = await t.query(api.map.day, { date: DATE, talks: "exclude" })
    expect(day.items.find((item) => item.key === KEYS.lecture)).toMatchObject({
      precision: "film",
      venueKey: null,
      placeLabel: "Film",
    })
    expect(day.counts.films).toBe(1)
  })

  test("refuses more than 500 rows", async () => {
    const t = newTest()
    const locations = Array.from({ length: 501 }, (_, i) => row({ itemKey: `evt-${i}` }))
    await expect(t.mutation(internal.ingest.locations.batch, { locations })).rejects.toThrow(
      /Batch too large/,
    )
  })
})

describe("locations/pending and venues/all", () => {
  test("pages events (no members_only, no cancelled), then listed talks, with stored hashes", async () => {
    const t = newTest()
    await seed(t)
    await locateAll(t)
    const window = { from: NOW, to: NOW + 10 * DAY }
    const items = []
    let cursor: string | null = null
    for (let call = 0; call < 10; call++) {
      const page: Awaited<ReturnType<typeof t.query<typeof internal.ingest.locations.pending>>> =
        await t.query(internal.ingest.locations.pending, { ...window, cursor, limit: 2 })
      items.push(...page.page)
      cursor = page.continueCursor
      if (page.isDone) break
    }
    expect(items.map((item) => item.itemKey).sort()).toEqual(
      [
        KEYS.festival,
        KEYS.lecture,
        KEYS.camOnly,
        KEYS.zoom,
        KEYS.talksCam,
        TALKS.cam,
        TALKS.dept,
      ].sort(),
    )
    const lecture = items.find((item) => item.itemKey === KEYS.lecture)
    expect(lecture).toMatchObject({
      kind: "event",
      title: "Invented lecture on primes",
      venueText: "Seminar Room 1, INI",
      organisers: ["Invented Maths Society"],
      sourceType: "ics",
      stored: { inputHash: "h1", precision: "exact", venueKey: VENUES.ini, startsAt: NOON },
    })
    const talk = items.find((item) => item.itemKey === TALKS.cam)
    expect(talk).toMatchObject({
      kind: "talk",
      venue: "Room 12, Faculty of History",
      online: false,
      description: "An invented abstract.",
      organisers: ["Faculty of History", "Invented History Seminar"],
      sourceType: "talks_cam",
    })
    expect(items.find((item) => item.itemKey === TALKS.dept)?.stored).toBeUndefined()
  })

  test("carries the organisers' usual places: college, sessions' and events' venues, departments", async () => {
    const t = newTest()
    await seed(t)
    await t.mutation(internal.ingest.claims.ingest, {
      claims: [
        claim("organisation", "org-invented-college", "name", "Invented College"),
        claim("organisation", "org-invented-college", "orgType", "college"),
        claim("organisation", "org-maths", "collegeKeys", ["org-invented-college"]),
        claim("session", "ses-maths-weekly", "orgKey", "org-maths"),
        claim("session", "ses-maths-weekly", "title", "Weekly problem session"),
        claim("session", "ses-maths-weekly", "venueKey", VENUES.ini),
        claim("session", "ses-maths-social", "orgKey", "org-maths"),
        claim("session", "ses-maths-social", "title", "Social"),
        claim("session", "ses-maths-social", "venueText", "The Invented Arms"),
      ],
    })
    const items = []
    let cursor: string | null = null
    for (let call = 0; call < 10; call++) {
      const page: Awaited<ReturnType<typeof t.query<typeof internal.ingest.locations.pending>>> =
        await t.query(internal.ingest.locations.pending, { from: NOW, to: NOW + 10 * DAY, cursor })
      items.push(...page.page)
      cursor = page.continueCursor
      if (page.isDone) break
    }
    const lecture = items.find((item) => item.itemKey === KEYS.lecture)
    expect(lecture?.organiserPlaces).toEqual([
      "Invented College",
      "Isaac Newton Institute",
      "The Invented Arms",
      // Then the places its own latest events name (online ones left out),
      // most used first, ties by name, up to six in all.
      "Around town",
      "MR2, CMS",
      "Seminar Room 1, INI",
    ])
    const talk = items.find((item) => item.itemKey === TALKS.dept)
    expect(talk?.organiserPlaces).toEqual(["Faculty of History"])
  })

  test("works out the usual places of at most MAX_ORGANISERS_EXPANDED organisers per call", async () => {
    const t = newTest()
    const count = MAX_ORGANISERS_EXPANDED + 5
    const orgs = Array.from(
      { length: count },
      (_, i) => `org-invented-${String(i).padStart(2, "0")}`,
    )
    const events = orgs.map((_, i) => eventKey("ics", `cap-${i}`))
    await t.mutation(internal.ingest.claims.ingest, {
      claims: orgs.flatMap((org, i) => [
        claim("organisation", org, "name", `Invented Society ${i}`),
        claim("organisation", org, "level", "university"),
        claim("session", `ses-${org}`, "orgKey", org),
        claim("session", `ses-${org}`, "title", "Weekly meeting"),
        claim("session", `ses-${org}`, "venueText", `Invented Hall ${i}`),
      ]),
    })
    await t.mutation(internal.ingest.claims.ingest, {
      claims: events.flatMap((key, i) =>
        Object.entries({
          title: `Invented meeting ${i}`,
          startsAt: NOON + i * 60_000,
          visibility: "public",
          source: "ics",
          sourceUrl: `https://example.org/cap-${i}`,
          externalId: `cap-${i}`,
        }).map(([field, value]) => claim("event", key, field, value)),
      ),
    })
    await t.mutation(internal.ingest.relationships.setEventOrganisers, {
      events: events.map((eventKey, i) => ({
        eventKey,
        organisers: [{ orgKey: orgs[i] as string, role: "organiser" as const }],
      })),
    })
    const page = await t.query(internal.ingest.locations.pending, {
      from: NOW,
      to: NOW + 10 * DAY,
      cursor: null,
    })
    const hinted = page.page.filter((item) => item.organiserPlaces !== undefined)
    expect(page.page).toHaveLength(count)
    expect(hinted).toHaveLength(MAX_ORGANISERS_EXPANDED)
    expect(hinted[0]?.organiserPlaces).toEqual(["Invented Hall 0"])
  })

  test("also offers a multi-day event that started before the window and still runs", async () => {
    const t = newTest()
    await seed(t)
    // From the lecture's day: the festival started the day before.
    const window = { from: londonMidnight(DATE), to: londonMidnight(DATE) + 10 * DAY }
    const keys: string[] = []
    let cursor: string | null = null
    for (let call = 0; call < 10; call++) {
      const page: Awaited<ReturnType<typeof t.query<typeof internal.ingest.locations.pending>>> =
        await t.query(internal.ingest.locations.pending, { ...window, cursor })
      keys.push(...page.page.map((item) => item.itemKey))
      cursor = page.continueCursor
      if (page.isDone) break
    }
    expect(keys.filter((key) => key === KEYS.festival)).toHaveLength(1)
    expect(keys).toContain(KEYS.lecture)
  })

  test("rejects a window over 186 days and a forged cursor", async () => {
    const t = newTest()
    await expect(
      t.query(internal.ingest.locations.pending, { from: 0, to: 200 * DAY }),
    ).rejects.toThrow(/186 days/)
    await expect(
      t.query(internal.ingest.locations.pending, { from: 0, to: DAY, cursor: "nope" }),
    ).rejects.toThrow(/Invalid cursor/)
  })

  test("venues/all lists every venue with its place id", async () => {
    const t = newTest()
    await seedVenues(t)
    const page = await t.query(internal.ingest.locations.venuesAll, {})
    expect(page.isDone).toBe(true)
    expect(page.page.map((venue) => venue.key).sort()).toEqual(Object.values(VENUES).sort())
    expect(page.page.find((venue) => venue.key === VENUES.ini)).toMatchObject({
      name: "Isaac Newton Institute",
      lat: 52.2101,
      googlePlaceId: "ChIJinvented_place-id",
      osmUrl: "https://www.openstreetmap.org/way/1",
    })
  })

  test("venueOsmUrl reads the OSM object a venue's point or name was cited to", () => {
    const osm = "https://www.openstreetmap.org/relation/42"
    expect(venueOsmUrl({ lat: { sourceUrl: osm } })).toBe(osm)
    expect(venueOsmUrl({ name: { sourceUrl: osm } })).toBe(osm)
    expect(
      venueOsmUrl({ lat: { sourceUrl: "https://api.postcodes.io/postcodes/CB23NJ" } }),
    ).toBeUndefined()
    expect(
      venueOsmUrl({ lat: { sourceUrl: "https://www.camdram.net/venues/adc" } }),
    ).toBeUndefined()
    expect(venueOsmUrl({})).toBeUndefined()
  })
})

describe("placeLabel", () => {
  test("prints the venue's display name, without its university suffix", () => {
    const row = { precision: "exact" as const, room: "Room 2" }
    expect(placeLabel(row, "Invented Hall (University of Cambridge)", null)).toBe(
      "Room 2, Invented Hall",
    )
    expect(
      placeLabel({ precision: "building" }, "Invented Hall, University of Cambridge", null),
    ).toBe("Invented Hall")
    // A name that is only the suffix stays whole.
    expect(placeLabel({ precision: "building" }, "University of Cambridge", null)).toBe(
      "University of Cambridge",
    )
  })
})

describe("locations.forItem", () => {
  test("returns the place of a visible event, with its venue", async () => {
    const t = newTest()
    await seed(t)
    await locateAll(t)
    expect(await t.query(api.locations.forItem, { kind: "event", itemKey: KEYS.lecture })).toEqual({
      precision: "exact",
      room: "Seminar Room 1",
      venue: {
        key: VENUES.ini,
        name: "Isaac Newton Institute",
        aliases: [],
        address: "20 Clarkson Road, Cambridge CB3 0EH",
        lat: 52.2101,
        lng: 0.0912,
        googlePlaceId: "ChIJinvented_place-id",
      },
    })
    const online = await t.query(api.locations.forItem, { kind: "event", itemKey: KEYS.zoom })
    expect(online).toEqual({ precision: "online", venue: null })
    const talk = await t.query(api.locations.forItem, { kind: "talk", itemKey: TALKS.cam })
    expect(talk?.room).toBe("Room 12")
    expect(await t.query(api.locations.forItem, { kind: "talk", itemKey: TALKS.dept })).toBeNull()
  })

  test("a cam_only event's place is for a verified @cam.ac.uk viewer only", async () => {
    const t = newTest()
    await seed(t)
    await locateAll(t)
    const args = { kind: "event" as const, itemKey: KEYS.camOnly }
    expect(await t.query(api.locations.forItem, args)).toBeNull()
    const cam = await signedInAs(t, "ab123@cam.ac.uk")
    expect((await cam.query(api.locations.forItem, args))?.precision).toBe("building")
  })
})

describe("map.day", () => {
  test("the default render: events only, no talks.cam text, places labelled", async () => {
    const t = newTest()
    await seed(t)
    await locateAll(t)
    const day = await t.query(api.map.day, { date: DATE, talks: "exclude" })
    expect(day.date).toBe(DATE)
    expect(day.to - day.from).toBeGreaterThanOrEqual(23 * HOUR)
    // A cancelled event is listed (flagged), as on the calendar.
    expect(day.items.map((item) => item.key)).toEqual([
      KEYS.festival,
      KEYS.lecture,
      KEYS.zoom,
      KEYS.cancelled,
    ])
    const [festival, lecture, zoom, cancelled] = day.items
    expect(cancelled).toMatchObject({ cancelled: true, precision: "unknown", placeLabel: "" })
    expect(festival).toMatchObject({
      kind: "event",
      precision: "area",
      venueKey: VENUES.market,
      placeLabel: "Central Cambridge",
      href: `/events/${KEYS.festival}`,
    })
    expect(lecture).toMatchObject({
      precision: "exact",
      venueKey: VENUES.ini,
      room: "Seminar Room 1",
      placeLabel: "Seminar Room 1, Isaac Newton Institute",
      orgLabel: "Invented Maths Society",
      eventType: "other",
      visibility: "public",
      endsAt: NOON + HOUR,
    })
    expect(zoom).toMatchObject({ precision: "online", venueKey: null, placeLabel: "Zoom" })
    expect(day.venues.map((venue) => venue.key)).toEqual([VENUES.ini, VENUES.market])
    expect(day.counts).toEqual({ events: 4, talks: 0, online: 1, unknown: 1, films: 0 })
    expect(JSON.stringify(day)).not.toContain("talks.cam")
  })

  test("items without a row are `unknown` with their raw text; talks only when asked for", async () => {
    const t = newTest()
    await seed(t)
    // G1: a bare `{date}` returns no talks at all.
    const bare = await t.query(api.map.day, { date: DATE })
    expect(bare.items.some((item) => item.kind === "talk")).toBe(false)
    const day = await t.query(api.map.day, { date: DATE, talks: "include" })
    expect(day.items.map((item) => item.key)).toEqual([
      KEYS.festival,
      KEYS.lecture,
      TALKS.dept,
      KEYS.zoom,
      KEYS.cancelled,
    ])
    expect(day.items.every((item) => item.precision === "unknown" && item.venueKey === null)).toBe(
      true,
    )
    expect(day.items.find((item) => item.key === TALKS.dept)).toMatchObject({
      kind: "talk",
      placeLabel: "Seeley Library",
      href: `/talks/${TALKS.dept}`,
      orgLabel: "History",
      talkKind: "seminar",
    })
    expect(day.venues).toEqual([])
    expect(day.counts).toEqual({ events: 4, talks: 1, online: 0, unknown: 5, films: 0 })
  })

  test("talksCam `only` returns the talks.cam talk and talks.cam-derived event, under /talks", async () => {
    const t = newTest()
    await seed(t)
    await locateAll(t)
    const day = await t.query(api.map.day, { date: DATE, talks: "include", talksCam: "only" })
    expect(day.items.map((item) => [item.kind, item.key, item.href])).toEqual([
      ["talk", TALKS.cam, `/talks/${TALKS.cam}`],
      ["event", KEYS.talksCam, `/talks/events/${KEYS.talksCam}`],
    ])
    expect(day.items[0].placeLabel).toBe("Room 12, Isaac Newton Institute")
    const noTalks = await t.query(api.map.day, { date: DATE, talks: "exclude", talksCam: "only" })
    expect(noTalks.items.map((item) => item.key)).toEqual([KEYS.talksCam])
  })

  test("a signed-in @cam.ac.uk viewer also sees cam_only events; a venue without coordinates has no pin", async () => {
    const t = newTest()
    await seed(t)
    await locateAll(t)
    const cam = await signedInAs(t, "ab123@cam.ac.uk")
    const day = await cam.query(api.map.day, { date: DATE, talks: "exclude" })
    const social = day.items.find((item) => item.key === KEYS.camOnly)
    expect(social).toMatchObject({
      visibility: "cam_only",
      precision: "building",
      venueKey: null,
      placeLabel: "Somewhere without coordinates",
    })
  })

  test("a venue far from Cambridge (an away fixture) is accepted and returned with its place", async () => {
    const t = newTest()
    await seed(t)
    const far = "ven-invented-golf-club"
    await t.mutation(internal.ingest.claims.ingest, {
      claims: [
        ["name", "Invented Golf Club"],
        ["address", "Pond Road, Woking GU22 0JZ"],
        ["lat", 51.305],
        ["lng", -0.585],
      ].map(([field, value]) =>
        claim(
          "venue",
          far,
          field as string,
          value,
          "osm_nominatim",
          "https://www.openstreetmap.org/way/9",
        ),
      ),
    })
    const result = await t.mutation(internal.ingest.locations.batch, {
      locations: [row({ itemKey: KEYS.lecture, venueKey: far })],
    })
    expect(result).toMatchObject({ inserted: 1, rejected: [] })
    const day = await t.query(api.map.day, { date: DATE, talks: "exclude" })
    const lecture = day.items.find((item) => item.key === KEYS.lecture)
    expect(lecture).toMatchObject({ venueKey: far, placeLabel: "Invented Golf Club" })
    expect(day.venues.find((venue) => venue.key === far)).toMatchObject({
      lat: 51.305,
      lng: -0.585,
    })
  })

  test("rejects a date that is not YYYY-MM-DD", async () => {
    const t = newTest()
    await expect(t.query(api.map.day, { date: "2026-02-30" })).rejects.toThrow(/YYYY-MM-DD/)
  })
})

describe("map.weekCounts", () => {
  test("counts events on every day they cover and talks on their start day", async () => {
    const t = newTest()
    await seed(t)
    const before = addDays(DATE, -1)
    const counts = await t.query(api.map.weekCounts, { from: before, days: 3 })
    expect(counts).toEqual([
      { date: before, events: 1, talks: 0 },
      // festival, lecture, zoom, the cancelled one and the talks.cam-derived
      // event (numbers are G1-safe)
      { date: DATE, events: 5, talks: 2 },
      { date: addDays(DATE, 1), events: 1, talks: 0 },
    ])
    await expect(t.query(api.map.weekCounts, { from: DATE, days: 15 })).rejects.toThrow(/1\.\.14/)
  })
})

describe("coverage and pruning", () => {
  test("locations/summary and the broker card count the next 14 days", async () => {
    const t = newTest()
    await seed(t)
    await locateAll(t)
    const summary = await t.query(internal.ingest.locations.summary, {})
    // festival, lecture, camOnly, zoom, talksCam and two talks; not the
    // cancelled or members-only events.
    expect(summary).toMatchObject({
      upcoming: 7,
      resolved: 6,
      unknown: 1,
      byPrecision: { exact: 3, building: 1, area: 1, online: 1, unknown: 0, film: 0, missing: 1 },
      truncated: false,
    })
    expect(summary.unresolvedShare).toBeCloseTo(1 / 7, 3)
    await withEnv({ BROKER_EMAILS: "broker@example.com" }, async () => {
      const broker = await signedInAs(t, "broker@example.com")
      const card = await broker.query(api.broker.overview.locationCoverage, {})
      expect(card.target).toBe(0.02)
      expect(card.unknownItems).toEqual([
        {
          kind: "talk",
          key: TALKS.dept,
          title: "Invented department talk",
          note: "Not resolved yet",
        },
      ])
    })
  })

  test("the prune deletes rows of gone items and rows older than 60 days", async () => {
    const t = newTest()
    await seed(t)
    await locateAll(t)
    await t.run(async (ctx) => {
      await ctx.db.insert("itemLocations", {
        kind: "event",
        itemKey: "evt-gone",
        startsAt: NOON,
        precision: "unknown",
        method: "llm",
        inputHash: "h",
        resolvedAt: NOW,
      })
      const lecture = await ctx.db
        .query("itemLocations")
        .withIndex("by_kind_item", (q) => q.eq("kind", "event").eq("itemKey", KEYS.lecture))
        .unique()
      if (lecture) await ctx.db.patch(lecture._id, { startsAt: NOW - LOCATION_RETENTION_MS - DAY })
    })
    const result = await t.mutation(internal.ingest.locations.prune, {})
    expect(result).toEqual({ deleted: 2, isDone: true })
    const left = await t.run(async (ctx) => ctx.db.query("itemLocations").collect())
    expect(left.length).toBe(5)
  })
})
