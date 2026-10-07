import { describe, expect, test } from "bun:test"
import { api, internal } from "../_generated/api"
import type { ClaimInput } from "../ingest/claims"
import { newTest, signedInAs, type TestConvex, withEnv } from "../lib/harness.testing"

/**
 * What the broker area does with data (gating is gating.test.ts): hiding a
 * listing takes it off every public query, needs/offers verdicts survive the
 * pipeline, edits make a person the broker's, follow-ups and introductions
 * behave, the rows feed the outreach with non-personal addresses only, and
 * complementary needs/offers are matched.
 */

const BROKER = "broker@example.com"
const NOW = Date.now()

function claim(entityKey: string, field: string, value: unknown): ClaimInput {
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
  }
}

async function seed(t: TestConvex) {
  await t.mutation(internal.ingest.claims.ingest, {
    claims: [
      claim("org-chess", "name", "CU Chess Club"),
      claim("org-chess", "level", "university"),
      claim("org-chess", "categories", ["hobbies_games"]),
      claim("org-chess", "email", "ab123@cam.ac.uk"),
      claim("org-chess", "roleEmails", [{ role: "president", email: "president@cuchess.org" }]),
      claim("org-go", "name", "CU Go Society"),
      claim("org-go", "level", "university"),
      claim("org-go", "categories", ["hobbies_games"]),
      claim("org-go", "email", "xy99@cam.ac.uk"),
      claim("org-bank", "name", "Example Bank"),
      claim("org-bank", "orgType", "company"),
      claim("org-bank", "isCounterpart", true),
    ],
  })
}

async function asBroker<T>(body: (t: TestConvex, broker: TestConvex) => Promise<T>) {
  return await withEnv({ BROKER_EMAILS: BROKER }, async () => {
    const t = newTest()
    await seed(t)
    const broker = (await signedInAs(t, BROKER)) as unknown as TestConvex
    return await body(t, broker)
  })
}

async function allRows(broker: TestConvex) {
  return (
    await broker.query(api.broker.orgs.page, { paginationOpts: { numItems: 250, cursor: null } })
  ).page
}

