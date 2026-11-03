import { describe, expect, test } from "bun:test"
import { eventKey } from "../lib/keys"
import { api, internal } from "./_generated/api"
import type { ClaimInput } from "./ingest/claims"
import { newTest, signedInAs, type TestConvex } from "./lib/harness.testing"

/**
 * The talks boundary in the public events API (owner decision G1,
 * lib/talks-boundary.ts): a talks.cam-derived society event is left out of
 * `events.list` unless asked for, and `events.locate` sends its page under
 * /talks. All data here is invented.
 */

const NOW = Date.now()
const DAY = 86_400_000

function claim(
  entityKey: string,
  field: string,
  value: unknown,
  entityType = "event",
  sourceUrl = "https://example.org/",
): ClaimInput {
  return {
    entityType: entityType as ClaimInput["entityType"],
    entityKey,
    field,
    value,
    evidence: "primary",
    method: "parser",
    extractor: "test",
    sourceKey: "src-test",
    sourceUrl,
    sourceType: "society_website",
    retrievedAt: NOW - 60_000,
  }
}

const KEYS = {
  plain: eventKey("ics", "plain"),
  series: eventKey("talks_cam", "series"),
  linked: eventKey("ics", "linked"),
  described: eventKey("ics", "described"),
  /** Its own page was once read as on talks.cam, as `takes_part`; a newer
   * verdict says it hosts, and the projection drops `externalUrl` — but the
   * stored value stays (claims are patches). */
  hosted: eventKey("ics", "hosted"),
  /** Read from a society's calendar; one field's value came from talks.cam
   * (a duplicate merged into it). */
  merged: eventKey("camdram", "merged"),
}

/** Every key the boundary must keep under /talks. */
const TALKS_KEYS = [KEYS.series, KEYS.linked, KEYS.described, KEYS.hosted, KEYS.merged]

async function seed(t: TestConvex) {
  await t.mutation(internal.ingest.claims.ingest, {
    claims: [
      claim("org-astro", "name", "Invented Astronomy Society", "organisation"),
      claim("org-astro", "level", "university", "organisation"),
    ],
  })
  const event = (
    key: string,
    title: string,
    startsAt: number,
    fields: {
      source: string
      sourceUrl: string
      description?: string
      hosting?: string
      externalUrl?: string
    },
  ) =>
    Object.entries({ title, startsAt, visibility: "public", externalId: title, ...fields }).map(
      ([field, value]) => claim(key, field, value),
    )
  await t.mutation(internal.ingest.claims.ingest, {
    claims: [
      ...event(KEYS.plain, "Star party", NOW + DAY, {
        source: "ics",
        sourceUrl: "https://example.org/astro.ics",
      }),
      ...event(KEYS.series, "Invented seminar on comets", NOW + 2 * DAY, {
        source: "talks_cam",
        sourceUrl: "https://talks.cam.ac.uk/talk/index/1",
      }),
      ...event(KEYS.linked, "Invented lecture on moons", NOW + 3 * DAY, {
        source: "ics",
        sourceUrl: "https://talks.cam.ac.uk/show/ics/2",
      }),
      ...event(KEYS.described, "Invented colloquium", NOW + 4 * DAY, {
        source: "ics",
        sourceUrl: "https://example.org/colloquium",
        description: "Details at https://www.talks.cam.ac.uk/talk/index/3",
      }),
      ...event(KEYS.hosted, "Invented star talk", NOW + 5 * DAY, {
        source: "ics",
        sourceUrl: "https://example.org/stars",
        hosting: "hosts",
        externalUrl: "https://talks.cam.ac.uk/talk/index/4",
      }),
      ...event(KEYS.merged, "Invented nebula evening", NOW + 6 * DAY, {
        source: "camdram",
        sourceUrl: "https://www.camdram.net/shows/invented-nebula",
      }),
      claim(
        KEYS.merged,
        "description",
        "An invented abstract.",
        "event",
        "https://talks.cam.ac.uk/talk/index/5",
      ),
    ],
  })
  await t.mutation(internal.ingest.relationships.setEventOrganisers, {
    events: Object.values(KEYS).map((key) => ({
      eventKey: key,
      organisers: [{ orgKey: "org-astro", role: "organiser" as const }],
    })),
  })
}

const window = { from: NOW, to: NOW + 30 * DAY }

describe("events.list and the talks boundary", () => {
  test("leaves talks.cam-derived events out by default, for every viewer and filter", async () => {
    const t = newTest()
    await seed(t)
    const titles = async (args: Record<string, unknown> = {}) =>
      (await t.query(api.events.list, { ...window, ...args })).map((event) => event.title)
    expect(await titles()).toEqual(["Star party"])
    expect(await titles({ orgKey: "org-astro" })).toEqual(["Star party"])
    expect(await titles({ talksCam: "exclude" })).toEqual(["Star party"])
    const cam = await signedInAs(t, "xy789@cam.ac.uk")
    const camTitles = (await cam.query(api.events.list, window)).map((event) => event.title)
    expect(camTitles).toEqual(["Star party"])
  })

  test("returns them only when asked: `only` (the browser's add-in) or `include`", async () => {
    const t = newTest()
    await seed(t)
    const only = await t.query(api.events.list, { ...window, talksCam: "only" })
    expect(only.map((event) => event.key)).toEqual(TALKS_KEYS)
    expect(only.every((event) => event.talksDerived)).toBe(true)
    const all = await t.query(api.events.list, {
      ...window,
      talksCam: "include",
      orgKey: "org-astro",
    })
    expect(all).toHaveLength(6)
  })

  test("the society profile's upcoming events leave them out, on the server", async () => {
    const t = newTest()
    await seed(t)
    const page = await t.query(api.orgs.getBySlug, { slug: "astro" })
    expect(page?.events.map((event) => event.key)).toEqual([KEYS.plain])
  })
})

