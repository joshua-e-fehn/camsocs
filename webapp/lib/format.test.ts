import { describe, expect, test } from "bun:test"
import { formatEventPrice, formatPence, joinNames, languageName, takesPart } from "./format"

describe("format", () => {
  test("pence", () => {
    expect(formatPence(1200)).toBe("£12")
    expect(formatPence(1250)).toBe("£12.50")
    expect(formatPence(0)).toBe("Free")
  })

  test("event prices as published", () => {
    expect(formatEventPrice(undefined)).toBeUndefined()
    expect(formatEventPrice({ free: true })).toBe("Free")
    expect(formatEventPrice({ free: false, minPence: 500, maxPence: 800 })).toBe("£5–£8")
    expect(formatEventPrice({ free: false, minPence: 500, text: "members £3" })).toBe(
      "£5 (members £3)",
    )
    expect(formatEventPrice({ free: false, text: "Donation" })).toBe("Donation")
  })

  test("who takes part in someone else's event (D6)", () => {
    expect(joinNames(["A", "B", "C"])).toBe("A, B and C")
    expect(takesPart([])).toBeUndefined()
    expect(takesPart(["Cyber Security Society"])).toBe("Cyber Security Society takes part")
    expect(takesPart(["A", "B"])).toBe("A and B take part")
  })

  test("languages", () => {
    expect(languageName("de")).toBe("German")
  })
})
