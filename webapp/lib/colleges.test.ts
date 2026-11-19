import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import path from "node:path"
import { collegeCards } from "./college-index"
import {
  COLLEGE_INFO,
  collegeInfo,
  FORMAL_NIGHTS_CHECKED_ON,
  FORMALS_CHECKED_ON,
  NIGHT_FREQUENCIES,
  NIGHT_SOURCE_KINDS,
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

  test("every college's nights are found, and every night says how often it runs", () => {
    for (const { name, formal } of COLLEGE_INFO) {
      expect([name, formal.nightsStatus]).toEqual([name, "found"])
      expect([name, formal.nights.length > 0]).toEqual([name, true])
      for (const night of formal.nights) {
        expect([name, night.confidence]).toEqual([name, "found"])
        expect([name, NIGHT_FREQUENCIES.includes(night.frequency)]).toEqual([name, true])
      }
    }
  })

  test("the nights' frequencies follow the research (19 Nov 2026)", () => {
    const frequency = (slug: string, weekday: string, kind = "formal") =>
      COLLEGE_INFO.find((c) => c.slug === slug)?.formal.nights.find(
        (n) => n.weekday === weekday && n.kind === kind,
      )?.frequency
    expect(frequency("peterhouse", "fri")).toBe("some_weeks")
    expect(frequency("peterhouse", "mon")).toBe("weekly")
    expect(frequency("murray-edwards-college", "fri")).toBe("first_of_month")
    expect(frequency("newnham-college", "tue", "grad_formal")).toBe("fortnightly")
    expect(frequency("fitzwilliam-college", "fri")).toBe("weekly")
    expect(frequency("kings-college", "wed")).toBe("weekly")
  })

  test("the six researched colleges hold their researched nights (19 Nov 2026)", () => {
    const nights = (slug: string) =>
      COLLEGE_INFO.find((c) => c.slug === slug)
        ?.formal.nights.map((n) => `${n.weekday}:${n.kind}`)
        .sort()
    expect(nights("christs-college")).toEqual(
      [
        "sun:formal",
        "mon:formal",
        "tue:formal",
        "tue:grad_formal",
        "wed:formal",
        "thu:formal",
        "fri:formal",
      ].sort(),
    )
    expect(nights("fitzwilliam-college")).toEqual(["fri:formal", "wed:formal"])
    expect(nights("kings-college")).toEqual(["wed:formal"])
    expect(nights("murray-edwards-college")).toEqual(["fri:formal", "tue:formal"])
    expect(nights("newnham-college")).toEqual(["tue:grad_formal", "wed:formal"])
    expect(nights("peterhouse")).toEqual(
      ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => `${d}:formal`).sort(),
    )
  })

  test("secondary sources are dated, attributed and https", () => {
    for (const { name, formal } of COLLEGE_INFO) {
      for (const source of formal.nightsSources) {
        expect([name, source.url]).toEqual([name, expect.stringMatching(/^https:\/\//)])
        expect([name, source.publisher.length > 0]).toEqual([name, true])
        expect([name, source.date.length > 0]).toEqual([name, true])
        expect(NIGHT_SOURCE_KINDS).toContain(source.kind)
      }
    }
    for (const slug of ["kings-college", "newnham-college", "peterhouse"]) {
      const college = COLLEGE_INFO.find((c) => c.slug === slug)
      expect([slug, (college?.formal.nightsSources.length ?? 0) > 0]).toEqual([slug, true])
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
