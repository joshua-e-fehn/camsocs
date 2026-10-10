import { describe, expect, test } from "bun:test"
import { sha256Hex } from "../lib/hash"
import { api, internal } from "./_generated/api"
import type { ClaimInput } from "./ingest/claims"
import { newTest, signedInAs, type TestConvex, withEnv } from "./lib/harness.testing"
import { nameHash } from "./lib/suppressions"

/**
 * Accepting listing requests (convex/broker/listingRequests.ts): corrections
 * become `owner_submitted` claims; removals and objections become
 * suppressions that hide what they name at once and keep every later harvest
 * from bringing it back (convex/lib/suppressions.ts) — and can be lifted.
 */

const BROKER = "broker@example.com"
const NOW = Date.now()

function claim(entityKey: string, field: string, value: unknown, url = "https://cuchess.org/") {
  return {
    entityType: "organisation",
    entityKey,
    field,
    value,
    evidence: "primary",
    method: "parser",
    extractor: "test",
    sourceKey: `src-${url.length}`,
    sourceUrl: url,
    sourceType: "society_website",
    retrievedAt: NOW - 60_000,
  } satisfies ClaimInput
}

const SEED: ClaimInput[] = [
  claim("org-chess", "name", "CU Chess Club"),
  claim("org-chess", "level", "university"),
  claim("org-chess", "website", "https://cuchess.org/"),
  claim("org-chess", "description", "We play chess. Write to anna.smith@gmail.com to join."),
  claim("org-chess", "email", "chess@cuchess.org"),
  claim("org-chess", "roleEmails", [
    { role: "president", email: "anna.smith@gmail.com" },
    { role: "secretary", email: "secretary@cuchess.org" },
  ]),
  claim("org-go", "name", "CU Go Society", "https://cugo.org/"),
  claim("org-go", "level", "university", "https://cugo.org/"),
]

async function asBroker<T>(body: (t: TestConvex, broker: TestConvex) => Promise<T>) {
  return await withEnv({ BROKER_EMAILS: BROKER }, async () => {
    const t = newTest()
    await t.mutation(internal.ingest.claims.ingest, { claims: SEED })
    const broker = (await signedInAs(t, BROKER)) as unknown as TestConvex
    return await body(t, broker)
  })
}

async function request(
  t: TestConvex,
  kind: "claim" | "correct" | "remove" | "object",
  fields?: Record<string, string>,
) {
  const { key } = await t.mutation(api.listingRequests.submit, {
    kind,
    orgKey: "org-chess",
    submitterEmail: "secretary@cuchess.org",
    message: "Please update our listing, thank you.",
    ...(fields ? { fields } : {}),
  })
  return key
}

const publicChess = (t: TestConvex) => t.query(api.orgs.getBySlug, { slug: "chess" })

describe("accepting a correction", () => {
  test("writes owner_submitted claims that outrank every harvested reading", async () => {
    await asBroker(async (t, broker) => {
      const key = await request(t, "correct", { website: "https://chess.example.org/" })
      const result = await broker.mutation(api.broker.listingRequests.acceptCorrections, {
        key,
        corrections: [
          { field: "website", value: "https://chess.example.org/" },
          { field: "categories", value: ["hobbies_games"] },
        ],
      })
      expect(result.appliedFields).toEqual(["website", "categories"])

      const listing = await publicChess(t)
      expect(listing?.org.website).toBe("https://chess.example.org/")
      expect(listing?.org.categories).toEqual(["hobbies_games"])
      expect(listing?.org.meta.website).toMatchObject({
        status: "owner_confirmed",
        method: "owner_submitted",
        confidence: 1,
      })
      // The request is the source: internal, never shown.
      expect(listing?.org.meta.website.sourceUrl).toBeUndefined()

      // A later harvest of the old site does not undo the owner's value.
      await t.mutation(internal.ingest.claims.ingest, {
        claims: [claim("org-chess", "website", "https://old.cuchess.org/", "https://su.example/")],
      })
      expect((await publicChess(t))?.org.website).toBe("https://chess.example.org/")

      const [row] = await broker.query(api.broker.listingRequests.list, { status: "accepted" })
      expect(row.outcome?.appliedFields).toEqual(["website", "categories"])
      expect(row.resolvedAt).toBeNumber()
    })
  })

  test("one refused value refuses them all; only claims and corrections qualify", async () => {
    await asBroker(async (t, broker) => {
      const key = await request(t, "claim")
      await expect(
        broker.mutation(api.broker.listingRequests.acceptCorrections, {
          key,
          corrections: [
            { field: "shortName", value: "CUCC" },
            { field: "website", value: "cuchess dot org" },
          ],
        }),
      ).rejects.toThrow(/website/)
      expect((await publicChess(t))?.org.shortName).toBeUndefined()
      const [row] = await broker.query(api.broker.listingRequests.list, {})
      expect(row.status).toBe("open")

      await expect(
        broker.mutation(api.broker.listingRequests.acceptCorrections, {
          key,
          corrections: [{ field: "logo", value: { sourceUrl: "https://x.org/l.png" } }],
        }),
      ).rejects.toThrow(/cannot be corrected/)
      const removal = await request(t, "remove")
      await expect(
        broker.mutation(api.broker.listingRequests.acceptCorrections, {
          key: removal,
          corrections: [{ field: "shortName", value: "CUCC" }],
        }),
      ).rejects.toThrow(/claim or a correction/)
    })
  })
})

