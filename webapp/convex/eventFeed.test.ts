import { describe, expect, test } from "bun:test"
import { eventKey } from "../lib/keys"
import { api, internal } from "./_generated/api"
import type { ClaimInput } from "./ingest/claims"
import { newTest, type TestConvex } from "./lib/harness.testing"

/**
 * The newly listed events (convex/eventFeed.ts): the events sitemap's pages
 * — public, from today on or still running, never talks.cam-derived (G1) —
 * minus cancelled ones, newest first. Invented data only.
 */

const NOW = Date.now()
const DAY = 86_400_000

function claim(entityKey: string, field: string, value: unknown, entityType = "organisation") {
  return {
    entityType,
    entityKey,
    field,
    value,
    evidence: "primary",
    method: "parser",
    extractor: "test",
    sourceKey: "src-test",
    sourceUrl: "https://example.org/",
    sourceType: "society_website",
    retrievedAt: NOW - 60_000,
  } as ClaimInput
}

async function seedEvent(t: TestConvex, key: string, fields: Record<string, unknown>) {
  await t.mutation(internal.ingest.claims.ingest, {
    claims: Object.entries({ visibility: "public", externalId: key, ...fields }).map(
      ([field, value]) => claim(key, field, value, "event"),
    ),
  })
  await t.mutation(internal.ingest.relationships.setEventOrganisers, {
    events: [{ eventKey: key, organisers: [{ orgKey: "org-jazz", role: "organiser" as const }] }],
  })
}

describe("eventFeed.newest", () => {
  test("listable public events, newest first, with their host; never talks.cam, past or cancelled", async () => {
    const t = newTest()
    await t.mutation(internal.ingest.claims.ingest, {
      claims: [claim("org-jazz", "name", "Invented Jazz Society")],
    })
    const ics = { source: "ics", sourceUrl: "https://example.org/a.ics" }
    const keys = {
      first: eventKey("ics", "first"),
      second: eventKey("ics", "second"),
      past: eventKey("ics", "past"),
      cancelled: eventKey("ics", "cancelled"),
      cam: eventKey("mailing_list", "cam"),
      talks: eventKey("talks_cam", "talk"),
    }
    await seedEvent(t, keys.first, { title: "Invented first", startsAt: NOW + 3 * DAY, ...ics })
    await seedEvent(t, keys.past, { title: "Invented past", startsAt: NOW - 3 * DAY, ...ics })
    await seedEvent(t, keys.cancelled, {
      title: "Invented cancelled",
      startsAt: NOW + 2 * DAY,
      cancelled: true,
      ...ics,
    })
    await seedEvent(t, keys.cam, {
      title: "Invented members' drinks",
      startsAt: NOW + DAY,
      visibility: "cam_only",
      source: "mailing_list",
      sourceUrl: "inbound:<x@lists>",
    })
    await seedEvent(t, keys.talks, {
      title: "Invented seminar",
      startsAt: NOW + 2 * DAY,
      source: "talks_cam",
      sourceUrl: "https://talks.cam.ac.uk/talk/index/1",
    })
    await seedEvent(t, keys.second, { title: "Invented second", startsAt: NOW + DAY, ...ics })

    const rows = await t.query(api.eventFeed.newest, {})
    expect(rows.map((row) => row.key)).toEqual([keys.second, keys.first])
    expect(rows[0]).toMatchObject({
      title: "Invented second",
      host: "Invented Jazz Society",
      fromUniversity: false,
      allDay: false,
    })
    expect(rows[0].listedAt).toBeGreaterThanOrEqual(rows[1].listedAt)

    const one = await t.query(api.eventFeed.newest, { limit: 1 })
    expect(one.map((row) => row.key)).toEqual([keys.second])
  })
})
