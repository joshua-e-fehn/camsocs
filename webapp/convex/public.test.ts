import { describe, expect, test } from "bun:test"
import { eventKey } from "../lib/keys"
import { api, internal } from "./_generated/api"
import type { ClaimInput } from "./ingest/claims"
import { newTest, signedInAs, type TestConvex, withEnv } from "./lib/harness.testing"
import { GLOBAL_PER_HOUR } from "./listingRequests"

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

    // Lists carry no description or provenance; the details come from events.get.
    expect(Object.keys(anonymous[0])).not.toContain("meta")
    expect(Object.keys(anonymous[0])).not.toContain("description")
    const details = await t.query(api.events.get, { key: anonymous[0].key })
    expect(details?.meta.title?.status).toBe("found")

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

describe("events societies take part in (decision D6)", () => {
  const ctfKey = eventKey("google_calendar", "ctf-1")
  const feed = "https://calendar.google.com/calendar/ical/cyber/public/basic.ics"

  async function seedExternal(t: TestConvex, startsAt = NOW + 5 * DAY) {
    const field = (name: string, value: unknown, overrides: Partial<ClaimInput> = {}) =>
      claim(ctfKey, name, value, {
        entityType: "event",
        sourceKey: "src-feed",
        sourceUrl: feed,
        sourceType: "ics_feed",
        ...overrides,
      })
    await t.mutation(internal.ingest.claims.ingest, {
      claims: [
        field("title", "Some CTF 2026"),
        field("startsAt", startsAt),
        field("visibility", "public"),
        field("source", "google_calendar"),
        field("externalId", "ctf-1"),
        field("sourceUrl", feed),
        field("hosting", "takes_part", {
          status: "inferred",
          extractor: "event_noise.external.ctftime",
          evidenceQuote: "CTF Event from CTFTime",
        }),
        field("externalUrl", "https://ctf.example.org/"),
      ],
    })
    await t.mutation(internal.ingest.relationships.setEventOrganisers, {
      events: [{ eventKey: ctfKey, organisers: [{ orgKey: "org-choir", role: "organiser" }] }],
    })
  }

  test("lists and details carry hosting; the external page only with takes_part", async () => {
    const t = newTest()
    const keys = await seed(t)
    await seedExternal(t)
    const window = { from: NOW, to: NOW + 30 * DAY }
    const listed = await t.query(api.events.list, window)
    const byTitle = Object.fromEntries(listed.map((event) => [event.title, event]))
    // A row nobody judged (from before D6) hosts.
    expect(byTitle["Open simul"].hosting).toBe("hosts")
    expect(byTitle["Open simul"].externalUrl).toBeUndefined()
    expect(byTitle["Some CTF 2026"].hosting).toBe("takes_part")
    expect(byTitle["Some CTF 2026"].externalUrl).toBe("https://ctf.example.org/")

    const details = await t.query(api.events.get, { key: ctfKey })
    expect(details?.hosting).toBe("takes_part")
    expect(details?.externalUrl).toBe("https://ctf.example.org/")
    expect(details?.meta.hosting?.status).toBe("inferred")
    expect((await t.query(api.events.get, { key: keys.open }))?.hosting).toBe("hosts")

    // Included by default; left out on request.
    const hostedOnly = await t.query(api.events.list, { ...window, includeTakingPart: false })
    expect(hostedOnly.map((event) => event.title)).toEqual(["Open simul"])
    const page = await t.query(api.orgs.getBySlug, { slug: "choir" })
    expect(page?.events.map((event) => [event.title, event.hosting])).toEqual([
      ["Some CTF 2026", "takes_part"],
    ])
  })

  test("a later verdict that it is the society's own hides the external page", async () => {
    const t = newTest()
    await seed(t)
    await seedExternal(t)
    await t.mutation(internal.ingest.claims.ingest, {
      claims: [
        claim(ctfKey, "hosting", "hosts", {
          entityType: "event",
          sourceKey: "src-feed",
          sourceUrl: feed,
          sourceType: "ics_feed",
          method: "llm",
          extractor: "bulk-model",
          promptVersion: "event_noise_v1",
          evidenceQuote: "Some CTF 2026",
          quoteCheck: "exact",
          retrievedAt: NOW,
        }),
      ],
    })
    const details = await t.query(api.events.get, { key: ctfKey })
    expect(details?.hosting).toBe("hosts")
    expect(details?.externalUrl).toBeUndefined()
  })

  test("someone else's event never counts as the society's activity", async () => {
    const t = newTest()
    await seed(t)
    await seedExternal(t, NOW - 2 * DAY)
    let page = await t.query(api.orgs.getBySlug, { slug: "choir" })
    expect(page?.org.lastActiveAt).toBeUndefined()
    // Judged its own after all: now it does.
    await t.mutation(internal.ingest.claims.ingest, {
      claims: [
        claim(ctfKey, "hosting", "hosts", {
          entityType: "event",
          sourceKey: "src-manual",
          sourceUrl: "manual:test",
          sourceType: "manual",
          method: "manual",
        }),
      ],
    })
    page = await t.query(api.orgs.getBySlug, { slug: "choir" })
    expect(page?.org.lastActiveAt).toBe(NOW - 2 * DAY)
  })
})

