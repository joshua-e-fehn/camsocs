import { describe, expect, test } from "bun:test"
import { eventKey, personKey } from "../../lib/keys"
import { api, internal } from "../_generated/api"
import type { ClaimInput } from "../ingest/claims"
import { newTest, signedInAs, type TestConvex, withEnv } from "../lib/harness.testing"
import { suppressionKey } from "../lib/suppressions"

/**
 * The ecosystem map (convex/broker/graph.ts `ecosystem`, lib/broker/ecosystem.ts)
 * over a seeded deployment: co-hosting from the organiser join rows, sponsors,
 * outreach, and the rules — node ids `${campus}:${key}`, people only as a
 * count (a sensitive society's officers above all), hidden and suppressed
 * listings and talks.cam evidence left out, brokers only. Synthetic data.
 */

const BROKER = "broker@example.com"
const NOW = Date.now()
const DAY = 86_400_000

function claim(
  entityKey: string,
  field: string,
  value: unknown,
  entityType: ClaimInput["entityType"] = "organisation",
  sourceUrl = "https://example.org/",
): ClaimInput {
  return {
    entityType,
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

const EVENTS = {
  cohosted: eventKey("ics", "invented-joint-night"),
  sponsored: eventKey("ics", "invented-sponsored-quiz"),
  takesPart: eventKey("ics", "invented-fair"),
  cancelled: eventKey("ics", "invented-cancelled"),
  talks: eventKey("talks_cam", "invented-seminar"),
  hidden: eventKey("ics", "invented-hidden-joint"),
  sensitive: eventKey("ics", "invented-interfaith"),
}

const ANNA = personKey("org-faith", "Anna Example")
const BEN = personKey("org-faith", "Ben Example")

async function seed(t: TestConvex) {
  await t.mutation(internal.ingest.claims.ingest, {
    claims: [
      claim("org-chess", "name", "Invented Chess Club"),
      claim("org-chess", "categories", ["hobbies_games"]),
      claim("org-go", "name", "Invented Go Society"),
      claim("org-go", "categories", ["hobbies_games"]),
      claim("org-quiz", "name", "Invented Quiz Society"),
      claim("org-quiz", "categories", ["hobbies_games"]),
      claim("org-bank", "name", "Invented Bank"),
      claim("org-bank", "orgType", "company"),
      claim("org-bank", "isCounterpart", true),
      claim("org-faith", "name", "Invented Faith Society"),
      claim("org-faith", "categories", ["faith"]),
      claim("org-faith", "website", "https://faith.example.org/"),
      claim("org-hidden", "name", "Invented Hidden Society"),
      claim("org-hidden", "categories", ["hobbies_games"]),
      claim("org-gone", "name", "Invented Objecting Society"),
      claim("org-gone", "categories", ["hobbies_games"]),
    ],
  })
  const event = (key: string, fields: Record<string, unknown>, sourceUrl?: string) =>
    Object.entries({
      title: `Invented event ${key.slice(4, 10)}`,
      startsAt: NOW - 10 * DAY,
      visibility: "public",
      source: "ics",
      sourceUrl: sourceUrl ?? `https://example.org/${key}`,
      externalId: key,
      ...fields,
    }).map(([field, value]) => claim(key, field, value, "event"))
  await t.mutation(internal.ingest.claims.ingest, {
    claims: [
      ...event(EVENTS.cohosted, {}),
      ...event(EVENTS.sponsored, {}),
      ...event(EVENTS.takesPart, { hosting: "takes_part" }),
      ...event(EVENTS.cancelled, { cancelled: true }),
      ...event(EVENTS.talks, { source: "talks_cam" }, "https://talks.cam.ac.uk/talk/index/1"),
      ...event(EVENTS.hidden, {}),
      ...event(EVENTS.sensitive, {}),
    ],
  })
  const pair = (organiser: string, other: string, role: "co_host" | "sponsor" = "co_host") => [
    { orgKey: organiser, role: "organiser" as const },
    { orgKey: other, role },
  ]
  await t.mutation(internal.ingest.relationships.setEventOrganisers, {
    events: [
      { eventKey: EVENTS.cohosted, organisers: pair("org-chess", "org-go") },
      { eventKey: EVENTS.sponsored, organisers: pair("org-quiz", "org-bank", "sponsor") },
      { eventKey: EVENTS.takesPart, organisers: pair("org-chess", "org-quiz") },
      { eventKey: EVENTS.cancelled, organisers: pair("org-go", "org-quiz") },
      { eventKey: EVENTS.talks, organisers: pair("org-quiz", "org-go") },
      { eventKey: EVENTS.hidden, organisers: pair("org-chess", "org-hidden") },
      { eventKey: EVENTS.sensitive, organisers: pair("org-faith", "org-chess") },
    ],
  })
  await t.mutation(internal.ingest.relationships.upsert, {
    relationships: [
      {
        fromKey: "org-bank",
        toKey: "org-chess",
        type: "sponsors",
        evidence: { sourceUrl: "https://example.org/sponsors", seenAt: NOW },
        evidenceKind: "primary",
        method: "parser",
      },
      {
        fromKey: "org-go",
        toKey: "org-quiz",
        type: "co_hosted",
        evidence: { sourceUrl: "https://talks.cam.ac.uk/talk/index/2", seenAt: NOW },
        evidenceKind: "primary",
        method: "parser",
      },
      {
        fromKey: "org-gone",
        toKey: "org-chess",
        type: "sister_of",
        evidence: { sourceUrl: "https://example.org/sisters", seenAt: NOW },
        evidenceKind: "secondary",
        method: "parser",
      },
    ],
  })
  await t.mutation(internal.ingest.broker.ingest, {
    people: [ANNA, BEN].map((key, i) => ({
      key,
      orgKey: "org-faith",
      name: i === 0 ? "Anna Example" : "Ben Example",
      role: i === 0 ? "President" : "Secretary",
      sourceUrl: "https://faith.example.org/committee",
      seenAt: NOW,
      method: "parser" as const,
    })),
  })
  // The broker's records: a past sponsor, and outreach to a person.
  await t.run(async (ctx) => {
    await ctx.db.insert("orgBrokerProfiles", {
      orgKey: "org-go",
      needs: [],
      offers: [],
      optIns: {},
      pecrSubscriberType: "unknown",
      suppressed: false,
      ethicsFlags: [],
      pastSponsorKeys: ["org-bank", "org-gone"],
      createdAt: NOW,
      updatedAt: NOW,
    })
    await ctx.db.insert("interactions", {
      key: "int-1",
      date: NOW - DAY,
      personKey: ANNA,
      channel: "email",
      summary: "Invented call about a joint event",
      createdAt: NOW,
      updatedAt: NOW,
    })
    await ctx.db.insert("introductions", {
      key: "intro-1",
      partyA: { personKey: BEN },
      partyB: { orgKey: "org-bank" },
      reason: "Invented reason",
      date: NOW - DAY,
      status: "idea",
      createdAt: NOW,
      updatedAt: NOW,
    })
    // Accepted after the rows were stored: an objection, not (yet) hidden.
    await ctx.db.insert("suppressions", {
      key: suppressionKey({ scope: "organisation", orgKey: "org-gone" }),
      scope: "organisation",
      orgKey: "org-gone",
      createdAt: NOW,
    })
  })
}

async function asBroker<T>(body: (t: TestConvex, broker: TestConvex) => Promise<T>) {
  return await withEnv({ BROKER_EMAILS: BROKER, CAMSOCS_CAMPUS: undefined }, async () => {
    const t = newTest()
    await seed(t)
    const broker = (await signedInAs(t, BROKER)) as unknown as TestConvex
    await broker.mutation(api.broker.orgs.setHidden, { orgKey: "org-hidden", hidden: true })
    return await body(t, broker)
  })
}

const ALL = ["relationships", "cohosting", "sponsors", "outreach"] as const

describe("broker.graph.ecosystem", () => {
  test("the default is the relationship layer, as the page always showed it", async () => {
    await asBroker(async (_t, broker) => {
      const map = await broker.query(api.broker.graph.ecosystem, {})
      expect(map.campus).toBe("cam")
      expect(map.layers).toEqual(["relationships"])
      // Every relationship, including those the organiser sets imply and the
      // hidden and suppressed listings' (flagged), as before — except the
      // talks.cam event's co_hosted edge (quiz → go), which has no other
      // evidence. go → quiz keeps its non-talks.cam sighting only.
      expect(map.edges.map((e) => `${e.type} ${e.from} ${e.to}`).sort()).toEqual([
        "co_hosted cam:org-chess cam:org-go",
        "co_hosted cam:org-chess cam:org-hidden",
        "co_hosted cam:org-chess cam:org-quiz",
        "co_hosted cam:org-faith cam:org-chess",
        "co_hosted cam:org-go cam:org-quiz",
        "sister_of cam:org-gone cam:org-chess",
        "sponsors cam:org-bank cam:org-chess",
        "sponsors cam:org-bank cam:org-quiz",
      ])
      const goQuiz = map.edges.find((e) => e.from === "cam:org-go" && e.to === "cam:org-quiz")
      expect(goQuiz?.weight).toBe(1)
      expect(map.nodes.find((n) => n.key === "org-hidden")?.hidden).toBe(true)
      expect(map.nodes.find((n) => n.key === "org-gone")?.hidden).toBe(true)
      for (const node of map.nodes) expect(node.id).toBe(`cam:${node.key}`)
    })
  })

  test("co-hosting counts hosted events only, without hidden, suppressed or talks.cam", async () => {
    await asBroker(async (_t, broker) => {
      const map = await broker.query(api.broker.graph.ecosystem, { layers: ["cohosting"] })
      expect(map.edges.map((e) => [e.type, e.from, e.to, e.weight])).toEqual([
        ["co_host", "cam:org-chess", "cam:org-faith", 1],
        ["co_host", "cam:org-chess", "cam:org-go", 1],
        ["sponsor", "cam:org-bank", "cam:org-quiz", 1],
      ])
      const years = map.edges.flatMap((e) => e.years.map((y) => y.academicYear))
      expect(years.every((year) => /^\d{4}-\d{2}$/.test(year))).toBe(true)
      expect(map.nodes.map((n) => n.key)).not.toContain("org-hidden")
    })
  })

  test("a sensitive society's people are a count, never nodes, names or keys", async () => {
    await asBroker(async (_t, broker) => {
      const map = await broker.query(api.broker.graph.ecosystem, { layers: [...ALL] })
      const faith = map.nodes.find((n) => n.key === "org-faith")
      expect(faith).toMatchObject({ sensitive: true, people: 2, interactions: 1 })
      expect(map.nodes.every((n) => n.key.startsWith("org-"))).toBe(true)
      const text = JSON.stringify(map)
      for (const secret of [ANNA, BEN, "Anna", "Ben", "President", "Invented call"]) {
        expect(text).not.toContain(secret)
      }
      // Ben's introduction counts for his society.
      expect(map.edges.find((e) => e.type === "introduction")).toMatchObject({
        from: "cam:org-bank",
        to: "cam:org-faith",
        status: "idea",
      })
    })
  })

  test("sponsors: past sponsors and sponsor relationships, never a suppressed listing", async () => {
    await asBroker(async (_t, broker) => {
      const map = await broker.query(api.broker.graph.ecosystem, { layers: ["sponsors"] })
      expect(map.edges.map((e) => [e.type, e.from, e.to])).toEqual([
        ["past_sponsor", "cam:org-bank", "cam:org-go"],
        ["sponsors", "cam:org-bank", "cam:org-chess"],
        ["sponsors", "cam:org-bank", "cam:org-quiz"],
      ])
    })
  })

  test("the campus comes from CAMSOCS_CAMPUS", async () => {
    await asBroker(async (_t, broker) => {
      await withEnv({ CAMSOCS_CAMPUS: "zz" }, async () => {
        const map = await broker.query(api.broker.graph.ecosystem, {})
        expect(map.campus).toBe("zz")
        expect(map.nodes.every((n) => n.id === `zz:${n.key}`)).toBe(true)
      })
    })
  })

  test("refuses anyone who is not a verified broker", async () => {
    await withEnv({ BROKER_EMAILS: BROKER }, async () => {
      const t = newTest()
      await seed(t)
      await expect(t.query(api.broker.graph.ecosystem, {})).rejects.toThrow("Not authorized")
      const member = await signedInAs(t, "ab123@cam.ac.uk")
      await expect(member.query(api.broker.graph.ecosystem, { layers: [...ALL] })).rejects.toThrow(
        "Not authorized",
      )
    })
  })
})
