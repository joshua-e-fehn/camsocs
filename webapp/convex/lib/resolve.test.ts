import { describe, expect, test } from "bun:test"
import { ORGANISATION_SPECS } from "./fields"
import {
  baseConfidence,
  comparable,
  liveClaims,
  precedenceTier,
  type ResolvableClaim,
  resolveField,
  storedStatus,
} from "./resolve"

/**
 * docs/data-model.md §1 as executable rules. Each test names the rule it pins.
 */

const T0 = Date.UTC(2026, 9, 1)
const DAY = 24 * 60 * 60 * 1000

function claim(overrides: Partial<ResolvableClaim> = {}): ResolvableClaim {
  return {
    value: "hello@society.org",
    status: "found",
    evidence: "primary",
    method: "parser",
    sourceKey: "src-a",
    sourceUrl: "https://society.org/contact",
    sourceType: "society_website",
    retrievedAt: T0,
    reviewStatus: "accepted",
    ...overrides,
  }
}

const email = ORGANISATION_SPECS.email
const description = ORGANISATION_SPECS.description
const socials = ORGANISATION_SPECS.socials
const lastActiveAt = ORGANISATION_SPECS.lastActiveAt

describe("storedStatus (rule 2: status is normalised on the server)", () => {
  test("an LLM claim is found only with an exact or normalised quote", () => {
    const llm = { method: "llm" as const, hasValue: true }
    expect(storedStatus({ ...llm, requested: "found", quoteCheck: "exact", hasQuote: true })).toBe(
      "found",
    )
    expect(
      storedStatus({ ...llm, requested: "found", quoteCheck: "normalised", hasQuote: true }),
    ).toBe("found")
    expect(storedStatus({ ...llm, requested: "found", quoteCheck: "absent", hasQuote: true })).toBe(
      "inferred",
    )
    // A quote check that claims success without a quote is not believed.
    expect(storedStatus({ ...llm, requested: "found", quoteCheck: "exact", hasQuote: false })).toBe(
      "inferred",
    )
    expect(storedStatus({ ...llm, hasQuote: false })).toBe("inferred")
  })

  test("manual and owner claims take their own statuses; parsers default to found", () => {
    expect(storedStatus({ method: "manual", hasQuote: false, hasValue: true })).toBe("manual")
    expect(storedStatus({ method: "owner_submitted", hasQuote: false, hasValue: true })).toBe(
      "owner_confirmed",
    )
    expect(storedStatus({ method: "parser", hasQuote: false, hasValue: true })).toBe("found")
    expect(
      storedStatus({ method: "parser", requested: "inferred", hasQuote: false, hasValue: true }),
    ).toBe("inferred")
  })

  test("a claim without a value is missing or not_applicable", () => {
    expect(storedStatus({ method: "parser", hasQuote: false, hasValue: false })).toBe("missing")
    expect(
      storedStatus({
        method: "llm",
        requested: "not_applicable",
        hasQuote: false,
        hasValue: false,
      }),
    ).toBe("not_applicable")
  })
})

describe("baseConfidence (rule 3, data-model §1.1)", () => {
  test("the table", () => {
    const c = (
      method: ResolvableClaim["method"],
      status: ResolvableClaim["status"],
      evidence: ResolvableClaim["evidence"],
    ) => baseConfidence({ method, status, evidence })
    expect(c("parser", "found", "primary")).toBe(0.95)
    expect(c("parser", "found", "secondary")).toBe(0.85)
    expect(c("llm", "found", "primary")).toBe(0.85)
    expect(c("llm", "found", "secondary")).toBe(0.75)
    expect(c("llm", "inferred", "primary")).toBe(0.5)
    expect(c("manual", "manual", "secondary")).toBe(1)
    expect(c("owner_submitted", "owner_confirmed", "primary")).toBe(1)
  })
})