describe("events.restrictedCount", () => {
  test("counts the cam_only events a visitor cannot see around the dates asked for", async () => {
    const t = newTest()
    await seed(t)
    const window = { from: NOW, to: NOW + 30 * DAY }
    // One cam_only event; the members_only one is never counted or shown.
    expect(await t.query(api.events.restrictedCount, window)).toEqual({ camOnly: 1 })
    expect(await t.query(api.events.restrictedCount, { ...window, orgKey: "org-chess" })).toEqual({
      camOnly: 1,
    })

    const cam = await signedInAs(t, "xy789@cam.ac.uk")
    expect(await cam.query(api.events.restrictedCount, window)).toEqual({ camOnly: 0 })
  })

  test("is no oracle: search, type and category filters are ignored and windows are whole weeks", async () => {
    const t = newTest()
    await seed(t)
    const window = { from: NOW, to: NOW + 30 * DAY }
    // A title word that matches and one that does not: the same answer.
    for (const q of ["blitz", "football"]) {
      expect(await t.query(api.events.restrictedCount, { ...window, q })).toEqual({ camOnly: 1 })
    }
    expect(await t.query(api.events.restrictedCount, { ...window, eventTypes: ["talk"] })).toEqual({
      camOnly: 1,
    })
    expect(await t.query(api.events.restrictedCount, { ...window, categories: ["music"] })).toEqual(
      { camOnly: 1 },
    )
    // A one-millisecond window around the event's start counts its whole week,
    // so bisecting from/to cannot recover the start time.
    const startsAt = NOW + 3 * DAY
    const counts = new Set<number>()
    for (const [from, to] of [
      [startsAt, startsAt + 1],
      [startsAt + 1, startsAt + 2],
      [startsAt - 1, startsAt],
    ]) {
      counts.add((await t.query(api.events.restrictedCount, { from, to })).camOnly)
    }
    expect([...counts]).toEqual([1])
  })
})

describe("hidden organisations' events", () => {
  test("an event whose every host is hidden leaves the calendar; its key lists nothing", async () => {
    await withEnv({ BROKER_EMAILS: "broker@example.com" }, async () => {
      const t = newTest()
      const keys = await seed(t)
      const broker = await signedInAs(t, "broker@example.com")
      await broker.mutation(api.broker.orgs.setHidden, { orgKey: "org-chess", hidden: true })
      const window = { from: NOW, to: NOW + 30 * DAY }
      expect(await t.query(api.events.list, window)).toEqual([])
      expect(await t.query(api.events.list, { ...window, orgKey: "org-chess" })).toEqual([])
      expect(await t.query(api.events.get, { key: keys.open })).toBeNull()
      expect(await t.query(api.events.restrictedCount, window)).toEqual({ camOnly: 0 })

      await broker.mutation(api.broker.orgs.setHidden, { orgKey: "org-chess", hidden: false })
      expect((await t.query(api.events.list, window)).map((e) => e.title)).toEqual(["Open simul"])
    })
  })
})

