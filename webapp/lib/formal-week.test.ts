import { describe, expect, test } from "bun:test"
import { COLLEGE_INFO, type FormalNight } from "./colleges"
import {
  byWeekday,
  collegeCount,
  dayFromId,
  dayId,
  type FormalSlot,
  formalSlots,
  frequencyLabel,
  initialSelection,
  isGraduateNight,
  londonWeekday,
  matchesFilters,
  nightPrice,
  priceLabel,
  WEEK,
} from "./formal-week"

const crest = { src: "/x.webp", alt: "", sourceImageUrl: "https://x", sourcePageUrl: "https://x" }

function slot(
  shortName: string,
  night: Partial<FormalNight>,
  extra: Partial<FormalSlot> = {},
): FormalSlot {
  return {
    collegeKey: `org-${shortName.toLowerCase()}`,
    shortName,
    href: `/colleges/${shortName.toLowerCase()}#formal-hall`,
    crest,
    bookingSummary: "Member books you as a guest",
    visitorRoute: "as_guest",
    price: null,
    priceWithheld: false,
    night: {
      weekday: "mon",
      kind: "formal",
      label: "Formal Hall",
      startTime: "19:30",
      termOnly: true,
      audience: "all_members",
      frequency: "weekly",
      confidence: "found",
      notes: null,
      ...night,
    },
    ...extra,
  }
}

describe("londonWeekday", () => {
  test("reads the weekday on London's clock, not UTC's", () => {
    // Tue 17 Nov 2026, 23:30 GMT: London and UTC agree.
    expect(londonWeekday(Date.UTC(2026, 10, 17, 23, 30))).toBe("tue")
    // Sat 24 Oct 2026, 23:30 UTC is Sunday 00:30 in London (BST).
    expect(londonWeekday(Date.UTC(2026, 9, 24, 23, 30))).toBe("sun")
    // Sat 28 Mar 2026, 23:30 UTC: still GMT, so still Saturday in London.
    expect(londonWeekday(Date.UTC(2026, 2, 28, 23, 30))).toBe("sat")
    // Sun 29 Mar 2026, 23:30 UTC: BST began at 01:00 UTC, so Monday in London.
    expect(londonWeekday(Date.UTC(2026, 2, 29, 23, 30))).toBe("mon")
    // Sun 25 Oct 2026, 00:30 UTC (01:30 BST) and 01:30 UTC (01:30 GMT): Sunday.
    expect(londonWeekday(Date.UTC(2026, 9, 25, 0, 30))).toBe("sun")
    expect(londonWeekday(Date.UTC(2026, 9, 25, 1, 30))).toBe("sun")
  })
})

describe("day ids", () => {
  test("every day has a lower-case id that maps back", () => {
    expect(WEEK.map(dayId)).toEqual([
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
      "sunday",
    ])
    for (const day of WEEK) expect(dayFromId(`#${dayId(day)}`)).toBe(day)
    expect(dayFromId("#Saturday")).toBe("sat")
    expect(dayFromId("formal-hall")).toBeUndefined()
  })
})

describe("filters", () => {
  const grad = slot("Clare", { kind: "grad_formal", audience: "mcr" })
  const mcrOnly = slot("Newnham", { audience: "mcr" })
  const closed = slot("King's", {}, { visitorRoute: "unknown" })
  const open = slot("Churchill", {})

  test("a graduate night is a grad formal or an MCR's", () => {
    expect(isGraduateNight(grad.night)).toBe(true)
    expect(isGraduateNight(mcrOnly.night)).toBe(true)
    expect(isGraduateNight(open.night)).toBe(false)
  })

  test("'Visitors can go' keeps only a published guest route", () => {
    const filters = { visitorsOnly: true, includeGraduate: true }
    expect(matchesFilters(open, filters)).toBe(true)
    expect(matchesFilters(closed, filters)).toBe(false)
  })

  test("graduate formals can be left out", () => {
    const filters = { visitorsOnly: false, includeGraduate: false }
    expect(matchesFilters(grad, filters)).toBe(false)
    expect(matchesFilters(mcrOnly, filters)).toBe(false)
    expect(matchesFilters(open, filters)).toBe(true)
  })
})