describe("precedenceTier (rule 4, data-model §1.2)", () => {
  test("manual/owner < found+primary < found+secondary < inferred", () => {
    expect(precedenceTier(claim({ status: "manual", method: "manual" }))).toBe(0)
    expect(precedenceTier(claim({ status: "owner_confirmed", method: "owner_submitted" }))).toBe(0)
    expect(precedenceTier(claim())).toBe(1)
    expect(precedenceTier(claim({ evidence: "secondary" }))).toBe(2)
    expect(precedenceTier(claim({ status: "inferred", method: "llm" }))).toBe(3)
  })
})

describe("liveClaims (rule 1)", () => {
  test("ignores rejected and superseded claims", () => {
    const live = liveClaims([
      claim({ reviewStatus: "rejected", sourceKey: "src-r" }),
      claim({ reviewStatus: "superseded", sourceKey: "src-s" }),
      claim({ sourceKey: "src-ok" }),
    ])
    expect(live.map((c) => c.sourceKey)).toEqual(["src-ok"])
  })

  test("keeps the newest claim per (source, method); parser and LLM on one page coexist", () => {
    const live = liveClaims([
      claim({ value: "old@x.org", retrievedAt: T0 }),
      claim({ value: "new@x.org", retrievedAt: T0 + DAY }),
      claim({ value: "llm@x.org", method: "llm", status: "inferred" }),
    ])
    expect(live.map((c) => c.value).sort()).toEqual(["llm@x.org", "new@x.org"])
  })
})

