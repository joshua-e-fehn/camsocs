import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import path from "node:path"
import { collegeCards } from "./college-index"
import { COLLEGE_INFO, collegeInfo, FORMALS_CHECKED_ON } from "./colleges"
import { parseRichText } from "./rich-text"

const ISO = /^\d{4}-\d{2}-\d{2}$/

describe("the colleges' data (lib/data/colleges.json)", () => {
  test("holds all 31 colleges, once each", () => {
    expect(COLLEGE_INFO).toHaveLength(31)
    expect(new Set(COLLEGE_INFO.map((c) => c.key)).size).toBe(31)
    expect(new Set(COLLEGE_INFO.map((c) => c.slug)).size).toBe(31)
    for (const college of COLLEGE_INFO) expect(college.key).toStartWith("org-")
    expect(collegeInfo("org-trinity-hall")?.shortName).toBe("Trinity Hall")
  })

  test("every crest is a file in public/", () => {
    for (const { crest, slug } of COLLEGE_INFO) {
      expect(crest.src).toBe(`/images/colleges/${slug}.webp`)
      expect(existsSync(path.join(import.meta.dir, "..", "public", crest.src))).toBe(true)
      expect(crest.sourceImageUrl).toStartWith("https://")
    }
  })

  test("every formal entry is checked, dated and sourced", () => {
    expect(FORMALS_CHECKED_ON).toMatch(ISO)
    for (const { name, formal } of COLLEGE_INFO) {
      expect([name, formal.checkedOn]).toEqual([name, expect.stringMatching(ISO)])
      expect(formal.visitors.length).toBeGreaterThan(20)
      expect(formal.bookingSummary.length).toBeLessThanOrEqual(60)
      expect(formal.rulesSummary.length).toBeLessThanOrEqual(160)
      expect(formal.primarySourceUrl).toStartWith("https://")
      expect(formal.sourceUrls.length).toBeGreaterThan(0)
      for (const url of formal.sourceUrls) expect(url).toStartWith("https://")
      expect(formal.note).not.toMatch(/^#/)
      expect(parseRichText(formal.note).length).toBeGreaterThan(0)
    }
  })
})

describe("collegeCards", () => {
  const [first] = COLLEGE_INFO
  test("counts a college's listings and links its JCR, MCR and boat club in that order", () => {
    const cards = [
      { slug: "b", name: "Boat", orgType: "college_boat_club" as const, collegeKeys: [first.key] },
      { slug: "m", name: "MCR", orgType: "mcr" as const, collegeKeys: [first.key] },
      { slug: "j", name: "JCR", orgType: "jcr" as const, collegeKeys: [first.key] },
      { slug: "x", name: "Other", orgType: "society" as const, collegeKeys: ["org-elsewhere"] },
    ]
    const [card] = collegeCards([first], cards)
    expect(card.count).toBe(3)
    expect(card.bodies.map((b) => b.label)).toEqual(["JCR", "MCR", "Boat club"])
  })
})