describe("byWeekday", () => {
  test("groups by night, every day present, earliest first and untimed last", () => {
    const days = byWeekday([
      slot("Trinity", { weekday: "thu", startTime: "20:00" }),
      slot("Girton", { weekday: "thu", startTime: "19:15" }),
      slot("Trinity Hall", { weekday: "thu", startTime: null }),
      slot("Churchill", { weekday: "thu", startTime: "19:30" }),
      slot("Queens'", { weekday: "sun" }),
    ])
    expect(Object.keys(days)).toEqual([...WEEK])
    expect(days.thu.map((s) => s.shortName)).toEqual([
      "Girton",
      "Churchill",
      "Trinity",
      "Trinity Hall",
    ])
    expect(days.sun).toHaveLength(1)
    expect(days.mon).toEqual([])
  })

  test("applies the filters", () => {
    const days = byWeekday(
      [
        slot("Clare", { weekday: "fri", kind: "grad_formal" }),
        slot("Robinson", { weekday: "fri" }),
      ],
      { visitorsOnly: false, includeGraduate: false },
    )
    expect(days.fri.map((s) => s.shortName)).toEqual(["Robinson"])
  })

  test("over the real data: Saturday is Emmanuel, Peterhouse and Trinity only", () => {
    const days = byWeekday(formalSlots(COLLEGE_INFO, (c) => `/colleges/${c.slug}`))
    expect(days.sat.map((s) => s.shortName).sort()).toEqual(["Emmanuel", "Peterhouse", "Trinity"])
    for (const day of WEEK) expect(collegeCount(days[day])).toBeGreaterThan(0)
  })
})

describe("priceLabel", () => {
  const base = { asOf: null, sourceUrl: null, note: null }
  test("guest price first, then the member's, always dated", () => {
    expect(priceLabel({ ...base, student: 15.7, guest: 16.75, asOf: "June 2026" })).toBe(
      "Guest £16.75 · member £15.70 (June 2026)",
    )
    expect(priceLabel({ ...base, student: 11.5, guest: null })).toBe("Member £11.50 (undated)")
    expect(priceLabel({ ...base, student: null, guest: null })).toBeNull()
    expect(priceLabel(null)).toBeNull()
  })
})

describe("nightPrice", () => {
  const college = (slug: string) => {
    const found = COLLEGE_INFO.find((c) => c.slug === slug)
    if (!found) throw new Error(slug)
    return found
  }
  const night = (slug: string, label: string) => {
    const found = college(slug).formal.nights.find((n) => n.label === label)
    if (!found) throw new Error(`${slug}: ${label}`)
    return found
  }

  test("a regular formal carries the college's price", () => {
    const wolfson = college("wolfson-college")
    expect(nightPrice(wolfson, night("wolfson-college", "Formal Hall"))).toBe(
      wolfson.formal.priceGbp,
    )
  })

  test("a graduate or other night never borrows the regular price", () => {
    expect(
      nightPrice(college("newnham-college"), night("newnham-college", "Graduate Formal")),
    ).toBe(null)
    expect(nightPrice(college("homerton-college"), night("homerton-college", "Semi-formal"))).toBe(
      null,
    )
    expect(nightPrice(college("pembroke-college"), night("pembroke-college", "BA Dinner"))).toBe(
      null,
    )
  })

  test("a night's own recorded price wins", () => {
    const grad = nightPrice(college("christs-college"), night("christs-college", "MCR Grad Hall"))
    expect(grad?.student).toBe(8)
  })

  test("the row knows when a college price exists but not for that night", () => {
    const slots = formalSlots(COLLEGE_INFO, (c) => `/colleges/${c.slug}`)
    const newnham = slots.filter((s) => s.collegeKey === college("newnham-college").key)
    expect(newnham.find((s) => s.night.kind === "grad_formal")?.priceWithheld).toBe(true)
    expect(newnham.find((s) => s.night.kind === "formal")?.priceWithheld).toBe(false)
    const darwin = slots.find((s) => s.collegeKey === college("darwin-college").key)
    expect(darwin?.priceWithheld).toBe(false)
  })
})

describe("initialSelection", () => {
  test("the hash's day wins", () => {
    expect(initialSelection("#saturday")).toBe("sat")
  })
  test("otherwise the whole week, as the server drew it", () => {
    expect(initialSelection("")).toBe("all")
    expect(initialSelection("#formal-hall")).toBe("all")
  })
})

describe("frequencyLabel", () => {
  test("a weekly night needs no words; the others say how often, in plain words", () => {
    expect(frequencyLabel({ weekday: "wed", frequency: "weekly" })).toBeNull()
    expect(frequencyLabel({ weekday: "tue", frequency: "fortnightly" })).toBe("every other week")
    expect(frequencyLabel({ weekday: "fri", frequency: "first_of_month" })).toBe(
      "first Friday of the month",
    )
    expect(frequencyLabel({ weekday: "fri", frequency: "some_weeks" })).toBe("some weeks")
  })
})