describe("multi-day events", () => {
  test("a run that began before the window still shows, in lists and on the organiser's page", async () => {
    const t = newTest()
    await seed(t)
    const key = eventKey("camdram", "show:1/performance:1")
    const startsAt = NOW - 20 * DAY
    const field = (name: string, value: unknown) =>
      claim(key, name, value, { entityType: "event", sourceType: "camdram" })
    await t.mutation(internal.ingest.claims.ingest, {
      claims: [
        field("title", "Long film run"),
        field("startsAt", startsAt),
        field("endsAt", NOW + 40 * DAY),
        field("allDay", true),
        field("visibility", "public"),
        field("source", "camdram"),
        field("externalId", "show:1/performance:1"),
        field("sourceUrl", "https://www.camdram.net/shows/film"),
      ],
    })
    await t.mutation(internal.ingest.relationships.setEventOrganisers, {
      events: [{ eventKey: key, organisers: [{ orgKey: "org-chess", role: "organiser" }] }],
    })
    const window = { from: NOW, to: NOW + 7 * DAY }
    expect((await t.query(api.events.list, window)).map((e) => e.title)).toEqual([
      "Long film run",
      "Open simul",
    ])
    expect(
      (await t.query(api.events.list, { ...window, orgKey: "org-chess" })).map((e) => e.title),
    ).toContain("Long film run")
    expect((await t.query(api.events.list, { ...window, q: "film" })).length).toBe(1)
    const page = await t.query(api.orgs.getBySlug, { slug: "chess" })
    expect(page?.events.map((e) => e.title)).toEqual(["Long film run", "Open simul"])
    // After it ends, it is gone.
    expect(await t.query(api.events.list, { from: NOW + 41 * DAY, to: NOW + 48 * DAY })).toEqual([])
  })
})

describe("withdrawn events", () => {
  async function listed(
    t: TestConvex,
    source: "camdram" | "ics" | "website" | "termcard",
    externalId: string,
    title: string,
    startsAt: number,
    seenAt: number,
    listing: string,
  ) {
    const key = eventKey(source, externalId)
    const sourceTypes = {
      camdram: "camdram",
      ics: "ics_feed",
      website: "society_website",
      termcard: "termcard",
    } as const
    const field = (name: string, value: unknown) =>
      claim(key, name, value, {
        entityType: "event",
        sourceType: sourceTypes[source],
        sourceKey: `src-${listing}`,
        sourceUrl: listing,
        retrievedAt: seenAt,
      })
    await t.mutation(internal.ingest.claims.ingest, {
      claims: [
        field("title", title),
        field("startsAt", startsAt),
        field("visibility", "public"),
        field("source", source),
        field("externalId", externalId),
        field("sourceUrl", listing),
      ],
    })
  }

  test("a Camdram night that moved is gone once the diary is read without it", async () => {
    const t = newTest()
    const show = "https://www.camdram.net/shows/hamlet.json"
    // Read 5 days ago for the 10th; the diary now lists the run on the 11th.
    await listed(
      t,
      "camdram",
      "show:1/performance:1/a",
      "Hamlet",
      NOW + 10 * DAY,
      NOW - 5 * DAY,
      show,
    )
    await listed(
      t,
      "camdram",
      "show:1/performance:2/b",
      "Hamlet",
      NOW + 11 * DAY,
      NOW - 60_000,
      show,
    )
    const window = { from: NOW, to: NOW + 20 * DAY }
    const starts = (await t.query(api.events.list, window)).map((e) => e.startsAt)
    expect(starts).toEqual([NOW + 11 * DAY])
    expect(
      await t.query(api.events.get, { key: eventKey("camdram", "show:1/performance:1/a") }),
    ).toBeNull()
  })

  test("an ICS occurrence whose time changed falls behind its feed, not another feed", async () => {
    const t = newTest()
    const feed = "https://example.org/cal.ics"
    const other = "https://other.example/cal.ics"
    await listed(t, "ics", "uid-1/20261110T190000Z", "Talk", NOW + 10 * DAY, NOW - 5 * DAY, feed)
    await listed(t, "ics", "uid-1/20261110T193000Z", "Talk", NOW + 10 * DAY + 1_800_000, NOW, feed)
    // A feed nobody has read for as long (unreachable, or the pipeline paused):
    // its events stay.
    await listed(t, "ics", "uid-9/20261112T190000Z", "Quiz", NOW + 12 * DAY, NOW - 5 * DAY, other)
    const titles = (await t.query(api.events.list, { from: NOW, to: NOW + 20 * DAY })).map((e) => [
      e.title,
      e.startsAt,
    ])
    expect(titles).toEqual([
      ["Talk", NOW + 10 * DAY + 1_800_000],
      ["Quiz", NOW + 12 * DAY],
    ])
  })

  test("a society's page or card that stops listing an event withdraws it", async () => {
    const t = newTest()
    // The model's wording keys the event (`<org>:<date>:<title slug>`): a
    // renamed or moved event is a new key, and the old one must not stay.
    const page = "https://cuquokka.example/events"
    await listed(t, "website", "org-q:2026-11-10:quiz", "Quiz", NOW + 10 * DAY, NOW - 5 * DAY, page)
    await listed(t, "website", "org-q:2026-11-11:pub-quiz", "Pub quiz", NOW + 11 * DAY, NOW, page)
    await listed(t, "website", "org-q:2026-11-12:social", "Social", NOW + 12 * DAY, NOW, page)
    const card = "https://cuquokka.example/termcard.pdf"
    await listed(
      t,
      "termcard",
      "org-q:2026-11-13:talk",
      "Talk",
      NOW + 13 * DAY,
      NOW - 5 * DAY,
      card,
    )
    await listed(t, "termcard", "org-q:2026-11-14:talk-2", "Talk 2", NOW + 14 * DAY, NOW, card)
    const titles = (await t.query(api.events.list, { from: NOW, to: NOW + 20 * DAY })).map(
      (e) => e.title,
    )
    expect(titles).toEqual(["Pub quiz", "Social", "Talk 2"])
  })
})

