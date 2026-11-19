import { describe, expect, test } from "bun:test"
import data from "../../lib/data/colleges.json"
import {
  compareProfiles,
  FORMAL_COLLEGES,
  trackerCounts,
  validateCollegeKey,
  validateDisplayName,
  validateNotes,
  validateVisitedOn,
  validateVisits,
} from "./formals"

const NOW = Date.UTC(2026, 10, 18, 12)

describe("formal tracker rules", () => {
  test("the colleges are exactly lib/data/colleges.json's, with its short names", () => {
    const fromJson = Object.fromEntries(data.colleges.map((c) => [c.key, c.shortName]))
    expect(FORMAL_COLLEGES).toEqual(fromJson)
    expect(Object.keys(FORMAL_COLLEGES)).toHaveLength(31)
  })

  test("college keys", () => {
    expect(validateCollegeKey("org-trinity-college")).toBe("org-trinity-college")
    expect(() => validateCollegeKey("trinity")).toThrow("31 Cambridge colleges")
    expect(() => validateCollegeKey("toString")).toThrow()
  })

  test("dates are real, not in the future, and blank clears", () => {
    expect(validateVisitedOn("2026-11-18", NOW)).toBe("2026-11-18")
    expect(validateVisitedOn("2024-02-29", NOW)).toBe("2024-02-29")
    expect(validateVisitedOn(null, NOW)).toBeNull()
    expect(validateVisitedOn("  ", NOW)).toBeNull()
    expect(() => validateVisitedOn("2026-11-19", NOW)).toThrow("future")
    expect(() => validateVisitedOn("2025-02-29", NOW)).toThrow("real day")
    expect(() => validateVisitedOn("18/11/2026", NOW)).toThrow("real day")
    expect(() => validateVisitedOn("1900-01-01", NOW)).toThrow("real day")
  })

  test("visits are whole numbers from 0 to 200", () => {
    expect(validateVisits(0)).toBe(0)
    expect(validateVisits(200)).toBe(200)
    expect(() => validateVisits(201)).toThrow()
    expect(() => validateVisits(-1)).toThrow()
    expect(() => validateVisits(1.5)).toThrow()
  })

  test("notes are trimmed and at most 2,000 characters", () => {
    expect(validateNotes("  lovely  ")).toBe("lovely")
    expect(validateNotes("x".repeat(2000))).toHaveLength(2000)
    expect(() => validateNotes("x".repeat(2001))).toThrow("2,000")
  })

  test("display names", () => {
    expect(validateDisplayName("  Formal   Fiend ")).toBe("Formal Fiend")
    expect(validateDisplayName("O’Brien-Smith")).toBe("O’Brien-Smith")
    expect(validateDisplayName("Zoë_K.")).toBe("Zoë_K.")
    expect(validateDisplayName("")).toBeNull()
    expect(validateDisplayName(null)).toBeNull()
    expect(() => validateDisplayName("A")).toThrow("2–24")
    expect(() => validateDisplayName("x".repeat(25))).toThrow("2–24")
    expect(() => validateDisplayName("me@cam.ac.uk")).toThrow("email")
    expect(() => validateDisplayName("camsocs.uk")).toThrow("web address")
    expect(() => validateDisplayName("www.example")).toThrow("web address")
    expect(() => validateDisplayName("http://x")).toThrow("letters")
    expect(() => validateDisplayName("jef76")).toThrow("CRSid")
    expect(() => validateDisplayName("Rower ABC123")).toThrow("CRSid")
    expect(() => validateDisplayName("<b>hi</b>")).toThrow("letters")
  })

  test("a CRSid joined to other characters is still caught", () => {
    expect(() => validateDisplayName("jef76_")).toThrow("CRSid")
    expect(() => validateDisplayName("_jef76")).toThrow("CRSid")
    expect(() => validateDisplayName("jef76-x")).toThrow("CRSid")
    expect(() => validateDisplayName("jef76's")).toThrow("CRSid")
    expect(() => validateDisplayName("jef76’")).toThrow("CRSid")
    expect(() => validateDisplayName("jef76.x")).toThrow("CRSid")
    expect(() => validateDisplayName("Rower-ABC123")).toThrow("CRSid")
    // Words with digits that are not CRSid-shaped stay allowed.
    expect(validateDisplayName("Rower_2026")).toBe("Rower_2026")
    expect(validateDisplayName("Gown-Borrower 7")).toBe("Gown-Borrower 7")
  })

  test("a spaced-out web address is still a web address", () => {
    expect(() => validateDisplayName("bit .ly")).toThrow("web address")
    expect(() => validateDisplayName("evil . com")).toThrow("web address")
    expect(() => validateDisplayName("evil. com")).toThrow("web address")
    expect(validateDisplayName("Zoë K.")).toBe("Zoë K.")
    expect(validateDisplayName("A. B")).toBe("A. B")
  })

  test("counts and leaderboard order", () => {
    expect(
      trackerCounts([
        { attended: true, visits: 3 },
        { attended: true, visits: 0 },
        { attended: false, visits: 5 },
      ]),
    ).toEqual({ colleges: 2, visits: 4 })
    const rows = [
      { id: "late", colleges: 5, visits: 9, reachedAt: 20 },
      { id: "early", colleges: 5, visits: 9, reachedAt: 10 },
      { id: "more", colleges: 5, visits: 12, reachedAt: 30 },
      { id: "top", colleges: 6, visits: 6, reachedAt: 40 },
    ]
    expect(rows.sort(compareProfiles).map((r) => r.id)).toEqual(["top", "more", "early", "late"])
  })
})
