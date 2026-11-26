import { describe, expect, test } from "bun:test"
import { api, internal } from "./_generated/api"
import { newTest } from "./lib/harness.testing"

/** Recurring event series (ENG-282): derived on ingest, kept by the daily walk. */

const DAY = 86_400_000

type T = ReturnType<typeof newTest>

function claim(
  entityType: "organisation" | "event",
  entityKey: string,
  field: string,
  value: unknown,
) {
  return {
    entityType,
    entityKey,
    field,
    value,
    evidence: "primary" as const,
    method: "parser" as const,
    extractor: "test",
    sourceKey: "src-camdram",
    sourceUrl: `https://www.camdram.net/shows/${entityKey}`,
    sourceType: "camdram" as const,
    retrievedAt: Date.now() - DAY,
  }
}

async function addOrg(t: T, key: string, name: string) {
  await t.mutation(internal.ingest.claims.ingest, {
    claims: [claim("organisation", key, "name", name)],
  })
}

async function addEvent(
  t: T,
  key: string,
  title: string,
  startsAt: number,
  extra: Record<string, unknown> = {},
  orgKey = "org-greek",
) {
  const fields: Record<string, unknown> = {
    title,
    startsAt,
    visibility: "public",
    source: "camdram",
    externalId: key,
    sourceUrl: `https://www.camdram.net/shows/${key}`,
    ...extra,
  }
  await t.mutation(internal.ingest.claims.ingest, {
    claims: Object.entries(fields).map(([field, value]) => claim("event", key, field, value)),
  })
  await t.mutation(internal.ingest.relationships.setEventOrganisers, {
    events: [{ eventKey: key, organisers: [{ orgKey, role: "organiser" }] }],
  })
}

