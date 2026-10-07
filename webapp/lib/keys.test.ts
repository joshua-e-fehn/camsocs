import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { sha1Hex, sha256Hex } from "./hash"
import {
  canonicalJson,
  claimFingerprint,
  eventKey,
  orgKey,
  orgSlugFromKey,
  personKey,
  relationshipKey,
  sessionKey,
  slugify,
  sourceKey,
  teamKey,
  venueKey,
} from "./keys"
import fixtures from "./keys.fixtures.json"

/**
 * The key contract shared with the pipeline. `keys.fixtures.json` is asserted
 * here *and* by pipeline/src/tests/test_keys.py, so the two implementations
 * cannot drift without one suite failing.
 */

describe("hash", () => {
  test("matches node:crypto for ASCII, multi-byte UTF-8 and multi-block input", () => {
    for (const input of ["", "abc", "Grüße, 世界", "x".repeat(1_000), "🎓 camsocs"]) {
      expect(sha1Hex(input)).toBe(createHash("sha1").update(input, "utf8").digest("hex"))
      expect(sha256Hex(input)).toBe(createHash("sha256").update(input, "utf8").digest("hex"))
    }
  })

  test("matches the shared fixtures", () => {
    for (const { input, sha1, sha256 } of fixtures.hashes) {
      expect(sha1Hex(input)).toBe(sha1)
      expect(sha256Hex(input)).toBe(sha256)
    }
  })
})

describe("slugify", () => {
  test("matches the shared fixtures", () => {
    for (const { input, slug } of fixtures.slugify) expect(slugify(input)).toBe(slug)
  })

  test("refuses names with nothing ASCII left", () => {
    for (const input of fixtures.slugifyErrors) expect(() => slugify(input)).toThrow()
  })

  test("apostrophes vanish, ampersands become 'and', accents fold", () => {
    expect(slugify("Queens' College")).toBe("queens-college")
    expect(slugify("Arts & Crafts")).toBe("arts-and-crafts")
    expect(slugify("Société")).toBe("societe")
  })

  test("never longer than 80 and never ends in a hyphen", () => {
    const slug = slugify(`${"word ".repeat(40)}end`)
    expect(slug.length).toBeLessThanOrEqual(80)
    expect(slug.endsWith("-")).toBe(false)
  })
})

describe("key minting", () => {
  test("matches the shared fixtures", () => {
    for (const f of fixtures.orgKey) expect(orgKey(f.name)).toBe(f.key)
    for (const f of fixtures.venueKey) expect(venueKey(f.name)).toBe(f.key)
    for (const f of fixtures.teamKey) expect(teamKey(f.orgKey, f.name)).toBe(f.key)
    for (const f of fixtures.sessionKey) {
      expect(sessionKey(f.orgKey, f.title, f.dayOfWeek, f.startTime)).toBe(f.key)
    }
    for (const f of fixtures.eventKey) expect(eventKey(f.source, f.externalId)).toBe(f.key)
    for (const f of fixtures.relationshipKey) {
      expect(relationshipKey(f.fromKey, f.type, f.toKey)).toBe(f.key)
    }
    for (const f of fixtures.sourceKey) expect(sourceKey(f.url)).toBe(f.key)
    for (const f of fixtures.personKey) expect(personKey(f.orgKey, f.name)).toBe(f.key)
  })

  test("shapes", () => {
    expect(orgKey("CU German Society")).toBe("org-cu-german-society")
    expect(orgSlugFromKey("org-cu-german-society")).toBe("cu-german-society")
    expect(() => orgSlugFromKey("evt-123")).toThrow()
    expect(teamKey("org-cuafc", "Blues")).toBe("team-cuafc--blues")
    expect(eventKey("camdram", "1")).toMatch(/^evt-[0-9a-f]{40}$/)
    expect(relationshipKey("org-a", "sponsors", "org-b")).not.toBe(
      relationshipKey("org-b", "sponsors", "org-a"),
    )
  })
})

describe("canonicalJson / claimFingerprint", () => {
  test("canonical JSON sorts keys at every level and skips undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: undefined, b: [3, { y: 1, x: 2 }] } })).toBe(
      '{"a":{"b":[3,{"x":2,"y":1}],"d":2},"b":1}',
    )
    for (const f of fixtures.canonicalJson) expect(canonicalJson(f.value)).toBe(f.json)
  })

  test("fingerprints match the shared fixtures", () => {
    for (const f of fixtures.claimFingerprint) expect(claimFingerprint(f.input)).toBe(f.fingerprint)
  })

  test("a changed value, page content or method is a different observation", () => {
    const base = {
      entityType: "organisation",
      entityKey: "org-x",
      field: "email",
      value: "a@x.org",
      status: "found",
      sourceUrl: "https://x.org",
      method: "parser",
    }
    const fp = claimFingerprint(base)
    expect(claimFingerprint({ ...base })).toBe(fp)
    expect(claimFingerprint({ ...base, value: "b@x.org" })).not.toBe(fp)
    expect(claimFingerprint({ ...base, contentSha256: "ff" })).not.toBe(fp)
    expect(claimFingerprint({ ...base, method: "llm" })).not.toBe(fp)
    // Key order inside an object value does not matter.
    expect(claimFingerprint({ ...base, field: "logo", value: { a: 1, b: 2 } })).toBe(
      claimFingerprint({ ...base, field: "logo", value: { b: 2, a: 1 } }),
    )
  })
})
