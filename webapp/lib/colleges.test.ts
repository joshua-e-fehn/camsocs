import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import path from "node:path"
import { collegeCards } from "./college-index"
import {
  COLLEGE_INFO,
  collegeInfo,
  FORMAL_NIGHTS_CHECKED_ON,
  FORMALS_CHECKED_ON,
  NIGHTS_STATUSES,
  WEEKDAYS,
} from "./colleges"
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

describe("the colleges' formal nights (ENG-272)", () => {
  const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

  test("every night has a valid weekday, kind and time, and is dated and sourced", () => {
    expect(FORMAL_NIGHTS_CHECKED_ON).toMatch(ISO)
    expect(FORMAL_NIGHTS_CHECKED_ON >= FORMALS_CHECKED_ON).toBe(true)
    for (const { name, formal } of COLLEGE_INFO) {
      expect([name, formal.nightsCheckedOn]).toEqual([name, FORMAL_NIGHTS_CHECKED_ON])
      expect(formal.nightsSourceUrls.length).toBeGreaterThan(0)
      for (const url of formal.nightsSourceUrls) expect(url).toStartWith("https://")
      expect(formal.nightsQuote.length).toBeGreaterThan(10)
      expect(formal.guestNote.length).toBeGreaterThan(10)
      for (const night of formal.nights) {
        expect(WEEKDAYS).toContain(night.weekday)
        expect(night.label.length).toBeGreaterThan(0)
        if (night.startTime !== null)
          expect([name, night.startTime]).toEqual([name, expect.stringMatching(TIME)])
      }
      const keys = formal.nights.map((n) => `${n.weekday}:${n.kind}:${n.audience}`)
      expect([name, new Set(keys).size]).toEqual([name, keys.length])
    }
  })

  test("every college has a nights status, consistent with its nights", () => {
    for (const { name, formal } of COLLEGE_INFO) {
      expect(NIGHTS_STATUSES).toContain(formal.nightsStatus)
      const found = formal.nights.filter((n) => n.confidence === "found")
      if (formal.nightsStatus === "found") expect([name, found.length > 0]).toEqual([name, true])
      if (formal.nightsStatus === "inferred") {
        // Something is deduced: a night, or the pattern the found nights rest on.
        expect([name, formal.nights.length > 0]).toEqual([name, true])
        expect([name, formal.nightsGaps.length > 0]).toEqual([name, true])
      }
      if (formal.nightsStatus === "unknown") {
        // Nothing stated night by night, and the page can say why.
        expect([name, found]).toEqual([name, []])
        expect([name, formal.nightsGaps.length > 0]).toEqual([name, true])
      }
    }
  })

  test("an inferred night always says why", () => {
    for (const { name, formal } of COLLEGE_INFO) {
      for (const night of formal.nights.filter((n) => n.confidence === "inferred")) {
        expect([name, (night.notes ?? "").length > 10]).toEqual([name, true])
      }
    }
  })

  test("a visitor route is published or marked unknown, and prices are sane", () => {
    for (const { name, formal } of COLLEGE_INFO) {
      expect(["as_guest", "unknown"]).toContain(formal.visitorRoute)
      const price = formal.priceGbp
      if (!price) continue
      expect([name, price.student !== null || price.guest !== null]).toEqual([name, true])
      for (const value of [price.student, price.guest]) {
        if (value !== null) expect(value).toBeWithin(5, 50)
      }
      if (price.sourceUrl !== null) expect(price.sourceUrl).toStartWith("https://")
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
