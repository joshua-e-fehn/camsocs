import { describe, expect, test } from "bun:test"
import { eventKey } from "../lib/keys"
import { api, internal } from "./_generated/api"
import type { ClaimInput } from "./ingest/claims"
import { newTest, signedInAs, type TestConvex, withEnv } from "./lib/harness.testing"

/**
 * The Finder (ENG-127): `orgs.finder` ranks listings from quiz answers, and
 * a personal feed (`feeds.create` / `feeds.update`, `events.feed`) follows
 * listings and serves their public events. Synthetic listings only.
 */

const NOW = Date.now()
const DAY = 86_400_000

const claim = (
  entityKey: string,
  field: string,
  value: unknown,
  entityType = "organisation",
): ClaimInput => ({
  entityType: entityType as ClaimInput["entityType"],
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
})

async function seed(t: TestConvex) {
  await t.mutation(internal.ingest.claims.ingest, {
    claims: [
      claim("org-choir", "name", "Chapel Choir"),
      claim("org-choir", "level", "university"),
      claim("org-choir", "categories", ["music"]),
      claim("org-choir", "audiences", ["beginners"]),
      claim("org-chess", "name", "Chess Club"),
      claim("org-chess", "level", "university"),
      claim("org-chess", "categories", ["hobbies_games"]),
      claim("org-band", "name", "College Band"),
      claim("org-band", "level", "college"),
      claim("org-band", "categories", ["music"]),
      claim("org-band", "collegeKeys", ["org-example"]),
    ],
  })
}

async function addEvent(t: TestConvex, orgKey: string, startsAt: number) {
  const key = eventKey("ics", `${orgKey}-${startsAt}`)
  const values: Record<string, unknown> = {
    title: "Invented rehearsal",
    startsAt,
    visibility: "public",
    source: "ics",
    externalId: `${orgKey}-${startsAt}`,
    sourceUrl: "https://example.org/cal.ics",
  }
  await t.mutation(internal.ingest.claims.ingest, {
    claims: Object.entries(values).map(([field, value]) => claim(key, field, value, "event")),
  })
  await t.mutation(internal.ingest.relationships.setEventOrganisers, {
    events: [{ eventKey: key, organisers: [{ orgKey, role: "organiser" as const }] }],
  })
  return key
}

describe("orgs.finder", () => {
  test("ranks by the answers, says why, and never offers another college's club", async () => {
    const t = newTest()
    await seed(t)
    const music = await t.query(api.orgs.finder, {
      answers: { interests: ["music"], level: ["beginner"] },
    })
    expect(music.map((r) => r.key)).toEqual(["org-choir"])
    expect(music[0].reasons).toEqual(["Music", "beginners welcome"])
    const mine = await t.query(api.orgs.finder, {
      answers: { interests: ["music"], where: ["college"] },
      collegeKey: "org-example",
    })
    expect(mine[0].key).toBe("org-band")
  })
})

describe("personal feeds", () => {
  test("create follows listed societies only, and the feed serves their public events", async () => {
    const t = newTest()
    await seed(t)
    const key = await addEvent(t, "org-choir", NOW + 2 * DAY)
    await addEvent(t, "org-chess", NOW + 3 * DAY)
    const made = await t.mutation(api.feeds.create, {
      orgKeys: ["org-choir", "org-nope", "org-choir"],
    })
    expect(made.orgKeys).toEqual(["org-choir"])
    expect(made.feedId).toMatch(/^[a-z0-9]{25}$/)
    const events = await t.query(api.events.feed, {
      feedId: made.feedId,
      from: NOW,
      to: NOW + 10 * DAY,
    })
    expect(events?.map((e) => e.key)).toEqual([key])
    expect(
      await t.query(api.events.feed, { feedId: "x".repeat(25), from: NOW, to: NOW + DAY }),
    ).toBeNull()
  })

  test("update needs the edit token", async () => {
    const t = newTest()
    await seed(t)
    const made = await t.mutation(api.feeds.create, { orgKeys: ["org-choir"] })
    await expect(
      t.mutation(api.feeds.update, {
        feedId: made.feedId,
        editToken: "wrong",
        orgKeys: ["org-chess"],
      }),
    ).rejects.toThrow()
    const changed = await t.mutation(api.feeds.update, {
      feedId: made.feedId,
      editToken: made.editToken,
      orgKeys: ["org-chess", "org-choir"],
    })
    expect(changed.orgKeys).toEqual(["org-chess", "org-choir"])
    const got = await t.query(api.feeds.get, { feedId: made.feedId })
    expect(got?.orgs.map((o) => o.name)).toEqual(["Chess Club", "Chapel Choir"])
  })
})

describe("broker.overview.finderFeeds (ENG-133)", () => {
  test("counts feeds for a broker, and refuses anyone else", async () => {
    await withEnv({ BROKER_EMAILS: "broker@example.com" }, async () => {
      const t = newTest()
      await seed(t)
      await t.mutation(api.feeds.create, { orgKeys: ["org-choir", "org-chess"] })
      const made = await t.mutation(api.feeds.create, { orgKeys: ["org-choir"] })
      await t.mutation(api.feeds.touch, { feedId: made.feedId })
      const broker = (await signedInAs(t, "broker@example.com")) as unknown as TestConvex
      const stranger = (await signedInAs(t, "someone@example.com")) as unknown as TestConvex
      expect(await broker.query(api.broker.overview.finderFeeds, {})).toEqual({
        total: 2,
        created7: 2,
        created28: 2,
        fetched7: 1,
        averageFollowed: 1.5,
      })
      await expect(stranger.query(api.broker.overview.finderFeeds, {})).rejects.toThrow()
    })
  })
})