describe("resolveField — single", () => {
  test("one parser claim on the organisation's own site", () => {
    const { value, meta } = resolveField(email, [claim()])
    expect(value).toBe("hello@society.org")
    expect(meta).toMatchObject({
      status: "found",
      evidence: "primary",
      confidence: 0.95,
      sourceUrl: "https://society.org/contact",
      sourceType: "society_website",
      method: "parser",
      claimCount: 1,
      retrievedAt: T0,
    })
    expect(meta.conflicts).toBeUndefined()
  })

  test("primary beats secondary; found beats inferred; manual beats everything", () => {
    const secondary = claim({
      value: "su@cambridgesu.co.uk",
      evidence: "secondary",
      sourceKey: "src-su",
      sourceUrl: "https://www.cambridgesu.co.uk/organisation/1/",
      retrievedAt: T0 + DAY,
    })
    expect(resolveField(email, [secondary, claim()]).value).toBe("hello@society.org")

    const inferred = claim({
      value: "guess@x.org",
      status: "inferred",
      method: "llm",
      sourceKey: "src-b",
    })
    expect(resolveField(email, [inferred, secondary]).value).toBe("su@cambridgesu.co.uk")

    const manual = claim({
      value: "fixed@society.org",
      status: "manual",
      method: "manual",
      evidence: "secondary",
      sourceKey: "src-manual",
      sourceType: "manual",
      sourceUrl: "manual:joshua",
    })
    const resolved = resolveField(email, [claim(), secondary, manual])
    expect(resolved.value).toBe("fixed@society.org")
    expect(resolved.meta.status).toBe("manual")
    expect(resolved.meta.confidence).toBe(1)
  })

  test("equal-rank ties go to the most recent sighting (lastSeenAt over retrievedAt)", () => {
    const a = claim({ value: "a@x.org", sourceKey: "src-a", sourceUrl: "https://a.org" })
    const b = claim({
      value: "b@x.org",
      sourceKey: "src-b",
      sourceUrl: "https://b.org",
      retrievedAt: T0 + DAY,
    })
    expect(resolveField(email, [a, b]).value).toBe("b@x.org")
    expect(resolveField(email, [{ ...a, lastSeenAt: T0 + 2 * DAY }, b]).value).toBe("a@x.org")
  })

  test("rule 5: disagreeing equal-rank claims are conflicting and keep both readings", () => {
    const a = claim({ value: "a@x.org", sourceKey: "src-a", sourceUrl: "https://a.org" })
    const b = claim({
      value: "b@x.org",
      sourceKey: "src-b",
      sourceUrl: "https://b.org",
      retrievedAt: T0 + DAY,
    })
    const { value, meta } = resolveField(email, [a, b])
    expect(value).toBe("b@x.org")
    expect(meta.status).toBe("conflicting")
    expect(meta.conflicts).toEqual([
      {
        value: "a@x.org",
        sourceUrl: "https://a.org",
        sourceType: "society_website",
        retrievedAt: T0,
        method: "parser",
      },
    ])
  })

  test("a lower-rank disagreement is not a conflict", () => {
    const secondary = claim({
      value: "other@x.org",
      evidence: "secondary",
      sourceKey: "src-su",
      sourceUrl: "https://www.cambridgesu.co.uk/x",
    })
    expect(resolveField(email, [claim(), secondary]).meta.status).toBe("found")
  })

  test("emails compare case-insensitively; URLs ignore scheme, www and trailing slash", () => {
    const upper = claim({
      value: "HELLO@Society.org ",
      sourceKey: "src-b",
      sourceUrl: "https://other.org",
    })
    expect(resolveField(email, [claim(), upper]).meta.status).toBe("found")

    const site = ORGANISATION_SPECS.website
    const one = claim({ value: "http://www.Society.org/", sourceKey: "src-a" })
    const two = claim({
      value: "https://society.org",
      sourceKey: "src-b",
      sourceUrl: "https://b.org",
    })
    expect(resolveField(site, [one, two]).meta.status).toBe("found")
    expect(comparable("url", "http://www.X.org/path/")).toBe("x.org/path")
  })

  test("text fields never conflict: two sources' prose always differs", () => {
    const a = claim({ value: "We sing.", sourceKey: "src-a" })
    const b = claim({
      value: "A choir.",
      sourceKey: "src-b",
      sourceUrl: "https://b.org",
      retrievedAt: T0 + DAY,
    })
    const { value, meta } = resolveField(description, [a, b])
    expect(value).toBe("A choir.")
    expect(meta.status).toBe("found")
  })

  test("+0.05 per additional agreeing independent host, capped at 0.99", () => {
    const hosts = [
      "https://a.org/x",
      "https://b.org",
      "https://www.c.org",
      "https://d.org",
      "https://e.org",
    ]
    const claims = hosts.map((sourceUrl, i) => claim({ sourceUrl, sourceKey: `src-${i}` }))
    // 0.95 + 0.05 = 1.00 → capped at 0.99.
    expect(resolveField(email, claims.slice(0, 2)).meta).toMatchObject({
      confidence: 0.99,
      claimCount: 2,
    })
    const secondary = claims.map((c) => ({ ...c, evidence: "secondary" as const }))
    expect(resolveField(email, secondary.slice(0, 3)).meta.confidence).toBe(0.95)
    expect(resolveField(email, secondary).meta.claimCount).toBe(5)
  })

  test("two pages on the same host are not independent", () => {
    const a = claim({ sourceKey: "src-a", sourceUrl: "https://society.org/contact" })
    const b = claim({ sourceKey: "src-b", sourceUrl: "https://www.society.org/about" })
    const { meta } = resolveField(email, [a, b])
    expect(meta.claimCount).toBe(1)
    expect(meta.confidence).toBe(0.95)
  })
})

