import { describe, expect, test } from "bun:test"
import { eventKey } from "../lib/keys"
import { api, internal } from "./_generated/api"
import type { ClaimInput } from "./ingest/claims"
import { newTest, type TestConvex } from "./lib/harness.testing"

/**
 * What the events sitemap lists (convex/sitemap.ts): the public events from
 * today on — never Cambridge-only, ended or talks.cam-derived ones (G1, G4).
 * The societies file is `orgs.sitemap` (convex/orgsHubs.test.ts). Invented
 * data only.
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

const page = { paginationOpts: { numItems: 200, cursor: null } }

async function seedOrgs(t: TestConvex) {
  await t.mutation(internal.ingest.claims.ingest, {
    claims: [
      claim("org-full", "name", "Invented Full Society"),
      claim("org-full", "shortDescription", "We meet weekly."),
      claim("org-site", "name", "Invented Website Society"),
      claim("org-site", "website", "https://example.org/site"),
      claim("org-events", "name", "Invented Events Society"),
      claim("org-thin", "name", "Invented Thin Society"),
      claim("org-old", "name", "Invented Old Society"),
      claim("org-old", "shortDescription", "Folded in 2019."),
      claim("org-old", "defunct", true),
      claim("org-college", "name", "Invented College"),
      claim("org-college", "isCounterpart", true),
    ],
  })
}

async function seedEvent(
  t: TestConvex,
  key: string,
  fields: Record<string, unknown>,
  orgKey = "org-events",
) {
  await t.mutation(internal.ingest.claims.ingest, {
    claims: Object.entries({ visibility: "public", externalId: key, ...fields }).map(
      ([field, value]) => claim(key, field, value, "event"),
    ),
  })
  await t.mutation(internal.ingest.relationships.setEventOrganisers, {
    events: [{ eventKey: key, organisers: [{ orgKey, role: "organiser" as const }] }],
  })
}

describe("sitemap.events", () => {
  test("public events from today on, not ended, Cambridge-only or talks.cam-derived", async () => {
    const t = newTest()
    await seedOrgs(t)
    const keys = {
      soon: eventKey("ics", "soon"),
      past: eventKey("ics", "past"),
      running: eventKey("ics", "running"),
      cam: eventKey("mailing_list", "cam"),
      talks: eventKey("talks_cam", "talk"),
    }
    const ics = { source: "ics", sourceUrl: "https://example.org/a.ics" }
    await seedEvent(t, keys.soon, { title: "Invented soon", startsAt: NOW + DAY, ...ics })
    await seedEvent(t, keys.past, { title: "Invented past", startsAt: NOW - 3 * DAY, ...ics })
    await seedEvent(t, keys.running, {
      title: "Invented exhibition",
      startsAt: NOW - 10 * DAY,
      endsAt: NOW + 10 * DAY,
      allDay: true,
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
    const result = await t.query(api.sitemap.events, page)
    expect(result.page.map((row) => row.key).sort()).toEqual([keys.running, keys.soon].sort())
    // A later page never repeats the running ones.
    const later = await t.query(api.sitemap.events, {
      paginationOpts: { numItems: 1, cursor: null },
    })
    expect(later.page.map((row) => row.key)).toContain(keys.running)
    if (!later.isDone) {
      const next = await t.query(api.sitemap.events, {
        paginationOpts: { numItems: 200, cursor: later.continueCursor },
      })
      expect(next.page.map((row) => row.key)).not.toContain(keys.running)
    }
  })
})
