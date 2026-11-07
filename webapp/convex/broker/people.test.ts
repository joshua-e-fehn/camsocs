import { describe, expect, test } from "bun:test"
import { personKey } from "../../lib/keys"
import { api, internal } from "../_generated/api"
import type { ClaimInput } from "../ingest/claims"
import { nextHandoverDate } from "../lib/derived"
import { newTest, signedInAs, type TestConvex, withEnv } from "../lib/harness.testing"
import { nameHash, suppressionKey } from "../lib/suppressions"

/**
 * What manual entries and edits in the broker's people table may hold
 * (convex/broker/people.ts): nobody who objected comes back, and officers of
 * sensitive societies (DPIA-lite §5, R-7, ENG-42) are kept only as their
 * society's own website lists them — source on that site, no links or notes,
 * no later `staleAfter`, consent only when recorded. Synthetic societies.
 */

const BROKER = "broker@example.com"
const NOW = Date.now()
const DAY = 86_400_000
const LIMIT = nextHandoverDate(NOW)
const OWN_PAGE = "https://www.quokkafaith.example.org/committee"

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
      claim("org-chess", "categories", ["hobbies_games"]),
      claim("org-faith", "name", "Quokka Faith Society"),
      claim("org-faith", "categories", ["faith"]),
      claim("org-faith", "website", "https://quokkafaith.example.org/"),
      claim("org-pride", "name", "Quokka Pride"),
      claim("org-pride", "categories", ["hobbies_games"]),
      claim("org-pride", "audiences", ["lgbtq"]),
      claim("org-mcr", "name", "Quokka College MCR Wellbeing"),
      claim("org-mcr", "categories", ["identity_wellbeing"]),
      claim("org-mcr", "website", "https://www.quokka.example.ac.uk/mcr/wellbeing"),
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

const officer = { orgKey: "org-faith", name: "Anna Example", role: "President" }