describe("resolveField — missing (rule 6)", () => {
  test("no claims at all: missing, not_attempted", () => {
    expect(resolveField(email, [])).toEqual({
      value: undefined,
      meta: { status: "missing", missingReason: "not_attempted" },
    })
  })

  test("an inapplicable field nobody claimed is not_applicable", () => {
    expect(resolveField(email, [], { applicable: false }).meta).toEqual({
      status: "not_applicable",
    })
  })

  test("negative claims carry their reason and provenance", () => {
    const forbidden = claim({
      value: undefined,
      status: "missing",
      missingReason: "access_restricted",
      sourceUrl: "https://www.example.org/members",
    })
    const { value, meta } = resolveField(email, [forbidden])
    expect(value).toBeUndefined()
    expect(meta).toMatchObject({
      status: "missing",
      missingReason: "access_restricted",
      sourceUrl: "https://www.example.org/members",
      method: "parser",
    })
  })

  test("a value from any source beats a negative claim from another", () => {
    const none = claim({ value: undefined, status: "missing", missingReason: "not_published" })
    const su = claim({
      value: "su@cambridgesu.co.uk",
      evidence: "secondary",
      sourceKey: "src-su",
      sourceUrl: "https://www.cambridgesu.co.uk/x",
    })
    expect(resolveField(email, [none, su]).value).toBe("su@cambridgesu.co.uk")
  })

  test("a newer negative reading from the same source and method retracts its value", () => {
    const before = claim({ retrievedAt: T0 })
    const after = claim({
      value: undefined,
      status: "missing",
      missingReason: "not_published",
      retrievedAt: T0 + DAY,
    })
    const { value, meta } = resolveField(email, [before, after])
    expect(value).toBeUndefined()
    expect(meta.missingReason).toBe("not_published")
  })

  test("not_applicable claims win over a missing default", () => {
    const na = claim({ value: undefined, status: "not_applicable" })
    expect(resolveField(email, [na]).meta.status).toBe("not_applicable")
  })

  test("an empty array is not a value", () => {
    const empty = claim({ value: [] })
    const { value, meta } = resolveField(socials, [empty])
    expect(value).toBeUndefined()
    expect(meta).toMatchObject({ status: "missing", missingReason: "not_found" })
  })
})

describe("resolveField — union", () => {
  const ig = { platform: "instagram", url: "https://instagram.com/cugs" }
  const fb = { platform: "facebook_page", url: "https://facebook.com/cugs" }

  test("unions found claims across sources, de-duplicated by normalised URL", () => {
    const su = claim({
      value: [ig],
      evidence: "secondary",
      sourceKey: "src-su",
      sourceUrl: "https://www.cambridgesu.co.uk/x",
    })
    const site = claim({ value: [{ ...ig, url: "https://www.instagram.com/cugs/" }, fb] })
    const { value, meta } = resolveField(socials, [su, site])
    expect(value).toEqual([{ ...ig, url: "https://www.instagram.com/cugs/" }, fb])
    expect(meta).toMatchObject({ status: "found", evidence: "primary", claimCount: 2 })
  })

  test("inferred items count only when nothing was found", () => {
    const tiktok = { platform: "tiktok", url: "https://tiktok.com/@cugs" }
    const guess = claim({
      value: [tiktok],
      status: "inferred",
      method: "llm",
      sourceKey: "src-llm",
    })
    expect(resolveField(socials, [guess, claim({ value: [ig] })]).value).toEqual([ig])
    expect(resolveField(socials, [guess]).value).toEqual([tiktok])
    expect(resolveField(socials, [guess]).meta.status).toBe("inferred")
  })

  test("a manual claim replaces the union", () => {
    const manual = claim({ value: [fb], status: "manual", method: "manual", sourceKey: "src-m" })
    expect(resolveField(socials, [claim({ value: [ig] }), manual]).value).toEqual([fb])
  })
})

describe("resolveField — max", () => {
  test("the latest timestamp wins regardless of precedence", () => {
    const old = claim({ value: T0 - 10 * DAY, sourceKey: "src-a" })
    const recent = claim({
      value: T0,
      evidence: "secondary",
      sourceKey: "src-b",
      sourceUrl: "https://b.org",
    })
    const { value, meta } = resolveField(lastActiveAt, [old, recent])
    expect(value).toBe(T0)
    expect(meta.sourceUrl).toBe("https://b.org")
  })
})
