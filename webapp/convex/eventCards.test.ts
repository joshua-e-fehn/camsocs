import { describe, expect, test } from "bun:test"
import { eventKey } from "../lib/keys"
import { api, internal } from "./_generated/api"
import type { ClaimInput } from "./ingest/claims"
import { EVENT_CARDS_BACKFILL, eventCardOf } from "./lib/entityStore"
import { newTest, type TestConvex } from "./lib/harness.testing"

/**
 * The events' list cards (ENG-280, schema.ts `eventCardFields`): every write
 * to `events` keeps its card in line, the daily walk backfills them and then
 * records it, and the window read gives the same answers from the cards as
 * from the full events — the talks boundary (G1), withdrawn, superseded and
 * hidden rows included. Invented data only.
 */

const NOW = Date.now()
const DAY = 86_400_000
const ORG = "org-astro"
const OTHER = "org-optics"

function claim(
  entityKey: string,
  field: string,
  value: unknown,
  entityType: ClaimInput["entityType"] = "event",
  sourceUrl = "https://example.org/astro",
  sourceType: ClaimInput["sourceType"] = "society_website",
): ClaimInput {
  return {
    entityType,
    entityKey,
    field,
    value,
    evidence: "primary",
    method: "parser",
    extractor: "test",
    sourceKey: `src-${new URL(sourceUrl).hostname}`,
    sourceUrl,
    sourceType,
    retrievedAt: NOW - 60_000,
  }
}

const KEYS = {
  plain: eventKey("ics", "plain"),
  series: eventKey("talks_cam", "series"),
  described: eventKey("ics", "described"),
  /** One field read from talks.cam: talks-derived through `meta` alone. */
  merged: eventKey("camdram", "merged"),
  /** A three-day run that began before the window. */
  spanning: eventKey("ics", "spanning"),
  university: eventKey("uni_events_api", "lecture"),
  old: eventKey("ics", "old"),
}

async function seed(t: TestConvex) {
  await t.mutation(internal.ingest.claims.ingest, {
    claims: [
      claim(ORG, "name", "Invented Astronomy Society", "organisation"),
      claim(ORG, "level", "university", "organisation"),
      claim(OTHER, "name", "Invented Optics Club", "organisation"),
      claim(OTHER, "level", "university", "organisation"),
    ],
  })
  const event = (key: string, title: string, startsAt: number, fields: Record<string, unknown>) =>
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
      ...event(KEYS.described, "Invented colloquium", NOW + 3 * DAY, {
        source: "ics",
        sourceUrl: "https://example.org/colloquium",
        description: "Details at https://www.talks.cam.ac.uk/talk/index/3",
      }),
      ...event(KEYS.merged, "Invented nebula evening", NOW + 4 * DAY, {
        source: "camdram",
        sourceUrl: "https://www.camdram.net/shows/invented-nebula",
      }),
      claim(
        KEYS.merged,
        "venueText",
        "Invented Hall",
        "event",
        "https://talks.cam.ac.uk/talk/index/5",
        "talks_list",
      ),
      ...event(KEYS.spanning, "Invented star camp", NOW - DAY, {
        source: "ics",
        sourceUrl: "https://example.org/camp",
        endsAt: NOW + 2 * DAY,
      }),
      ...event(KEYS.university, "Invented public lecture", NOW + 5 * DAY, {
        source: "uni_events_api",
        sourceUrl: "https://example.org/uni/lecture",
      }),
      ...event(KEYS.old, "Invented old meeting", NOW - 500 * DAY, {
        source: "ics",
        sourceUrl: "https://example.org/old",
      }),
    ],
  })
  await t.mutation(internal.ingest.relationships.setEventOrganisers, {
    events: [KEYS.plain, KEYS.series, KEYS.described, KEYS.merged, KEYS.spanning, KEYS.old].map(
      (key) => ({ eventKey: key, organisers: [{ orgKey: ORG, role: "organiser" as const }] }),
    ),
  })
}

/** Every event has exactly its card, and no card outlives its event. */
async function expectCardsInLine(t: TestConvex) {
  await t.run(async (ctx) => {
    const events = await ctx.db.query("events").collect()
    const cards = await ctx.db.query("eventCards").collect()
    const stored = cards
      .map(({ _id, _creationTime, ...card }) => card)
      .sort((a, b) => a.key.localeCompare(b.key))
    const expected = events.map(eventCardOf).sort((a, b) => a.key.localeCompare(b.key))
    expect(stored).toEqual(expected)
  })
}

async function setReady(t: TestConvex, ready: boolean) {
  await t.run(async (ctx) => {
    const row = await ctx.db
      .query("projectionBackfills")
      .withIndex("by_name", (q) => q.eq("name", EVENT_CARDS_BACKFILL))
      .unique()
    if (ready && !row) {
      await ctx.db.insert("projectionBackfills", { name: EVENT_CARDS_BACKFILL, completedAt: NOW })
    }
    if (!ready && row) await ctx.db.delete("projectionBackfills", row._id)
  })
}

/** What every caller of the window read answers, for comparing the two paths. */
async function answers(t: TestConvex) {
  const window = { from: NOW, to: NOW + 30 * DAY }
  const date = new Date(NOW + DAY).toISOString().slice(0, 10)
  return {
    exclude: await t.query(api.events.list, window),
    include: await t.query(api.events.list, { ...window, talksCam: "include" }),
    only: await t.query(api.events.list, { ...window, talksCam: "only" }),
    hide: await t.query(api.events.list, { ...window, university: "hide" }),
    uni: await t.query(api.events.list, { ...window, university: "only" }),
    org: await t.query(api.events.list, { ...window, orgKey: ORG, talksCam: "include" }),
    restricted: await t.query(api.events.restrictedCount, window),
    day: await t.query(api.map.day, { date }),
    dayTalks: await t.query(api.map.day, { date, talksCam: "only" }),
    week: await t.query(api.map.weekCounts, { from: date, days: 7 }),
  }
}

