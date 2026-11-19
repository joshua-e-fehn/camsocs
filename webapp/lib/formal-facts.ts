import type { CollegeInfo, FormalPrice, Weekday } from "./colleges"
import { byWeekday, collegeCount, formalSlots, isGraduateNight, WEEK } from "./formal-week"

/**
 * The facts the formals pages state in their prose (formals SEO audit
 * 2026-11-19): counts per night, the weekend's colleges, the published
 * prices in order, the dress codes and the colleges with fewest nights. Every
 * number and name comes from lib/data/colleges.json through here, so the
 * copy cannot drift from the week below it. Pure.
 */

/** How many colleges hold any formal (graduate ones included) on each night,
 * as the week's day picker counts them. */
export function nightCounts(colleges: readonly CollegeInfo[]): Record<Weekday, number> {
  const days = byWeekday(formalSlots(colleges, () => ""))
  return Object.fromEntries(WEEK.map((day) => [day, collegeCount(days[day])])) as Record<
    Weekday,
    number
  >
}

/**
 * Per night: colleges with a formal there every week, and colleges whose
 * formal that night runs only some weeks (fortnightly, first of the month,
 * some weeks), so "tonight" never counts an occasional dinner as a sure one
 * (PR #83 review).
 */
export function tonightCounts(
  colleges: readonly CollegeInfo[],
): Record<Weekday, { weekly: number; occasional: number }> {
  return Object.fromEntries(
    WEEK.map((day) => {
      let weekly = 0
      let occasional = 0
      for (const college of colleges) {
        const nights = college.formal.nights.filter((night) => night.weekday === day)
        if (nights.length === 0) continue
        if (nights.some((night) => night.frequency === "weekly")) weekly++
        else occasional++
      }
      return [day, { weekly, occasional }]
    }),
  ) as Record<Weekday, { weekly: number; occasional: number }>
}

/** The colleges that hold a formal on `day`, by short name (A to Z). */
export function collegesOn(colleges: readonly CollegeInfo[], day: Weekday): CollegeInfo[] {
  return colleges
    .filter((college) => college.formal.nights.some((night) => night.weekday === day))
    .sort((a, b) => a.shortName.localeCompare(b.shortName, "en-GB"))
}

/** The busiest and quietest nights (first in week order on a tie). */
export function busiestAndQuietest(counts: Record<Weekday, number>): {
  busiest: Weekday
  quietest: Weekday
} {
  let busiest: Weekday = WEEK[0]
  let quietest: Weekday = WEEK[0]
  for (const day of WEEK) {
    if (counts[day] > counts[busiest]) busiest = day
    if (counts[day] < counts[quietest]) quietest = day
  }
  return { busiest, quietest }
}

/** One row of the price table: a college's regular formal as it publishes it. */
export type PriceRow = {
  college: CollegeInfo
  price: FormalPrice
  /** What the row sorts on: the guest price, else the member's. */
  sortPrice: number
  /** True when the college publishes no guest price, only a member's. */
  memberOnly: boolean
}

/** The colleges that publish a price, cheapest first by guest price (the
 * member's price where no guest price is published), then by name. */
export function priceRows(colleges: readonly CollegeInfo[]): PriceRow[] {
  const rows: PriceRow[] = []
  for (const college of colleges) {
    const price = college.formal.priceGbp
    if (!price) continue
    const sortPrice = price.guest ?? price.student
    if (sortPrice === null) continue
    rows.push({ college, price, sortPrice, memberOnly: price.guest === null })
  }
  return rows.sort(
    (a, b) =>
      a.sortPrice - b.sortPrice || a.college.shortName.localeCompare(b.college.shortName, "en-GB"),
  )
}

/** The lowest and highest published figure of one kind, or null if none. */
export function priceRange(
  rows: readonly PriceRow[],
  kind: "guest" | "student",
): { min: number; max: number } | null {
  const values = rows.map((row) => row.price[kind]).filter((value) => value !== null)
  if (values.length === 0) return null
  return { min: Math.min(...values), max: Math.max(...values) }
}

/** The colleges whose published dress code mentions `pattern`. */
export function dressMentions(colleges: readonly CollegeInfo[], pattern: RegExp): CollegeInfo[] {
  return colleges.filter((college) => pattern.test(college.formal.dress ?? ""))
}

/** How many regular (not graduate-only) formals a college holds in a usual
 * week of term: a weekly night counts 1, an every-other-week or some-weeks
 * night ½, a first-of-the-month night ¼. */
export function regularNightsPerWeek(college: CollegeInfo): number {
  const weight = { weekly: 1, fortnightly: 0.5, some_weeks: 0.5, first_of_month: 0.25 } as const
  return college.formal.nights
    .filter((night) => !isGraduateNight(night))
    .reduce((sum, night) => sum + weight[night.frequency], 0)
}

/** The colleges hardest to tick off: at most one regular formal a week, or no
 * published route in for a visitor. Fewest nights first, then by name. */
export function hardestToTickOff(colleges: readonly CollegeInfo[]): CollegeInfo[] {
  return colleges
    .filter(
      (college) => regularNightsPerWeek(college) <= 1 || college.formal.visitorRoute !== "as_guest",
    )
    .sort(
      (a, b) =>
        regularNightsPerWeek(a) - regularNightsPerWeek(b) ||
        a.shortName.localeCompare(b.shortName, "en-GB"),
    )
}

/** "Emmanuel, Peterhouse and Trinity". */
export function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("")
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
}
