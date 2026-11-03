import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import { api, internal } from "./_generated/api"
import type { ClaimInput } from "./ingest/claims"
import { newTest, type TestConvex } from "./lib/harness.testing"
import {
  GLOBAL_PER_DAY,
  GLOBAL_PER_HOUR,
  LISTING_RESERVE_PER_DAY,
  PER_EMAIL_PER_DAY,
  PER_EMAIL_PER_HOUR,
  PER_LISTING_PER_DAY,
  PER_LISTING_PER_HOUR,
  REMOVAL_PER_HOUR,
  RESERVE_PER_HOUR,
} from "./listingRequests"

/**
 * The public claim / correct / remove / object / add form's mutation: what it
 * stores, what it refuses, and the limits a script calling it directly runs
 * into (ENG-35), with removals always kept open somewhere.
 */

const HOUR = 60 * 60 * 1000
const START = Date.parse("2026-11-03T09:00:00Z")

afterEach(() => {
  setSystemTime()
})

function nameClaim(key: string, name: string): ClaimInput {
  return {
    entityType: "organisation",
    entityKey: key,
    field: "name",
    value: name,
    evidence: "primary",
    method: "parser",
    extractor: "test",
    sourceKey: "src-site",
    sourceUrl: "https://example.org/",
    sourceType: "society_website",
    retrievedAt: START - 60_000,
  }
}

/** `org-chess` plus `extra` listings `org-soc-<i>`. */
async function seed(t: TestConvex, extra = 0) {
  await t.mutation(internal.ingest.claims.ingest, {
    claims: [
      nameClaim("org-chess", "CU Chess Club"),
      ...Array.from({ length: extra }, (_, i) => nameClaim(`org-soc-${i}`, `Society ${i}`)),
    ],
  })
}

let sender = 0
/** A request from a fresh throwaway address each time, as a flood would send. */
function junk(kind: "claim" | "correct" | "remove" | "object" | "add", orgKey?: string) {
  sender += 1
  return {
    kind,
    ...(orgKey === undefined ? {} : { orgKey }),
    submitterEmail: `x${sender}@example.org`,
    message: `Junk request number ${sender}.`,
  }
}

async function fill(t: TestConvex, count: number, request: () => ReturnType<typeof junk>) {
  for (let i = 0; i < count; i++) await t.mutation(api.listingRequests.submit, request())
}

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
    // The stamp the limits count holds no address and no text.
    const stamps = await t.run(async (ctx) => await ctx.db.query("listingRequestSubmits").collect())
    expect(stamps.map(({ budget, orgKey }) => ({ budget, orgKey }))).toEqual([
      { budget: "other", orgKey: "org-chess" },
    ])
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
    for (let i = 0; i < PER_EMAIL_PER_HOUR; i++) {
      await t.mutation(api.listingRequests.submit, {
        ...request,
        message: `${request.message} ${i}`,
      })
    }
    await expect(t.mutation(api.listingRequests.submit, request)).rejects.toThrow(/in an hour/)
  })

  test("an address gets a daily cap as well as an hourly one", async () => {
    const t = newTest()
    await seed(t, 4)
    let at = START
    let sent = 0
    while (sent < PER_EMAIL_PER_DAY) {
      setSystemTime(at)
      for (let i = 0; i < PER_EMAIL_PER_HOUR && sent < PER_EMAIL_PER_DAY; i++, sent++) {
        await t.mutation(api.listingRequests.submit, {
          ...request,
          // Spread over listings, so only the address limit is in play.
          orgKey: `org-soc-${sent % 4}`,
          message: `${request.message} ${sent}`,
        })
      }
      at += HOUR + 1
    }
    setSystemTime(at)
    await expect(
      t.mutation(api.listingRequests.submit, { ...request, orgKey: "org-soc-0" }),
    ).rejects.toThrow(/today/)
    setSystemTime(START + 24 * HOUR + 1)
    const { key } = await t.mutation(api.listingRequests.submit, request)
    expect(key).toMatch(/^lr-/)
  })
})

describe("listingRequests.submit — a flood aimed at one listing", () => {
  test("stops at the listing's hourly and daily caps, and leaves its removals and other listings open", async () => {
    const t = newTest()
    await seed(t, 1)
    setSystemTime(START)
    await fill(t, PER_LISTING_PER_HOUR, () => junk("correct", "org-chess"))
    await expect(
      t.mutation(api.listingRequests.submit, junk("claim", "org-chess")),
    ).rejects.toThrow(/This listing has had a lot of requests.*camsocs@joshua-fehn\.de/)
    // Removals have their own budget, on the listing as overall.
    const removal = await t.mutation(api.listingRequests.submit, junk("remove", "org-chess"))
    expect(removal.key).toMatch(/^lr-/)
    const elsewhere = await t.mutation(api.listingRequests.submit, junk("correct", "org-soc-0"))
    expect(elsewhere.key).toMatch(/^lr-/)

    // An hour on, the hourly cap has passed but the daily one holds.
    setSystemTime(START + HOUR + 1)
    await fill(t, PER_LISTING_PER_DAY - PER_LISTING_PER_HOUR, () => junk("correct", "org-chess"))
    setSystemTime(START + 2 * HOUR + 2)
    await expect(
      t.mutation(api.listingRequests.submit, junk("correct", "org-chess")),
    ).rejects.toThrow(/This listing/)
    // A day after the first, it is open again; stamps older than a day go.
    setSystemTime(START + 24 * HOUR + 1)
    await t.mutation(api.listingRequests.submit, junk("correct", "org-chess"))
    const stamps = await t.run(async (ctx) => await ctx.db.query("listingRequestSubmits").collect())
    expect(stamps.every((stamp) => stamp.submittedAt > START)).toBe(true)
  })
})