describe("broker.people: officers of sensitive societies", () => {
  test("create needs a page of the society's own website as the source", async () => {
    await asBroker(async (_t, broker) => {
      const create = (sourceUrl?: string) =>
        broker.mutation(api.broker.people.create, { ...officer, sourceUrl })
      await expect(create()).rejects.toThrow(
        "Quokka Faith Society is a sensitive society (Faith & Belief)",
      )
      await expect(create()).rejects.toThrow("Give the page of quokkafaith.example.org")
      await expect(create("https://www.linkedin.com/in/anna-example")).rejects.toThrow(
        "Give the page",
      )
      await expect(
        create("https://quokkafaith.example.org.evil.example/committee"),
      ).rejects.toThrow("Give the page")
      const { key } = await create(OWN_PAGE)
      const people = await broker.query(api.broker.people.list, {})
      expect(people.find((p) => p.key === key)).toMatchObject({
        sourceUrl: OWN_PAGE,
        staleAfter: LIMIT,
        sensitiveBecause: ["Faith & Belief"],
      })
    })
  })

  test("a society on a shared host: only pages inside its own folder", async () => {
    await asBroker(async (_t, broker) => {
      const create = (sourceUrl: string, name: string) =>
        broker.mutation(api.broker.people.create, {
          orgKey: "org-mcr",
          name,
          role: "Welfare Officer",
          sourceUrl,
        })
      await expect(
        create("https://www.quokka.example.ac.uk/mcr/sports/committee", "Ben Example"),
      ).rejects.toThrow("Give the page of www.quokka.example.ac.uk")
      await create("https://quokka.example.ac.uk/mcr/wellbeing/committee", "Ben Example")
      await create("https://www.quokka.example.ac.uk/mcr/wellbeing", "Cleo Example")
    })
  })

  test("an LGBTQ+ society with no website on record takes no officer by hand", async () => {
    await asBroker(async (_t, broker) => {
      await expect(
        broker.mutation(api.broker.people.create, {
          orgKey: "org-pride",
          name: "Dana Example",
          role: "Chair",
          sourceUrl: "https://pride.example.org/committee",
        }),
      ).rejects.toThrow("Quokka Pride is a sensitive society (LGBTQ+)")
      await expect(
        broker.mutation(api.broker.people.create, {
          orgKey: "org-pride",
          name: "Dana Example",
          role: "Chair",
        }),
      ).rejects.toThrow("no website on record")
    })
  })

  test("create refuses links, notes, a later staleAfter and unrecorded consent", async () => {
    await asBroker(async (_t, broker) => {
      const create = (extra: Record<string, unknown>) =>
        broker.mutation(api.broker.people.create, { ...officer, sourceUrl: OWN_PAGE, ...extra })
      await expect(
        create({ publicLinks: [{ platform: "linkedin", url: "https://linkedin.com/in/a" }] }),
      ).rejects.toThrow("Remove the profile links")
      await expect(create({ notes: "Met at the fair" })).rejects.toThrow("Remove the notes")
      await expect(create({ staleAfter: "2099-06-30" })).rejects.toThrow(`no later than ${LIMIT}`)
      await expect(create({ consentBasis: "consent" })).rejects.toThrow("explicit consent recorded")
      // An empty note is no note; an earlier date is fine.
      await create({ notes: "  ", staleAfter: "2020-06-30" })
    })
  })

  test("consent is accepted once it is recorded, and the record is checked", async () => {
    await asBroker(async (_t, broker) => {
      const create = (consentRecord: { recordedOn: string; evidence: string }) =>
        broker.mutation(api.broker.people.create, {
          ...officer,
          sourceUrl: OWN_PAGE,
          consentBasis: "consent",
          consentRecord,
        })
      await expect(create({ recordedOn: "2999-01-01", evidence: "Their email" })).rejects.toThrow(
        "in the future",
      )
      await expect(create({ recordedOn: "2026-11-04", evidence: " " })).rejects.toThrow(
        "consent record is required",
      )
      const { key } = await create({ recordedOn: "2026-11-04", evidence: "Their email, admin@" })
      const person = (await broker.query(api.broker.people.list, {})).find((p) => p.key === key)
      expect(person?.consentRecord).toEqual({
        recordedOn: "2026-11-04",
        evidence: "Their email, admin@",
      })
      // Taking the record away while still on consent is refused.
      await expect(
        broker.mutation(api.broker.people.update, { key, consentRecord: null }),
      ).rejects.toThrow("explicit consent recorded")
    })
  })

  test("update checks the row as it would be after the edit", async () => {
    await asBroker(async (t, broker) => {
      const { key } = await broker.mutation(api.broker.people.create, {
        ...officer,
        sourceUrl: OWN_PAGE,
        staleAfter: "2020-06-30",
      })
      // staleAfter never moves later by hand, even within the limit.
      await expect(
        broker.mutation(api.broker.people.update, { key, staleAfter: "2020-07-01" }),
      ).rejects.toThrow("cannot be moved later")
      await broker.mutation(api.broker.people.update, { key, staleAfter: "2020-06-01" })
      await expect(
        broker.mutation(api.broker.people.update, { key, notes: "Likes chess" }),
      ).rejects.toThrow("Remove the notes")
      await expect(
        broker.mutation(api.broker.people.update, { key, sourceUrl: "https://example.com/x" }),
      ).rejects.toThrow("Give the page")
      // Role and name edits that keep the rules go through.
      await broker.mutation(api.broker.people.update, { key, role: "Secretary", notes: "" })

      // Someone moved in from an ordinary society meets the rules too.
      const chess = await broker.mutation(api.broker.people.create, {
        orgKey: "org-chess",
        name: "Eve Example",
        role: "Captain",
        notes: "Met at the fair",
      })
      await expect(
        broker.mutation(api.broker.people.update, { key: chess.key, orgKey: "org-faith" }),
      ).rejects.toThrow("Give the page")
      await expect(
        broker.mutation(api.broker.people.update, {
          key: chess.key,
          orgKey: "org-faith",
          sourceUrl: OWN_PAGE,
        }),
      ).rejects.toThrow("Remove the notes")
      await broker.mutation(api.broker.people.update, {
        key: chess.key,
        orgKey: "org-faith",
        sourceUrl: OWN_PAGE,
        notes: "",
      })

      // A legacy row with links (as before the guard) is refused until they go.
      await t.run(async (ctx) => {
        const row = await ctx.db
          .query("people")
          .withIndex("by_key", (q) => q.eq("key", key))
          .unique()
        if (row) {
          await ctx.db.patch("people", row._id, {
            publicLinks: [{ platform: "linkedin", url: "https://linkedin.com/in/a" }],
          })
        }
      })
      // The list flags it until then, and the deploy audit counts it.
      const flagged = (await broker.query(api.broker.people.list, {})).find((p) => p.key === key)
      expect(flagged?.sensitiveProblem).toContain("Remove the profile links")
      expect(await t.query(internal.coverage.sensitiveOfficers, {})).toEqual({
        people: 2,
        sensitive: 2,
        manual: 2,
        withProblem: 1,
        societiesWithProblem: 1,
      })
      await expect(
        broker.mutation(api.broker.people.update, { key, role: "Treasurer" }),
      ).rejects.toThrow("Remove the profile links")
      await broker.mutation(api.broker.people.update, { key, role: "Treasurer", publicLinks: [] })
    })
  })

  test("ordinary societies keep the old freedoms", async () => {
    await asBroker(async (_t, broker) => {
      const { key } = await broker.mutation(api.broker.people.create, {
        orgKey: "org-chess",
        name: "Finn Example",
        role: "President",
        notes: "Met at the fair",
        staleAfter: "2099-06-30",
        consentBasis: "consent",
        publicLinks: [{ platform: "linkedin", url: "https://linkedin.com/in/f" }],
      })
      await broker.mutation(api.broker.people.update, { key, staleAfter: "2100-06-30" })
      const person = (await broker.query(api.broker.people.list, {})).find((p) => p.key === key)
      expect(person).toMatchObject({
        sourceUrl: "manual:broker",
        sensitiveBecause: [],
        sensitiveProblem: null,
      })
    })
  })

  test("rules tell the form what a society's officers may hold", async () => {
    await asBroker(async (_t, broker) => {
      expect(await broker.query(api.broker.people.rules, { orgKey: "org-faith" })).toEqual({
        name: "Quokka Faith Society",
        sensitiveBecause: ["Faith & Belief"],
        website: "https://quokkafaith.example.org/",
        staleAfterLimit: LIMIT,
      })
      expect(
        (await broker.query(api.broker.people.rules, { orgKey: "org-chess" }))?.sensitiveBecause,
      ).toEqual([])
      expect(await broker.query(api.broker.people.rules, { orgKey: "org-nope" })).toBeNull()
    })
  })
})