describe("broker.orgs", () => {
  test("setHidden takes a listing off every public query, and back", async () => {
    await asBroker(async (t, broker) => {
      await broker.mutation(api.broker.orgs.setHidden, { orgKey: "org-chess", hidden: true })
      expect(await t.query(api.orgs.getBySlug, { slug: "chess" })).toBeNull()
      const listed = await t.query(api.orgs.list, {
        paginationOpts: { numItems: 50, cursor: null },
      })
      expect(listed.page.map((card) => card.key)).toEqual(["org-go"])
      expect((await t.query(api.orgs.facets, {})).total).toBe(1)
      // The broker still sees it, flagged.
      const row = (await allRows(broker)).find((r) => r.key === "org-chess")
      expect(row?.hidden).toBe(true)
      // A pipeline re-ingest does not bring it back.
      await t.mutation(internal.ingest.claims.ingest, {
        claims: [claim("org-chess", "website", "https://cuchess.org/")],
      })
      expect(await t.query(api.orgs.getBySlug, { slug: "chess" })).toBeNull()

      await broker.mutation(api.broker.orgs.setHidden, { orgKey: "org-chess", hidden: false })
      expect((await t.query(api.orgs.getBySlug, { slug: "chess" }))?.org.website).toBe(
        "https://cuchess.org/",
      )
    })
  })

  test("rows carry outreach data; personal CRSid addresses are never the best address", async () => {
    await asBroker(async (_t, broker) => {
      const rows = await allRows(broker)
      const chess = rows.find((r) => r.key === "org-chess")
      const go = rows.find((r) => r.key === "org-go")
      expect(chess?.bestAddress).toEqual({ email: "president@cuchess.org", role: "president" })
      expect(go?.bestAddress).toBeUndefined()
      expect(go?.has.email).toBe(false)
      expect(chess?.sourceHosts).toEqual(["example.org"])
      expect(chess?.heldFields).toContain("roleEmails")
      expect(chess?.missingFields).toContain("website")
      expect(rows.find((r) => r.key === "org-bank")?.isCounterpart).toBe(true)
    })
  })

  test("needs/offers verdicts: confirm, reject (survives re-inference), forget", async () => {
    await asBroker(async (t, broker) => {
      await t.mutation(internal.ingest.broker.ingest, {
        profiles: [
          {
            orgKey: "org-chess",
            needs: [
              { item: "sponsorship", sourceUrl: "https://example.org/", method: "llm" },
              { item: "venue", sourceUrl: "https://example.org/", method: "llm" },
            ],
          },
        ],
      })
      const set = (
        item: "sponsorship" | "venue" | "speakers",
        status: "confirmed" | "rejected" | null,
      ) =>
        broker.mutation(api.broker.orgs.setNeedOffer, {
          orgKey: "org-chess",
          kind: "needs",
          item,
          status,
        })
      await set("sponsorship", "confirmed")
      await set("venue", "rejected")
      await set("speakers", "confirmed")
      await t.mutation(internal.ingest.broker.ingest, {
        profiles: [
          {
            orgKey: "org-chess",
            needs: [{ item: "venue", sourceUrl: "https://example.org/", method: "llm" }],
          },
        ],
      })
      const detail = await broker.query(api.broker.orgs.detail, { key: "org-chess" })
      expect(detail?.profile?.needs.map((n) => [n.item, n.status, n.method])).toEqual([
        ["sponsorship", "confirmed", "llm"],
        ["venue", "rejected", "llm"],
        ["speakers", "confirmed", "manual"],
      ])
      // Rows hide rejected entries.
      const row = (await allRows(broker)).find((r) => r.key === "org-chess")
      expect(row?.needs.map((n) => n.item)).toEqual(["sponsorship", "speakers"])

      await set("venue", null)
      const after = await broker.query(api.broker.orgs.detail, { key: "org-chess" })
      expect(after?.profile?.needs.map((n) => n.item)).toEqual(["sponsorship", "speakers"])
    })
  })

  test("updateProfile edits only what it is given and creates the profile", async () => {
    await asBroker(async (_t, broker) => {
      await broker.mutation(api.broker.orgs.updateProfile, {
        orgKey: "org-go",
        optIns: { openToSponsors: true },
        ethicsFlags: [" fossil fuels ", "fossil fuels", ""],
        notes: "Met at the fair",
      })
      await broker.mutation(api.broker.orgs.updateProfile, {
        orgKey: "org-go",
        optIns: { openToSponsors: null, careersEvents: false },
        suppressed: true,
      })
      const profile = (await broker.query(api.broker.orgs.detail, { key: "org-go" }))?.profile
      expect(profile?.optIns).toEqual({ careersEvents: false })
      expect(profile?.ethicsFlags).toEqual(["fossil fuels"])
      expect(profile?.notes).toBe("Met at the fair")
      expect(profile?.suppressed).toBe(true)
      expect(profile?.pecrSubscriberType).toBe("unknown")
    })
  })
})

describe("broker.people", () => {
  test("create, edit (becomes manual), stale, archive", async () => {
    await asBroker(async (_t, broker) => {
      const { key } = await broker.mutation(api.broker.people.create, {
        orgKey: "org-chess",
        name: "Anna Example",
        role: "President",
        staleAfter: "2020-06-30",
      })
      await expect(
        broker.mutation(api.broker.people.create, {
          orgKey: "org-chess",
          name: "Anna  Example",
          role: "Treasurer",
        }),
      ).rejects.toThrow("already listed")
      let people = await broker.query(api.broker.people.list, {})
      expect(people).toHaveLength(1)
      expect(people[0]).toMatchObject({
        key,
        method: "manual",
        sourceUrl: "manual:broker",
        stale: true,
        staleNow: true,
        org: { key: "org-chess", name: "CU Chess Club" },
      })
      await broker.mutation(api.broker.people.update, {
        key,
        role: "Secretary",
        staleAfter: "2099-06-30",
      })
      await broker.mutation(api.broker.people.setArchived, { key, archived: true })
      people = await broker.query(api.broker.people.list, {})
      expect(people[0]).toMatchObject({ role: "Secretary", stale: false, archived: true })
    })
  })
})