describe("listingRequests.submit — a flood spread over the site", () => {
  test("uses up the overall budget, yet every listing it missed still takes its first requests", async () => {
    const t = newTest()
    const listings = GLOBAL_PER_HOUR / PER_LISTING_PER_HOUR
    await seed(t, listings + 1)
    setSystemTime(START)
    let n = 0
    await fill(t, GLOBAL_PER_HOUR, () => junk("correct", `org-soc-${n++ % listings}`))
    // An addition has no listing, so no reserve: the form is busy.
    await expect(t.mutation(api.listingRequests.submit, junk("add"))).rejects.toThrow(
      /The form is busy; please try again later, or write to camsocs@joshua-fehn\.de/,
    )
    // A flooded listing is at its own cap.
    await expect(
      t.mutation(api.listingRequests.submit, junk("claim", "org-soc-0")),
    ).rejects.toThrow(/This listing/)
    // A listing the flood never reached still takes its first requests...
    const untouched = `org-soc-${listings}`
    for (let i = 0; i < LISTING_RESERVE_PER_DAY; i++) {
      const { key } = await t.mutation(api.listingRequests.submit, junk("claim", untouched))
      expect(key).toMatch(/^lr-/)
    }
    // ...then waits for the overall budget like the rest.
    await expect(t.mutation(api.listingRequests.submit, junk("claim", untouched))).rejects.toThrow(
      /busy/,
    )
    // Removals are on their own budget throughout.
    const { key } = await t.mutation(api.listingRequests.submit, junk("remove", "org-soc-1"))
    expect(key).toMatch(/^lr-/)
  })

  test("a flood of every listing's reserved requests stops at the reserve ceiling", async () => {
    const t = newTest()
    const ceiling = GLOBAL_PER_HOUR + RESERVE_PER_HOUR
    const listings = ceiling / LISTING_RESERVE_PER_DAY
    await seed(t, listings + 1)
    setSystemTime(START)
    // Only each listing's reserved requests, on more listings than the cap
    // alone would allow: they pass the cap, then stop at the ceiling.
    let n = 0
    await fill(t, ceiling, () =>
      junk("correct", `org-soc-${Math.floor(n++ / LISTING_RESERVE_PER_DAY)}`),
    )
    const accepted = await t.run(
      async (ctx) => (await ctx.db.query("listingRequestSubmits").collect()).length,
    )
    expect(accepted).toBe(ceiling)
    await expect(
      t.mutation(api.listingRequests.submit, junk("claim", `org-soc-${listings}`)),
    ).rejects.toThrow(/The form is busy/)
    await expect(t.mutation(api.listingRequests.submit, junk("add"))).rejects.toThrow(/busy/)
    // Removals keep their own budget.
    const { key } = await t.mutation(api.listingRequests.submit, junk("remove", "org-soc-0"))
    expect(key).toMatch(/^lr-/)
    // An hour on, the hourly ceiling has passed.
    setSystemTime(START + HOUR + 1)
    const later = await t.mutation(api.listingRequests.submit, junk("claim", `org-soc-${listings}`))
    expect(later.key).toMatch(/^lr-/)
  })

  test("the overall daily cap holds after the hourly one resets", async () => {
    const t = newTest()
    const listings = GLOBAL_PER_DAY / PER_LISTING_PER_DAY
    await seed(t, listings + 1)
    let n = 0
    for (let hour = 0; hour * GLOBAL_PER_HOUR < GLOBAL_PER_DAY; hour++) {
      setSystemTime(START + hour * (HOUR + 1))
      await fill(t, Math.min(GLOBAL_PER_HOUR, GLOBAL_PER_DAY - hour * GLOBAL_PER_HOUR), () =>
        junk("correct", `org-soc-${n++ % listings}`),
      )
    }
    setSystemTime(START + 5 * HOUR)
    await expect(t.mutation(api.listingRequests.submit, junk("add"))).rejects.toThrow(/busy/)
  })

  test("a flood of other requests cannot lock out a removal, nor a flood of removals the others", async () => {
    const t = newTest()
    const listings = REMOVAL_PER_HOUR / PER_LISTING_PER_HOUR
    await seed(t, listings)
    setSystemTime(START)
    let n = 0
    await fill(t, REMOVAL_PER_HOUR, () => junk("object", `org-soc-${n++ % listings}`))
    await expect(
      t.mutation(api.listingRequests.submit, junk("remove", "org-soc-0")),
    ).rejects.toThrow(/This listing/)
    const { key } = await t.mutation(api.listingRequests.submit, junk("add"))
    expect(key).toMatch(/^lr-/)
    const correction = await t.mutation(api.listingRequests.submit, junk("correct", "org-soc-0"))
    expect(correction.key).toMatch(/^lr-/)
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