async function expectSameBothWays(t: TestConvex) {
  await setReady(t, false)
  const fromEvents = await answers(t)
  await setReady(t, true)
  const fromCards = await answers(t)
  expect(fromCards).toEqual(fromEvents)
  return fromCards
}

const keysOf = (items: { key: string }[]) => items.map((item) => item.key).sort()

describe("event cards", () => {
  test("ingest writes a card per event, with the talks verdict over every field", async () => {
    const t = newTest()
    await seed(t)
    await expectCardsInLine(t)
    const cards = await t.run((ctx) => ctx.db.query("eventCards").collect())
    const talks = cards.filter((card) => card.talksDerived).map((card) => card.key)
    expect(talks.sort()).toEqual([KEYS.described, KEYS.merged, KEYS.series].sort())
    for (const card of cards) {
      expect(card).not.toHaveProperty("meta")
      expect(card).not.toHaveProperty("description")
    }
  })

  test("the window read answers the same from cards as from events (G1 included)", async () => {
    const t = newTest()
    await seed(t)
    const shown = await expectSameBothWays(t)
    expect(keysOf(shown.exclude)).toEqual([KEYS.plain, KEYS.spanning, KEYS.university].sort())
    expect(keysOf(shown.only)).toEqual([KEYS.described, KEYS.merged, KEYS.series].sort())
    expect(keysOf(shown.uni)).toEqual([KEYS.university])
    expect(shown.exclude.find((item) => item.key === KEYS.plain)?.meta?.startsAt.status).toBe(
      "found",
    )
  })

  test("reads cards, not events, once the backfill is recorded", async () => {
    const t = newTest()
    await seed(t)
    await setReady(t, true)
    // A card the read alone can see proves where it reads from.
    await t.run(async (ctx) => {
      const card = await ctx.db
        .query("eventCards")
        .withIndex("by_key", (q) => q.eq("key", KEYS.plain))
        .unique()
      if (card) await ctx.db.patch("eventCards", card._id, { title: "From the card" })
    })
    const window = { from: NOW, to: NOW + 30 * DAY }
    const titles = (await t.query(api.events.list, window)).map((item) => item.title)
    expect(titles).toContain("From the card")
    await setReady(t, false)
    const before = (await t.query(api.events.list, window)).map((item) => item.title)
    expect(before).toContain("Star party")
  })

  test("supersede, revive, organiser changes and deletions keep cards in line", async () => {
    const t = newTest()
    await seed(t)

    await t.mutation(internal.ingest.superseded.supersede, {
      events: [{ key: KEYS.plain, by: KEYS.university }],
    })
    await expectCardsInLine(t)
    let shown = await expectSameBothWays(t)
    expect(keysOf(shown.exclude)).not.toContain(KEYS.plain)

    // Its own identity claims posted again bring it back (ENG-47).
    await t.mutation(internal.ingest.claims.ingest, {
      claims: ["title", "startsAt", "source", "externalId", "sourceUrl"].map((field) =>
        claim(
          KEYS.plain,
          field,
          {
            title: "Star party",
            startsAt: NOW + DAY,
            source: "ics",
            externalId: "Star party",
            sourceUrl: "https://example.org/astro.ics",
          }[field],
        ),
      ),
    })
    await expectCardsInLine(t)
    shown = await expectSameBothWays(t)
    expect(keysOf(shown.exclude)).toContain(KEYS.plain)

    // The University's listing credited to a society changes stream.
    await t.mutation(internal.ingest.relationships.setEventOrganisers, {
      events: [{ eventKey: KEYS.university, organisers: [{ orgKey: OTHER, role: "organiser" }] }],
    })
    await expectCardsInLine(t)
    shown = await expectSameBothWays(t)
    expect(keysOf(shown.uni)).toEqual([])

    // Removing an organisation strips it from its events (ENG-24 back).
    await t.mutation(internal.ingest.purge.removeEntity, { entityType: "organisation", key: OTHER })
    await expectCardsInLine(t)
    shown = await expectSameBothWays(t)
    expect(keysOf(shown.uni)).toEqual([KEYS.university])

    await t.mutation(internal.ingest.purge.removeEntity, {
      entityType: "event",
      key: KEYS.spanning,
    })
    await expectCardsInLine(t)
    await expectSameBothWays(t)

    // Retention (R3) deletes the year-old event and its card.
    await t.mutation(internal.retention.purgeEvents, { now: NOW })
    await expectCardsInLine(t)
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("eventCards")
          .withIndex("by_key", (q) => q.eq("key", KEYS.old))
          .unique(),
      ),
    ).toBeNull()
  })

  test("the daily walk backfills missing cards, then records it", async () => {
    const t = newTest()
    await seed(t)
    await t.run(async (ctx) => {
      for (const card of await ctx.db.query("eventCards").collect()) {
        await ctx.db.delete("eventCards", card._id)
      }
    })
    // A walk an older deployment began (no `cards`) records nothing.
    await t.mutation(internal.derive.recomputeEvents, {})
    expect(await t.run((ctx) => ctx.db.query("projectionBackfills").collect())).toEqual([])
    await expectCardsInLine(t)

    await t.mutation(internal.derive.recomputeEvents, { cards: true })
    const rows = await t.run((ctx) => ctx.db.query("projectionBackfills").collect())
    expect(rows.map((row) => row.name)).toEqual([EVENT_CARDS_BACKFILL])
    await expectCardsInLine(t)
    await expectSameBothWays(t)
  })
})