describe("broker.interactions", () => {
  test("logs, lists due follow-ups, completes them", async () => {
    await asBroker(async (_t, broker) => {
      const { key } = await broker.mutation(api.broker.interactions.create, {
        date: NOW,
        orgKey: "org-chess",
        channel: "email",
        summary: "Asked about sponsorship",
        nextStep: "Send deck",
        followUpOn: "2020-01-01",
      })
      await broker.mutation(api.broker.interactions.create, {
        date: NOW,
        orgKey: "org-go",
        channel: "call",
        summary: "No follow-up needed",
      })
      await expect(
        broker.mutation(api.broker.interactions.create, {
          date: NOW,
          channel: "email",
          summary: "x",
        }),
      ).rejects.toThrow("Pick an organisation or a person")
      const due = await broker.query(api.broker.interactions.followUps, {})
      expect(due.map((row) => row.key)).toEqual([key])
      expect(due[0].org?.name).toBe("CU Chess Club")
      await broker.mutation(api.broker.interactions.completeFollowUp, { key })
      expect(await broker.query(api.broker.interactions.followUps, {})).toEqual([])
      expect(await broker.query(api.broker.interactions.list, {})).toHaveLength(2)
      expect(
        await broker.query(api.broker.interactions.list, { orgKey: "org-chess" }),
      ).toHaveLength(1)
    })
  })
})

describe("broker.introductions", () => {
  test("creates between two parties, moves on the board, refuses a self-introduction", async () => {
    await asBroker(async (_t, broker) => {
      const { key } = await broker.mutation(api.broker.introductions.create, {
        partyA: { orgKey: "org-chess" },
        partyB: { orgKey: "org-bank" },
        reason: "Chess needs a sponsor; the bank sponsors games societies",
      })
      await expect(
        broker.mutation(api.broker.introductions.create, {
          partyA: { orgKey: "org-chess" },
          partyB: { orgKey: "org-chess" },
          reason: "x",
        }),
      ).rejects.toThrow("two different parties")
      await expect(
        broker.mutation(api.broker.introductions.create, {
          partyA: { orgKey: "org-chess", personKey: "per-x" },
          partyB: { orgKey: "org-go" },
          reason: "x",
        }),
      ).rejects.toThrow("one organisation or one person")
      await broker.mutation(api.broker.introductions.update, {
        key,
        status: "sent",
        outcome: "Waiting",
      })
      const [intro] = await broker.query(api.broker.introductions.list, {})
      expect(intro).toMatchObject({ status: "sent", outcome: "Waiting" })
      expect(intro.a.org?.name).toBe("CU Chess Club")
      expect(intro.b.org?.name).toBe("Example Bank")
    })
  })
})

describe("broker.graph", () => {
  test("matches complementary needs and offers, and past sponsors of similar societies", async () => {
    await asBroker(async (t, broker) => {
      await t.mutation(internal.ingest.broker.ingest, {
        profiles: [
          {
            orgKey: "org-chess",
            needs: [{ item: "speakers", sourceUrl: "https://example.org/", method: "llm" }],
          },
          {
            orgKey: "org-go",
            needs: [{ item: "sponsorship", sourceUrl: "https://example.org/", method: "llm" }],
            offers: [{ item: "expertise", sourceUrl: "https://example.org/", method: "llm" }],
          },
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
        ],
      })
      const matches = await broker.query(api.broker.graph.matches, {})
      expect(
        matches.map((m) => [m.needKey, m.need, m.kind, m.offerKey, m.sponsoredKey ?? null]),
      ).toEqual([
        ["org-go", "sponsorship", "past_sponsor", "org-bank", "org-chess"],
        ["org-chess", "speakers", "offer", "org-go", null],
      ])
      const graph = await broker.query(api.broker.graph.relationships, {})
      expect(graph.edges).toHaveLength(1)
      expect(graph.nodes.map((n) => n.name).sort()).toEqual(["CU Chess Club", "Example Bank"])
    })
  })
})

describe("broker.listingRequests", () => {
  test("lists requests with their listing and sets their status", async () => {
    await asBroker(async (t, broker) => {
      const { key } = await t.mutation(api.listingRequests.submit, {
        kind: "remove",
        orgKey: "org-chess",
        submitterEmail: "president@cuchess.org",
        message: "Please remove our listing.",
      })
      const [request] = await broker.query(api.broker.listingRequests.list, { status: "open" })
      expect(request).toMatchObject({ key, kind: "remove", org: { key: "org-chess" } })
      await broker.mutation(api.broker.listingRequests.setStatus, { key, status: "done" })
      expect(await broker.query(api.broker.listingRequests.list, { status: "open" })).toEqual([])
      const [done] = await broker.query(api.broker.listingRequests.list, {})
      expect(done.status).toBe("done")
      expect(done.resolvedAt).toBeNumber()
    })
  })
})