describe("broker.people: suppressions", () => {
  async function suppress(t: TestConvex, row: Record<string, string>) {
    await t.run(async (ctx) => {
      await ctx.db.insert("suppressions", {
        key: suppressionKey(row as never),
        ...(row as { scope: "person" | "name" | "organisation" }),
        createdAt: NOW,
      })
    })
  }

  test("a person who objected is not added back, at any society", async () => {
    await asBroker(async (t, broker) => {
      await suppress(t, {
        scope: "person",
        orgKey: "org-chess",
        personKey: personKey("org-chess", "Gil Example"),
      })
      const create = (name: string, orgKey = "org-chess") =>
        broker.mutation(api.broker.people.create, { orgKey, name, role: "Treasurer" })
      await expect(create("Gil Example")).rejects.toThrow("objected")
      await expect(create("Gil  Example")).rejects.toThrow("objected")

      await suppress(t, { scope: "name", valueHash: nameHash("Hana Example") })
      await expect(create("Hana Example")).rejects.toThrow("objected")
      // A title, a suffix, another case or a middle initial still names her.
      for (const variant of [
        "Dr Hana Example",
        "Hana Example (President)",
        "hana  EXAMPLE",
        "Hana J. Example",
        "Revd Hana Q Example MA",
      ]) {
        await expect(create(variant)).rejects.toThrow("objected")
      }
      // Two names that merely share a word are not her.
      await expect(create("Hana Sample")).resolves.toBeDefined()
      // An edit that renames someone into a suppressed name is refused too.
      const { key } = await create("Ivo Example")
      await expect(
        broker.mutation(api.broker.people.update, { key, name: "Hana Example" }),
      ).rejects.toThrow("objected")
      await expect(
        broker.mutation(api.broker.people.update, { key, name: "Gil Example" }),
      ).rejects.toThrow("objected")
    })
  })

  test("no one is added at a listing removed on request", async () => {
    await asBroker(async (t, broker) => {
      await suppress(t, { scope: "organisation", orgKey: "org-chess" })
      await expect(
        broker.mutation(api.broker.people.create, {
          orgKey: "org-chess",
          name: "Jo Example",
          role: "Secretary",
        }),
      ).rejects.toThrow("removed on request")
    })
  })
})

/**
 * A society whose website's latest reading failed (production, 2026-11-04:
 * 67 officers of 4 college bodies, read from the bodies' own sites, were
 * flagged once one `colleges.home` reading recorded the site `missing`
 * (unreachable or 404) and so blanked the recorded `website`). The site it
 * was last found at is still its own, so those rows meet the rules; a page
 * anywhere else does not, and `removeOffSiteSensitiveOfficers` removes such
 * pipeline rows (dry run first).
 */