describe("eventSeries", () => {
  test("editions share one series page; the walk creates it with a stable slug", async () => {
    const t = newTest()
    await addOrg(t, "org-greek", "Greek Play Committee")
    const soon = Date.now() + 10 * DAY
    await addEvent(t, "evt-gp-1", "The Cambridge Greek Play 2026", soon)
    await addEvent(t, "evt-gp-2", "The Cambridge Greek Play 2026", soon + DAY)
    await addEvent(t, "evt-other", "Weekly rehearsal", soon)
    await addEvent(t, "evt-ctf", "CSCTF 2026", soon, { hosting: "takes_part" })
    await addEvent(t, "evt-cam", "Members Dinner 2026", soon, { visibility: "cam_only" })

    // Ingest sets the key; the page waits for the walk's row.
    const keys = await t.run(async (ctx) =>
      Object.fromEntries((await ctx.db.query("events").collect()).map((e) => [e.key, e.seriesKey])),
    )
    expect(keys["evt-gp-1"]).toBeDefined()
    expect(keys["evt-gp-1"]).toBe(keys["evt-gp-2"] as string)
    expect(keys["evt-other"]).toBeUndefined()
    expect(keys["evt-ctf"]).toBeUndefined()
    expect(await t.query(api.eventSeries.ofEvent, { key: "evt-gp-1" })).toBeNull()

    await t.mutation(internal.derive.recomputeEvents, {})
    const list = await t.query(api.eventSeries.list, {})
    // The cam_only edition makes no public series.
    expect(list.map((s) => s.slug)).toEqual(["cambridge-greek-play"])
    expect(list[0].org).toEqual({ name: "Greek Play Committee", slug: expect.any(String) })
    expect(list[0].nextStartsAt).toBe(soon)

    const page = await t.query(api.eventSeries.get, { slug: "cambridge-greek-play" })
    expect(page?.series.name).toBe("The Cambridge Greek Play")
    expect(page?.editions.map((e) => e.key)).toEqual(["evt-gp-1", "evt-gp-2"])
    expect(await t.query(api.eventSeries.ofEvent, { key: "evt-gp-2" })).toEqual({
      slug: "cambridge-greek-play",
      name: "The Cambridge Greek Play",
    })
    expect(await t.query(api.eventSeries.get, { slug: "nope" })).toBeNull()
  })

  test("a later year's edition keeps the slug and moves the series on", async () => {
    const t = newTest()
    await addOrg(t, "org-greek", "Greek Play Committee")
    const soon = Date.now() + 10 * DAY
    await addEvent(t, "evt-2026", "The Cambridge Greek Play 2026", soon)
    await t.mutation(internal.derive.recomputeEvents, {})
    await addEvent(t, "evt-2029", "The Cambridge Greek Play 2029", soon + 400 * DAY)
    await t.mutation(internal.derive.recomputeEvents, {})
    const rows = await t.run(async (ctx) => ctx.db.query("eventSeries").collect())
    expect(rows).toHaveLength(1)
    expect(rows[0].slug).toBe("cambridge-greek-play")
    expect(rows[0].lastStartsAt).toBe(soon + 400 * DAY)
    const page = await t.query(api.eventSeries.get, { slug: "cambridge-greek-play" })
    expect(page?.editions.map((e) => e.key)).toEqual(["evt-2026", "evt-2029"])
  })

  test("two organisers' series of one name get distinct slugs", async () => {
    const t = newTest()
    await addOrg(t, "org-greek", "Greek Play Committee")
    await addOrg(t, "org-rival", "Rival Players")
    const soon = Date.now() + 10 * DAY
    await addEvent(t, "evt-a", "Spring Revue 2027", soon)
    await addEvent(t, "evt-b", "Spring Revue 2027", soon, {}, "org-rival")
    await t.mutation(internal.derive.recomputeEvents, {})
    const slugs = (await t.query(api.eventSeries.list, {})).map((s) => s.slug).sort()
    expect(slugs).toHaveLength(2)
    expect(slugs[0]).toBe("spring-revue")
    expect(slugs[1]).toMatch(/^spring-revue-/)
  })

  test("a series whose every edition is suppressed is hidden with its name (review of PR #102)", async () => {
    const t = newTest()
    await addOrg(t, "org-greek", "Greek Play Committee")
    const soon = Date.now() + 10 * DAY
    await addEvent(t, "evt-gp-1", "The Cambridge Greek Play 2026", soon)
    await t.mutation(internal.derive.recomputeEvents, {})
    expect((await t.query(api.eventSeries.list, {})).map((s) => s.slug)).toEqual([
      "cambridge-greek-play",
    ])
    await t.run(async (ctx) => {
      await ctx.db.insert("suppressions", {
        key: "sup-gp-1",
        scope: "event",
        eventKey: "evt-gp-1",
        createdAt: Date.now(),
      })
    })
    expect(await t.query(api.eventSeries.list, {})).toEqual([])
    expect(await t.query(api.eventSeries.get, { slug: "cambridge-greek-play" })).toBeNull()
    expect(await t.query(api.eventSeries.ofEvent, { key: "evt-gp-1" })).toBeNull()
  })

  test("an edition whose hosts are all hidden gives no next date", async () => {
    const t = newTest()
    await addOrg(t, "org-greek", "Greek Play Committee")
    const soon = Date.now() + 10 * DAY
    await addEvent(t, "evt-old", "The Cambridge Greek Play 2026", Date.now() - 30 * DAY)
    await addEvent(t, "evt-new", "The Cambridge Greek Play 2027", soon)
    await t.mutation(internal.derive.recomputeEvents, {})
    expect((await t.query(api.eventSeries.list, {}))[0].nextStartsAt).toBe(soon)
    // The next edition's hosts are only a listing that is not in the directory.
    await t.mutation(internal.ingest.relationships.setEventOrganisers, {
      events: [{ eventKey: "evt-new", organisers: [{ orgKey: "org-gone", role: "organiser" }] }],
    })
    const [row] = await t.query(api.eventSeries.list, {})
    expect(row.nextStartsAt).toBeUndefined()
    const page = await t.query(api.eventSeries.get, { slug: "cambridge-greek-play" })
    expect(page?.editions.map((e) => e.key)).toEqual(["evt-old"])
  })
})
