import { describe, expect, test } from "bun:test"
import { COLLEGE_INFO } from "@/lib/colleges"
import {
  badgeProgress,
  FORMAL_BADGES,
  FORMAL_RANKS,
  nextRank,
  OLD_MONEY_COLLEGE_KEYS,
  percentDone,
  rankFor,
  TOTAL_COLLEGES,
} from "@/lib/formal-ranks"

describe("formal ranks", () => {
  test("thresholds rise from 0 to every college", () => {
    expect(FORMAL_RANKS.map((r) => r.min)).toEqual([0, 1, 3, 6, 10, 16, 24, 31])
    expect(TOTAL_COLLEGES).toBe(COLLEGE_INFO.length)
  })

  test("rank and next rank", () => {
    expect(rankFor(0).title).toBe("Hall-curious")
    expect(rankFor(2).title).toBe("First sitting")
    expect(rankFor(10).title).toBe("Formal fiend")
    expect(rankFor(31).title).toBe("Full house")
    expect(nextRank(0)).toEqual({ rank: FORMAL_RANKS[1], needed: 1 })
    expect(nextRank(7)).toEqual({ rank: FORMAL_RANKS[4], needed: 3 })
    expect(nextRank(31)).toBeNull()
  })

  test("percent", () => {
    expect(percentDone(0)).toBe(0)
    expect(percentDone(1)).toBe(3)
    expect(percentDone(31)).toBe(100)
  })
})

describe("formal badges", () => {
  const keys = new Set(COLLEGE_INFO.map((c) => c.key))

  test("every badge names real colleges, once each", () => {
    for (const badge of FORMAL_BADGES) {
      expect(badge.collegeKeys.length).toBeGreaterThan(0)
      expect(new Set(badge.collegeKeys).size).toBe(badge.collegeKeys.length)
      for (const key of badge.collegeKeys) expect(keys.has(key)).toBe(true)
    }
    expect(OLD_MONEY_COLLEGE_KEYS).toHaveLength(5)
  })

  test("progress counts ticked colleges", () => {
    const progress = badgeProgress(new Set(["org-girton-college", "org-darwin-college"]))
    const byId = Object.fromEntries(progress.map((p) => [p.badge.id, p]))
    expect(byId["girton-trek"]).toMatchObject({ have: 1, total: 1, earned: true })
    expect(byId["grad-colleges"]).toMatchObject({ have: 1, total: 3, earned: false })
    expect(byId["the-backs"]).toMatchObject({ have: 0, total: 7, earned: false })
  })
})