describe("broker.people: officers when the society's website reading failed", () => {
  const JCR_SITE = "https://jcr.quokka.example.org/"
  const JCR_PAGE = "https://jcr.quokka.example.org/committee"

  function reading(field: string, value: unknown, at: number, extra: Partial<ClaimInput> = {}) {
    return {
      ...claim("org-jcr", field, value),
      sourceKey: "src-jcr-home",
      sourceUrl: JCR_SITE,
      retrievedAt: at,
      ...extra,
    }
  }

  /** The JCR's site found, then unreachable on a later run (same page). */
  async function seedJcr(t: TestConvex) {
    await t.mutation(internal.ingest.claims.ingest, {
      claims: [
        reading("name", "Quokka College JCR", NOW - 3 * DAY),
        reading("categories", ["identity_wellbeing"], NOW - 3 * DAY),
        reading("website", JCR_SITE, NOW - 3 * DAY),
      ],
    })
    await t.mutation(internal.ingest.claims.ingest, {
      claims: [
        reading("website", undefined, NOW - DAY, {
          status: "missing",
          missingReason: "unreachable",
        }),
      ],
    })
  }

  const pipelinePerson = (name: string, sourceUrl: string, orgKey = "org-jcr") => ({
    key: personKey(orgKey, name),
    orgKey,
    name,
    role: "Welfare Officer",
    sourceUrl,
    seenAt: NOW - 2 * DAY,
    method: "llm" as const,
  })

  test("the site it was last found at still counts as its own", async () => {
    await asBroker(async (t, broker) => {
      await seedJcr(t)
      const rules = await broker.query(api.broker.people.rules, { orgKey: "org-jcr" })
      expect(rules).toMatchObject({
        sensitiveBecause: ["Identity, Community & Wellbeing"],
        website: JCR_SITE,
      })
      await t.mutation(internal.ingest.broker.ingest, {
        people: [pipelinePerson("Jo Example", JCR_PAGE)],
      })
      const listed = (await broker.query(api.broker.people.list, {})).find(
        (p) => p.name === "Jo Example",
      )
      expect(listed?.sensitiveProblem).toBeNull()
      expect(await t.query(internal.coverage.sensitiveOfficers, {})).toMatchObject({
        sensitive: 1,
        withProblem: 0,
      })
      // By hand too, from that site only.
      await broker.mutation(api.broker.people.create, {
        orgKey: "org-jcr",
        name: "Kit Example",
        role: "Chair",
        sourceUrl: JCR_PAGE,
      })
      await expect(
        broker.mutation(api.broker.people.create, {
          orgKey: "org-jcr",
          name: "Lou Example",
          role: "Chair",
          sourceUrl: "https://elsewhere.example.org/committee",
        }),
      ).rejects.toThrow("Give the page of jcr.quokka.example.org")
    })
  })

  test("a society that never had a website found has none to fall back on", async () => {
    await asBroker(async (t, broker) => {
      await t.mutation(internal.ingest.broker.ingest, {
        people: [pipelinePerson("Max Example", "https://pride.example.org/team", "org-pride")],
      })
      const listed = (await broker.query(api.broker.people.list, {})).find(
        (p) => p.name === "Max Example",
      )
      expect(listed?.sensitiveProblem).toContain("no website on record")
      expect(
        (await broker.query(api.broker.people.rules, { orgKey: "org-pride" }))?.website,
      ).toBeUndefined()
    })
  })

  test("removeOffSiteSensitiveOfficers: a dry run counts, apply deletes pipeline rows only", async () => {
    await asBroker(async (t, broker) => {
      await seedJcr(t)
      await t.mutation(internal.ingest.broker.ingest, {
        people: [
          pipelinePerson("Jo Example", JCR_PAGE),
          pipelinePerson("Ned Example", "https://www.cambridgesu.co.uk/organisation/quokka"),
          pipelinePerson("Ola Example", "https://pride.example.org/team", "org-pride"),
          pipelinePerson("Pia Example", "https://chess.example.org/committee", "org-chess"),
        ],
      })
      // A broker's own row from elsewhere (stored before the guard) is left.
      const legacy = await broker.mutation(api.broker.people.create, {
        ...officer,
        name: "Quin Example",
        sourceUrl: OWN_PAGE,
      })
      await t.run(async (ctx) => {
        const row = await ctx.db
          .query("people")
          .withIndex("by_key", (q) => q.eq("key", legacy.key))
          .unique()
        if (row) await ctx.db.patch("people", row._id, { sourceUrl: "https://example.com/x" })
      })
      const expected = {
        complete: true,
        people: 5,
        sensitive: 4,
        offSite: 2,
        societies: 2,
        leftForReview: 1,
        otherProblems: 0,
      }
      const names = async () =>
        (await broker.query(api.broker.people.list, {})).map((p) => p.name).sort()
      const before = await names()

      const dry = await t.mutation(internal.retention.removeOffSiteSensitiveOfficers, {})
      expect(dry).toEqual({ ...expected, applied: false, deleted: 0 })
      expect(await names()).toEqual(before)

      const applied = await t.mutation(internal.retention.removeOffSiteSensitiveOfficers, {
        apply: true,
      })
      expect(applied).toEqual({ ...expected, applied: true, deleted: 2 })
      expect(await names()).toEqual(["Jo Example", "Pia Example", "Quin Example"])
      expect(await t.query(internal.coverage.sensitiveOfficers, {})).toMatchObject({
        withProblem: 1, // the broker's own row, for Joshua
        societiesWithProblem: 1,
      })

      // Idempotent: nothing left to remove.
      expect(
        await t.mutation(internal.retention.removeOffSiteSensitiveOfficers, { apply: true }),
      ).toMatchObject({ offSite: 0, deleted: 0, leftForReview: 1 })
    })
  })
})