describe("public meta", () => {
  test("an inferred value whose other readings are private stays inferred", async () => {
    const t = newTest()
    await seed(t)
    // Two unquoted readings from private mail: conflicting inside, but the
    // visitor sees neither conflict reading — nor a promotion to "found".
    await t.mutation(internal.ingest.claims.ingest, {
      claims: [
        claim("org-chess", "website", "https://a.example/", {
          method: "llm",
          extractor: "m",
          sourceType: "mailing_list_email",
          sourceKey: "src-m1",
          sourceUrl: "inbound:<m1>",
        }),
        claim("org-chess", "website", "https://b.example/", {
          method: "llm",
          extractor: "m",
          sourceType: "mailing_list_email",
          sourceKey: "src-m2",
          sourceUrl: "inbound:<m2>",
          retrievedAt: NOW - 120_000,
        }),
      ],
    })
    const meta = (await t.query(api.orgs.getBySlug, { slug: "chess" }))?.org.meta
    expect(meta?.website.status).toBe("inferred")
    expect(meta?.website.conflicts).toBeUndefined()
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

describe("listingRequests.submit — the removal route stays open", () => {
  test("a flood of other requests from throwaway addresses cannot lock out a removal", async () => {
    const t = newTest()
    await seed(t)
    for (let i = 0; i < GLOBAL_PER_HOUR; i++) {
      await t.mutation(api.listingRequests.submit, {
        kind: "correct",
        orgKey: "org-chess",
        submitterEmail: `x${i}@example.org`,
        message: "Junk correction request.",
      })
    }
    await expect(
      t.mutation(api.listingRequests.submit, {
        kind: "claim",
        orgKey: "org-chess",
        submitterEmail: "late@example.org",
        message: "Another junk request.",
      }),
    ).rejects.toThrow(/busy/)
    const { key } = await t.mutation(api.listingRequests.submit, {
      kind: "remove",
      orgKey: "org-chess",
      submitterEmail: "secretary@cuchess.org",
      message: "Please remove my details.",
    })
    expect(key).toMatch(/^lr-/)
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
