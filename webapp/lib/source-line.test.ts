import { describe, expect, test } from "bun:test"
import { displayHost, formatReading, hasValue, sourceLine } from "./source-line"

const RETRIEVED = Date.UTC(2026, 9, 7, 12)

describe("sourceLine", () => {
  test("a found value names its host, date, confidence and agreeing sources", () => {
    expect(
      sourceLine({
        status: "found",
        evidence: "primary",
        confidence: 0.951,
        sourceUrl: "https://www.cuchess.org/about",
        sourceType: "society_website",
        retrievedAt: RETRIEVED,
        method: "parser",
        claimCount: 2,
      }),
    ).toEqual({
      kind: "known",
      status: "found",
      label: "Found",
      description: "Read from a published source.",
      tone: "positive",
      source: { kind: "link", url: "https://www.cuchess.org/about", host: "cuchess.org" },
      retrievedOn: "7 Oct 2026",
      confidence: 95,
      agreeing: 2,
      method: "parser",
      conflicts: [],
    })
  })

  test("each value status gets its own chip", () => {
    const label = (status: "found" | "inferred" | "owner_confirmed" | "manual" | "conflicting") => {
      const model = sourceLine({ status })
      return model.kind === "known" ? [model.label, model.tone] : null
    }
    expect(label("inferred")).toEqual(["Inferred", "caution"])
    expect(label("owner_confirmed")).toEqual(["Owner-confirmed", "positive"])
    expect(label("manual")).toEqual(["Edited", "neutral"])
    expect(label("conflicting")).toEqual(["Conflicting", "caution"])
  })

  test("a withheld source URL reads as a private source, never a broken link", () => {
    const model = sourceLine({ status: "found", sourceType: "mailing_list_email" })
    expect(model.kind === "known" && model.source).toEqual({ kind: "private" })
    const odd = sourceLine({ status: "found", sourceUrl: "javascript:alert(1)" })
    expect(odd.kind === "known" && odd.source).toEqual({ kind: "private" })
  })

  test("a conflict lists every other reading with its own source", () => {
    const model = sourceLine({
      status: "conflicting",
      sourceUrl: "https://cuchess.org/",
      conflicts: [
        {
          value: "https://old-chess.example/",
          sourceUrl: "https://www.cambridgesu.co.uk/organisation/chess/",
          sourceType: "su_profile",
          retrievedAt: RETRIEVED,
          method: "parser",
        },
        {
          value: "info@chess.example",
          sourceType: "manual",
          retrievedAt: RETRIEVED,
          method: "manual",
        },
      ],
    })
    expect(model.kind === "known" && model.conflicts).toEqual([
      {
        value: "https://old-chess.example/",
        source: {
          kind: "link",
          url: "https://www.cambridgesu.co.uk/organisation/chess/",
          host: "cambridgesu.co.uk",
        },
        retrievedOn: "7 Oct 2026",
      },
      { value: "info@chess.example", source: { kind: "private" }, retrievedOn: "7 Oct 2026" },
    ])
  })

  test("missing values say why, honestly", () => {
    expect(sourceLine({ status: "missing", missingReason: "not_published" })).toMatchObject({
      kind: "missing",
      label: "Not published yet",
    })
    expect(sourceLine({ status: "missing", missingReason: "not_found" })).toMatchObject({
      label: "Not published yet",
    })
    expect(sourceLine({ status: "missing", missingReason: "not_attempted" })).toMatchObject({
      label: "Not checked yet",
    })
    expect(sourceLine({ status: "missing", missingReason: "access_restricted" })).toMatchObject({
      label: "Not public",
    })
    expect(sourceLine({ status: "missing" })).toMatchObject({ label: "Not published yet" })
    expect(sourceLine(undefined)).toMatchObject({ kind: "missing", label: "Not checked yet" })
  })

  test("not-applicable fields render nothing", () => {
    expect(sourceLine({ status: "not_applicable" })).toEqual({ kind: "hidden" })
    expect(hasValue({ status: "not_applicable" })).toBe(false)
    expect(hasValue({ status: "missing" })).toBe(false)
    expect(hasValue({ status: "inferred" })).toBe(true)
  })
})

describe("helpers", () => {
  test("displayHost", () => {
    expect(displayHost("https://WWW.Example.org/a?b")).toBe("example.org")
    expect(displayHost("inbound:<m@lists>")).toBeNull()
    expect(displayHost("not a url")).toBeNull()
  })

  test("formatReading", () => {
    expect(formatReading(true)).toBe("Yes")
    expect(formatReading(["a", "b"])).toBe("a, b")
    expect(formatReading({ platform: "instagram", url: "https://instagram.com/x" })).toBe(
      "https://instagram.com/x",
    )
    expect(formatReading({ registered: true })).toBe('{"registered":true}')
  })
})
