import { describe, expect, test } from "bun:test"
import { isBrokerEmail, normalizeEmail, parseBrokerEmails } from "./broker-access"

describe("parseBrokerEmails", () => {
  test("splits, trims, lowercases and drops empty entries", () => {
    expect([...parseBrokerEmails(" A@x.com, b@Y.org ,,")].sort()).toEqual(["a@x.com", "b@y.org"])
  })

  test("unset, empty and separator-only values are an empty list", () => {
    for (const raw of [undefined, "", " ", ",", " , ,"]) {
      expect(parseBrokerEmails(raw).size).toBe(0)
    }
  })
})

describe("isBrokerEmail", () => {
  const LIST = "joshua@example.com, colleague@example.org"

  test("matches case- and whitespace-insensitively", () => {
    expect(isBrokerEmail("  Joshua@Example.COM ", LIST)).toBe(true)
  })

  test("denies everyone when the list is unset or empty", () => {
    expect(isBrokerEmail("joshua@example.com", undefined)).toBe(false)
    expect(isBrokerEmail("joshua@example.com", "")).toBe(false)
  })

  test("compares whole addresses only", () => {
    expect(isBrokerEmail("joshua@example.com.attacker.test", LIST)).toBe(false)
    expect(isBrokerEmail("example.com", LIST)).toBe(false)
    // No provider-specific folding: a +tag is a different string.
    expect(isBrokerEmail("joshua+x@example.com", LIST)).toBe(false)
  })

  test("never matches an empty or non-string address, even against a sloppy list", () => {
    expect(isBrokerEmail("", " , ")).toBe(false)
    expect(isBrokerEmail(null, LIST)).toBe(false)
    expect(isBrokerEmail(42, LIST)).toBe(false)
    expect(normalizeEmail(undefined)).toBe("")
  })
})
