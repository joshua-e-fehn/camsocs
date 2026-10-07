import { describe, expect, test } from "bun:test"
import { type CoverageRow, coverageStats } from "./coverage"
import { forceLayout } from "./force-layout"
import { complementaryMatches, type MatchOrg, MEETS } from "./matching"

describe("coverageStats", () => {
  const row = (overrides: Partial<CoverageRow>): CoverageRow => ({
    level: "university",
    status: "active",
    isCounterpart: false,
    hidden: false,
    has: { email: false, website: false, instagram: false, description: false },
    missingFields: [],
    ...overrides,
  })

  test("counts listed organisations only, by level and status, with field shares", () => {
    const stats = coverageStats([
      row({ has: { email: true, website: true, instagram: false, description: true } }),
      row({ status: "dormant", missingFields: ["website", "email"] }),
      row({ level: undefined, status: "unknown", hidden: true, missingFields: ["website"] }),
      row({
        isCounterpart: true,
        has: { email: true, website: true, instagram: true, description: true },
      }),
    ])
    expect(stats.total).toBe(3)
    expect(stats.counterparts).toBe(1)
    expect(stats.hidden).toBe(1)
    expect(stats.byLevel).toEqual({ university: 2, unknown: 1 })
    expect(stats.byLevelStatus).toEqual({
      university: { active: 1, dormant: 1 },
      unknown: { unknown: 1 },
    })
    expect(stats.share).toEqual({ email: 1 / 3, website: 1 / 3, instagram: 0, description: 1 / 3 })
    expect(stats.missingTop).toEqual([
      ["website", 2],
      ["email", 1],
    ])
  })

  test("an empty directory has zero shares, not NaN", () => {
    expect(coverageStats([]).share.email).toBe(0)
  })
})

describe("complementaryMatches", () => {
  const orgs = new Map<string, MatchOrg>(
    [
      ["org-a", "Chess", ["hobbies_games"]],
      ["org-b", "Go", ["hobbies_games"]],
      ["org-c", "Physics", ["science_tech"]],
      ["org-bank", "Bank", []],
    ].map(([key, name, categories]) => [
      key as string,
      { key: key as string, name: name as string, categories: categories as string[] },
    ]),
  )

  test("every need is met by at least one kind of offer", () => {
    for (const offers of Object.values(MEETS)) expect(offers.length).toBeGreaterThan(0)
    expect(MEETS.speakers).toContain("expertise")
  })

  test("needs meet offers; confirmed and shared categories rank higher; rejected never match", () => {
    const matches = complementaryMatches(
      [
        { orgKey: "org-a", needs: [{ item: "speakers", status: "confirmed" }], offers: [] },
        {
          orgKey: "org-b",
          needs: [{ item: "venue", status: "rejected" }],
          offers: [{ item: "expertise", status: "inferred" }],
        },
        {
          orgKey: "org-c",
          needs: [],
          offers: [
            { item: "speakers", status: "confirmed" },
            { item: "venue", status: "inferred" },
          ],
        },
      ],
      orgs,
      [],
    )
    expect(matches.map((m) => [m.needKey, m.offerKey, m.offer, m.score])).toEqual([
      ["org-a", "org-c", "speakers", 3.5],
      ["org-a", "org-b", "expertise", 2.5],
    ])
  })

  test("past sponsors of a society sharing a category; never the needer's own sponsor edge", () => {
    const matches = complementaryMatches(
      [{ orgKey: "org-b", needs: [{ item: "sponsorship", status: "inferred" }], offers: [] }],
      orgs,
      [
        { fromKey: "org-bank", toKey: "org-a" },
        { fromKey: "org-bank", toKey: "org-c" },
        { fromKey: "org-bank", toKey: "org-b" },
      ],
    )
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({
      needKey: "org-b",
      offerKey: "org-bank",
      kind: "past_sponsor",
      sponsoredKey: "org-a",
      sharedCategories: ["hobbies_games"],
    })
  })
})

describe("forceLayout", () => {
  const ids = ["a", "b", "c", "d", "e"]
  const edges = [
    { source: "a", target: "b" },
    { source: "b", target: "c" },
    { source: "d", target: "e" },
  ]
  const options = { width: 400, height: 300 }

  test("is deterministic and stays inside the canvas", () => {
    const first = forceLayout(ids, edges, options)
    const second = forceLayout(ids, edges, options)
    expect([...first.entries()]).toEqual([...second.entries()])
    for (const { x, y } of first.values()) {
      expect(x).toBeGreaterThanOrEqual(24)
      expect(x).toBeLessThanOrEqual(376)
      expect(y).toBeGreaterThanOrEqual(24)
      expect(y).toBeLessThanOrEqual(276)
    }
  })

  test("pulls linked nodes closer than unlinked ones", () => {
    const at = forceLayout(ids, edges, options)
    const dist = (p: string, q: string) => {
      const a = at.get(p)!
      const b = at.get(q)!
      return Math.hypot(a.x - b.x, a.y - b.y)
    }
    expect(dist("a", "b")).toBeLessThan(dist("a", "e"))
    expect(dist("d", "e")).toBeLessThan(dist("c", "d"))
  })

  test("handles empty and single-node graphs and ignores unknown endpoints", () => {
    expect(forceLayout([], [], options).size).toBe(0)
    expect(forceLayout(["x"], [{ source: "x", target: "nope" }], options).get("x")).toEqual({
      x: 200,
      y: 150,
    })
  })
})