describe("accepting a removal", () => {
  test("a whole listing: hidden at once, nothing re-harvested, lifted only explicitly", async () => {
    await asBroker(async (t, broker) => {
      const key = await request(t, "remove")
      const { suppressionKeys } = await broker.mutation(api.broker.listingRequests.acceptRemoval, {
        key,
        scope: "organisation",
      })
      expect(suppressionKeys).toHaveLength(1)
      expect(await publicChess(t)).toBeNull()
      const rows = (
        await broker.query(api.broker.orgs.page, {
          paginationOpts: { numItems: 50, cursor: null },
        })
      ).page
      expect(rows.find((row) => row.key === "org-chess")).toMatchObject({
        hidden: true,
        suppressed: true,
      })

      // The pipeline's backstops: claims, edges and inferences are refused.
      const ingest = await t.mutation(internal.ingest.claims.ingest, {
        claims: [claim("org-chess", "shortName", "CUCC")],
      })
      expect(ingest.rejected[0]?.reason).toMatch(/suppressed/)
      const edges = await t.mutation(internal.ingest.relationships.upsert, {
        relationships: [
          {
            fromKey: "org-go",
            toKey: "org-chess",
            type: "partner_of",
            evidence: { sourceUrl: "https://cugo.org/", seenAt: NOW },
            method: "parser",
            evidenceKind: "primary",
          },
        ],
      })
      expect(edges.suppressed).toBe(1)
      expect(await t.query(internal.ingest.suppressions.list, {})).toMatchObject({
        organisations: ["org-chess"],
        truncated: false,
      })

      // Showing it again needs the suppression lifted first.
      await expect(
        broker.mutation(api.broker.orgs.setHidden, { orgKey: "org-chess", hidden: false }),
      ).rejects.toThrow(/lift/)
      const [entry] = await broker.query(api.broker.suppressions.list, { orgKey: "org-chess" })
      expect(entry).toMatchObject({ scope: "organisation", requestKey: key, contact: false })
      await broker.mutation(api.broker.suppressions.lift, { key: entry.key })
      expect(await publicChess(t)).toBeNull()
      // Outreach, which the suppression alone turned off, is back on.
      const lifted = (
        await broker.query(api.broker.orgs.page, {
          paginationOpts: { numItems: 50, cursor: null },
        })
      ).page.find((row) => row.key === "org-chess")
      expect(lifted).toMatchObject({ hidden: true, suppressed: false })
      await broker.mutation(api.broker.orgs.setHidden, { orgKey: "org-chess", hidden: false })
      expect((await publicChess(t))?.org.name).toBe("CU Chess Club")
    })
  })

  test("one field: set aside, reads not_published, stays out on re-harvest, comes back on lift", async () => {
    await asBroker(async (t, broker) => {
      const key = await request(t, "object")
      await broker.mutation(api.broker.listingRequests.acceptRemoval, {
        key,
        scope: "field",
        fields: ["description"],
      })
      let listing = await publicChess(t)
      expect(listing?.org.description).toBeUndefined()
      expect(listing?.org.meta.description).toMatchObject({
        status: "missing",
        missingReason: "not_published",
      })
      // Not one to ask visitors to complete, either.
      expect(listing?.org.missingFields).not.toContain("description")
      // Neither the same reading posted again nor a new one gets in.
      const again = await t.mutation(internal.ingest.claims.ingest, {
        claims: [
          claim(
            "org-chess",
            "description",
            "We play chess. Write to anna.smith@gmail.com to join.",
          ),
          claim("org-chess", "description", "Chess for all.", "https://other.example/"),
        ],
      })
      expect(again.rejected.map((item) => item.reason)).toEqual([
        "suppressed: description was removed from this listing on request",
        "suppressed: description was removed from this listing on request",
      ])
      expect((await publicChess(t))?.org.description).toBeUndefined()

      await expect(
        broker.mutation(api.broker.listingRequests.acceptRemoval, {
          key,
          scope: "field",
          fields: ["name"],
        }),
      ).rejects.toThrow(/cannot be removed/)

      // Set aside, the reading keeps no value, original or quote: the
      // minimal record the privacy notice promises.
      const kept = await t.run(async (ctx) =>
        (await ctx.db.query("fieldClaims").collect()).filter(
          (row) => row.entityKey === "org-chess" && row.field === "description",
        ),
      )
      const setAside = kept.filter((row) => row.reviewStatus === "rejected")
      expect(setAside).toHaveLength(1)
      expect(setAside[0]).toMatchObject({ setAsideBy: expect.any(String) })
      expect(setAside[0].value).toBeUndefined()
      expect(setAside[0].valueRaw).toBeUndefined()

      const [entry] = await broker.query(api.broker.suppressions.list, { orgKey: "org-chess" })
      await broker.mutation(api.broker.suppressions.lift, { key: entry.key })
      // Lifted: the set-aside reading is gone; the next harvest records it afresh.
      await t.mutation(internal.ingest.claims.ingest, { claims: SEED })
      listing = await publicChess(t)
      expect(listing?.org.description).toContain("We play chess")
    })
  })

  test("one contact address: gone from every field, refused everywhere, kept only as a hash", async () => {
    await asBroker(async (t, broker) => {
      const key = await request(t, "object")
      await broker.mutation(api.broker.listingRequests.acceptRemoval, {
        key,
        scope: "contact",
        address: " Anna.Smith@gmail.com ",
      })
      const listing = await publicChess(t)
      expect(listing?.org.roleEmails.map((entry) => entry.email)).not.toContain(
        "anna.smith@gmail.com",
      )
      expect(listing?.org.description ?? "").not.toContain("anna.smith")
      expect(listing?.org.email).toBe("chess@cuchess.org")

      const route = await t.query(internal.ingest.suppressions.list, {})
      expect(route.contactHashes).toEqual([sha256Hex("anna.smith@gmail.com")])
      const stored = await t.run(async (ctx) => await ctx.db.query("suppressions").take(100))
      expect(JSON.stringify(stored)).not.toContain("anna")

      // Another listing quoting the address is refused too.
      const ingest = await t.mutation(internal.ingest.claims.ingest, {
        claims: [claim("org-go", "email", "anna.smith@gmail.com", "https://cugo.org/")],
      })
      expect(ingest.rejected[0]?.reason).toMatch(/contact address/)

      const [entry] = await broker.query(api.broker.suppressions.list, { orgKey: "org-chess" })
      expect(entry.contact).toBe(true)
      await broker.mutation(api.broker.suppressions.lift, { key: entry.key })
      await t.finishAllScheduledFunctions(() => {})
      await t.mutation(internal.ingest.claims.ingest, { claims: SEED })
      expect((await publicChess(t))?.org.roleEmails.map((entry) => entry.email).sort()).toEqual([
        "anna.smith@gmail.com",
        "secretary@cuchess.org",
      ])
    })
  })

  test("a contact address leaves every listing and event that quotes it", async () => {
    await asBroker(async (t, broker) => {
      // Another listing and an event quote the address too.
      const eventKey = "evt-6d6f636b6d6f636b6d6f636b6d6f636b6d6f636b"
      const at = (field: string, value: unknown) => ({
        ...claim(eventKey, field, value, "https://cugo.org/events"),
        entityType: "event" as const,
        sourceType: "society_website" as const,
      })
      await t.mutation(internal.ingest.claims.ingest, {
        claims: [
          claim("org-go", "description", "Go club. Ask anna.smith@gmail.com.", "https://cugo.org/"),
          at("title", "Go night"),
          at("startsAt", NOW + 86_400_000),
          at("visibility", "public"),
          at("source", "website"),
          at("externalId", "org-go:go-night"),
          at("sourceUrl", "https://cugo.org/events"),
          at("description", "Questions to anna.smith@gmail.com."),
        ],
      })
      // Before any walk reaches them, the projections already cut it out.
      await t.run(async (ctx) => {
        await ctx.db.insert("suppressions", {
          key: "sup-backstop",
          scope: "contact",
          valueHash: sha256Hex("anna.smith@gmail.com"),
          createdAt: NOW,
        })
      })
      const event = await t.query(api.events.get, { key: eventKey })
      expect(event?.description).toBe("Questions to [address removed].")
      const listed = await t.query(api.events.list, { from: NOW, to: NOW + 7 * 86_400_000 })
      expect(listed.map((row) => row.title)).toEqual(["Go night"])
      expect((await t.query(api.orgs.getBySlug, { slug: "go" }))?.org.description).toBe(
        "Go club. Ask [address removed].",
      )
      await t.run(async (ctx) => {
        const row = await ctx.db
          .query("suppressions")
          .withIndex("by_key", (q) => q.eq("key", "sup-backstop"))
          .unique()
        if (row) await ctx.db.delete("suppressions", row._id)
      })

      // Accepted: the walk sets aside every claim that quotes it.
      const key = await request(t, "object")
      await broker.mutation(api.broker.listingRequests.acceptRemoval, {
        key,
        scope: "contact",
        address: "anna.smith@gmail.com",
      })
      await t.finishAllScheduledFunctions(() => {})
      expect((await t.query(api.events.get, { key: eventKey }))?.description).toBeUndefined()
      const go = await t.query(api.orgs.getBySlug, { slug: "go" })
      expect(go?.org.description).toBeUndefined()
      const stored = await t.run(async (ctx) => await ctx.db.query("fieldClaims").collect())
      expect(JSON.stringify(stored.map((row) => [row.value, row.valueRaw]))).not.toContain(
        "anna.smith",
      )
    })
  })

  test("a named person: the broker row goes and is never re-added", async () => {
    await asBroker(async (t, broker) => {
      const person = {
        key: `per-${"a".repeat(40)}`,
        orgKey: "org-chess",
        name: "Anna",
        role: "President",
        sourceUrl: "https://cuchess.org/committee",
        seenAt: NOW,
        method: "llm" as const,
      }
      await t.mutation(internal.ingest.broker.ingest, { people: [person] })
      const key = await request(t, "object")
      await broker.mutation(api.broker.listingRequests.acceptRemoval, {
        key,
        scope: "person",
        personKeys: [person.key],
      })
      expect(await broker.query(api.broker.people.list, {})).toEqual([])
      const again = await t.mutation(internal.ingest.broker.ingest, { people: [person] })
      expect(again.suppressed).toBe(1)
      expect(await broker.query(api.broker.people.list, {})).toEqual([])
      await expect(
        broker.mutation(api.broker.listingRequests.acceptRemoval, {
          key,
          scope: "person",
          personKeys: [`per-${"b".repeat(40)}`],
        }),
      ).rejects.toThrow(/not recorded/)
    })
  })
})