describe("one verdict on both sides of the boundary", () => {
  test("locate, get and list agree for every event, so no page redirects back", async () => {
    // The proxy's `locate` and the page's `talksDerived` must give one answer
    // (review of 2026-11-02): were they to differ, /events/<k> → 308 →
    // /talks/events/<k> → 308 → /events/<k> for ever.
    const t = newTest()
    await seed(t)
    const listed = new Map(
      (await t.query(api.events.list, { ...window, talksCam: "include" })).map((event) => [
        event.key,
        event.talksDerived,
      ]),
    )
    for (const key of Object.values(KEYS)) {
      const side = await t.query(api.events.locate, { key })
      const event = await t.query(api.events.get, { key })
      expect(event).not.toBeNull()
      expect(event?.talksDerived).toBe(side === "talks")
      expect(listed.get(key)).toBe(side === "talks")
      expect(side).toBe(TALKS_KEYS.includes(key) ? "talks" : "event")
    }
    // The stale talks.cam page is not shown (it hosts now), yet it decides.
    const hosted = await t.query(api.events.get, { key: KEYS.hosted })
    expect(hosted?.externalUrl).toBeUndefined()
    expect(hosted?.talksDerived).toBe(true)
  })
})

describe("the request form's event label", () => {
  test("names an ordinary event, never a talks.cam-derived or unknown one", async () => {
    // The form at /request reads only this (review of 2026-11-03,
    // g1-client-fetch): no talks.cam text crosses the wire outside /talks.
    const t = newTest()
    await seed(t)
    expect(await t.query(api.events.requestLabel, { key: KEYS.plain })).toEqual({
      title: "Star party",
    })
    for (const key of TALKS_KEYS) {
      expect(await t.query(api.events.requestLabel, { key })).toEqual({ title: null })
    }
    expect(await t.query(api.events.requestLabel, { key: eventKey("ics", "never-seen") })).toEqual({
      title: null,
    })
  })
})

describe("a society's connections", () => {
  test("never link a talks.cam page; an edge seen only there keeps its row, unlinked", async () => {
    const t = newTest()
    await seed(t)
    await t.mutation(internal.ingest.claims.ingest, {
      claims: [
        claim("org-optics", "name", "Invented Optics Society", "organisation"),
        claim("org-optics", "level", "university", "organisation"),
      ],
    })
    await t.mutation(internal.ingest.relationships.setEventOrganisers, {
      events: [KEYS.series, KEYS.plain].map((eventKey) => ({
        eventKey,
        organisers: [
          { orgKey: "org-astro", role: "organiser" as const },
          { orgKey: "org-optics", role: "co_host" as const },
        ],
      })),
    })
    const page = await t.query(api.orgs.getBySlug, { slug: "astro" })
    const edge = page?.relationships.find((row) => row.counterpart.key === "org-optics")
    expect(edge).toBeDefined()
    expect(edge?.evidence.map((entry) => entry.sourceUrl)).toEqual([
      "https://example.org/astro.ics",
    ])
    expect(JSON.stringify(page)).not.toContain("talks.cam.ac.uk")
  })

  test("an edge seen only on talks.cam pages is left out (G1)", async () => {
    const t = newTest()
    await seed(t)
    await t.mutation(internal.ingest.claims.ingest, {
      claims: [
        claim("org-comets", "name", "Invented Comet Club", "organisation"),
        claim("org-comets", "level", "university", "organisation"),
      ],
    })
    await t.mutation(internal.ingest.relationships.setEventOrganisers, {
      events: [
        {
          eventKey: KEYS.series,
          organisers: [
            { orgKey: "org-astro", role: "organiser" as const },
            { orgKey: "org-comets", role: "co_host" as const },
          ],
        },
      ],
    })
    for (const slug of ["astro", "comets"]) {
      const page = await t.query(api.orgs.getBySlug, { slug })
      expect(page).not.toBeNull()
      expect(page?.relationships.map((row) => row.counterpart.slug)).not.toContain(
        slug === "astro" ? "comets" : "astro",
      )
    }
  })
})

describe("events.locate", () => {
  test("names the side of the boundary an event's page is on", async () => {
    const t = newTest()
    await seed(t)
    expect(await t.query(api.events.locate, { key: KEYS.plain })).toBe("event")
    for (const key of TALKS_KEYS) {
      expect(await t.query(api.events.locate, { key })).toBe("talks")
    }
    expect(await t.query(api.events.locate, { key: eventKey("ics", "never") })).toBe("missing")
  })
})