describe("events and names", () => {
  const eventKey = "evt-6576656e746576656e746576656e746576656e74"
  const at = (field: string, value: unknown, key = eventKey) => ({
    ...claim(key, field, value, "https://cugo.org/events"),
    entityType: "event" as const,
  })
  const goNight = (description: string, key = eventKey) => [
    at("title", "Go night", key),
    at("startsAt", NOW + 86_400_000, key),
    at("visibility", "public", key),
    at("source", "website", key),
    at("externalId", `org-go:${key}`, key),
    at("sourceUrl", "https://cugo.org/events", key),
    at("description", description, key),
  ]

  test("an event: removed at once, never recorded again", async () => {
    await asBroker(async (t, broker) => {
      await t.mutation(internal.ingest.claims.ingest, { claims: goNight("Come and play.") })
      expect((await t.query(api.events.get, { key: eventKey }))?.title).toBe("Go night")
      const key = await request(t, "object")
      await expect(
        broker.mutation(api.broker.listingRequests.acceptRemoval, {
          key,
          scope: "event",
          eventKeys: ["not-an-event"],
        }),
      ).rejects.toThrow(/Not an event key/)
      await broker.mutation(api.broker.listingRequests.acceptRemoval, {
        key,
        scope: "event",
        eventKeys: [eventKey],
      })
      expect(await t.query(api.events.get, { key: eventKey })).toBeNull()
      const again = await t.mutation(internal.ingest.claims.ingest, {
        claims: goNight("Come and play."),
      })
      expect(again.rejected[0]?.reason).toMatch(/event was removed/)
      expect(await t.query(api.events.get, { key: eventKey })).toBeNull()
      const [entry] = await broker.query(api.broker.suppressions.list, {})
      expect(entry).toMatchObject({ scope: "event", eventKey, name: false })
    })
  })

  test("one name is one hash here and in the pipeline", () => {
    // Shared with pipeline/src/tests/test_suppressions.py.
    expect(nameHash("Anna-Lena Ó Bríen")).toBe(
      "93db1c9b776578519dcba3ae13c01ce85d7baf40a6e4d3de3b7f20973bec4774",
    )
  })

  test("a person's name: cut out of every text, refused, kept only as a hash", async () => {
    await asBroker(async (t, broker) => {
      await t.mutation(internal.ingest.claims.ingest, {
        claims: [
          ...goNight("A talk by Anna Example on openings."),
          claim("org-go", "description", "Founded by ANNA EXAMPLE in 1990.", "https://cugo.org/"),
        ],
      })
      // The projection backstop, before any walk.
      await t.run(async (ctx) => {
        await ctx.db.insert("suppressions", {
          key: "sup-name-backstop",
          scope: "name",
          valueHash: nameHash("Anna Example"),
          createdAt: NOW,
        })
      })
      expect((await t.query(api.events.get, { key: eventKey }))?.description).toBe(
        "A talk by [name removed] on openings.",
      )
      expect((await t.query(api.orgs.getBySlug, { slug: "go" }))?.org.description).toBe(
        "Founded by [name removed] in 1990.",
      )
      await t.run(async (ctx) => {
        const row = await ctx.db
          .query("suppressions")
          .withIndex("by_key", (q) => q.eq("key", "sup-name-backstop"))
          .unique()
        if (row) await ctx.db.delete("suppressions", row._id)
      })

      const key = await request(t, "object")
      await expect(
        broker.mutation(api.broker.listingRequests.acceptRemoval, {
          key,
          scope: "name",
          name: "Anna",
        }),
      ).rejects.toThrow(/full name/)
      await broker.mutation(api.broker.listingRequests.acceptRemoval, {
        key,
        scope: "name",
        name: " anna  example ",
      })
      await t.finishAllScheduledFunctions(() => {})
      expect((await t.query(api.events.get, { key: eventKey }))?.description).toBeUndefined()
      expect((await t.query(api.orgs.getBySlug, { slug: "go" }))?.org.description).toBeUndefined()
      const refused = await t.mutation(internal.ingest.claims.ingest, {
        claims: [claim("org-chess", "howToJoin", "Write to Anna Example.")],
      })
      expect(refused.rejected[0]?.reason).toMatch(/names a person/)
      const stored = await t.run(async (ctx) => ({
        suppressions: await ctx.db.query("suppressions").collect(),
        claims: await ctx.db.query("fieldClaims").collect(),
      }))
      expect(JSON.stringify(stored).toLowerCase()).not.toContain("anna example")
      const route = await t.query(internal.ingest.suppressions.list, {})
      expect(route.nameHashes).toEqual([nameHash("Anna Example")])
    })
  })
})

describe("the public projection", () => {
  test("drops a suppressed field even if the stored row still had it", async () => {
    await asBroker(async (t) => {
      await t.run(async (ctx) => {
        await ctx.db.insert("suppressions", {
          key: "sup-test",
          scope: "field",
          orgKey: "org-chess",
          field: "website",
          createdAt: NOW,
        })
      })
      const listing = await publicChess(t)
      expect(listing?.org.website).toBeUndefined()
      expect(listing?.org.meta.website).toEqual({
        status: "missing",
        missingReason: "not_published",
      })
    })
  })
})
