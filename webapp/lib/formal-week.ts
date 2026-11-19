import { londonIsoDate, weekdayIndex } from "@/lib/calendar"
import type {
  CollegeCrest,
  CollegeInfo,
  FormalNight,
  FormalPrice,
  VisitorRoute,
  Weekday,
} from "@/lib/colleges"

/**
 * The week of formals (/formals, ENG-272): which colleges hold formal hall on
 * which night, from the nights in lib/data/colleges.json. Pure, and free of
 * the colleges' data at runtime (types only), so the page's client organism
 * can filter without shipping the whole file: the server page builds the
 * slots with `formalSlots` and hands them over.
 */

/** Monday first, as the picker shows them; also each day section's id. */
export const WEEK: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

export const WEEKDAY_NAMES: Readonly<Record<Weekday, string>> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
}

/** The id of a day's section ("saturday"), so /formals#saturday links it. */
export function dayId(day: Weekday): string {
  return WEEKDAY_NAMES[day].toLowerCase()
}

/** The weekday whose section id is `id` ("saturday" → "sat"), if any. */
export function dayFromId(id: string): Weekday | undefined {
  const wanted = id.replace(/^#/, "").toLowerCase()
  return WEEK.find((day) => dayId(day) === wanted)
}

/** The Europe/London weekday of an instant (the UK clock rule, lib/calendar). */
export function londonWeekday(ms: number): Weekday {
  return WEEK[weekdayIndex(londonIsoDate(ms))]
}

/** One college's formal on one night: what a row on /formals shows. */
export type FormalSlot = {
  collegeKey: string
  shortName: string
  /** The college hub's formal hall section. */
  href: string
  crest: CollegeCrest
  bookingSummary: string
  visitorRoute: VisitorRoute
  /** The price for this night (`nightPrice`), or null. */
  price: FormalPrice | null
  /** True when the college publishes a price but not one for this night (a
   * graduate or other dinner), so the row can say so rather than show none. */
  priceWithheld: boolean
  night: FormalNight
}

export type FormalFilters = {
  /** Only colleges whose published route lets a visitor in (as a guest). */
  visitorsOnly: boolean
  /** Keep graduate (MCR) formals. */
  includeGraduate: boolean
}

export const DEFAULT_FILTERS: FormalFilters = { visitorsOnly: false, includeGraduate: true }

/** A night for graduates: a graduate formal, or one an MCR books. */
export function isGraduateNight(night: FormalNight): boolean {
  return night.kind === "grad_formal" || night.audience === "mcr"
}

export function matchesFilters(slot: FormalSlot, filters: FormalFilters): boolean {
  if (filters.visitorsOnly && slot.visitorRoute !== "as_guest") return false
  if (!filters.includeGraduate && isGraduateNight(slot.night)) return false
  return true
}

/**
 * The price that applies to one night: the night's own when recorded, else the
 * college's regular formal price, except on a graduate or "other" night (an
 * MCR hall or a semi-formal is priced differently, so the regular figure would
 * mislead).
 */
export function nightPrice(college: CollegeInfo, night: FormalNight): FormalPrice | null {
  if (night.price !== undefined) return night.price
  if (isGraduateNight(night) || night.kind === "other") return null
  return college.formal.priceGbp
}

/** Every night of every college, as rows. */
export function formalSlots(
  colleges: readonly CollegeInfo[],
  href: (college: CollegeInfo) => string,
): FormalSlot[] {
  return colleges.flatMap((college) =>
    college.formal.nights.map((night) => ({
      collegeKey: college.key,
      shortName: college.shortName,
      href: href(college),
      crest: college.crest,
      bookingSummary: college.formal.bookingSummary,
      visitorRoute: college.formal.visitorRoute,
      price: nightPrice(college, night),
      priceWithheld: nightPrice(college, night) === null && college.formal.priceGbp !== null,
      night,
    })),
  )
}

/** Earliest first; a night with no published time after the timed ones,
 * then by college. */
function bySlotOrder(a: FormalSlot, b: FormalSlot): number {
  const at = a.night.startTime ?? "99:99"
  const bt = b.night.startTime ?? "99:99"
  if (at !== bt) return at < bt ? -1 : 1
  return a.shortName.localeCompare(b.shortName, "en-GB")
}

/** The slots that pass `filters`, grouped by weekday (every day present,
 * Monday first), each day in start-time order. */
export function byWeekday(
  slots: readonly FormalSlot[],
  filters: FormalFilters = DEFAULT_FILTERS,
): Record<Weekday, FormalSlot[]> {
  const days = Object.fromEntries(WEEK.map((day) => [day, [] as FormalSlot[]])) as Record<
    Weekday,
    FormalSlot[]
  >
  for (const slot of slots) {
    if (matchesFilters(slot, filters)) days[slot.night.weekday].push(slot)
  }
  for (const day of WEEK) days[day].sort(bySlotOrder)
  return days
}

/** How many different colleges the slots belong to. */
export function collegeCount(slots: readonly FormalSlot[]): number {
  return new Set(slots.map((slot) => slot.collegeKey)).size
}

const POUNDS = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
})

/** "Guest £16.75 · member £15.70 (June 2026)", always with the year or date
 * the source gives ("undated" when none), or null when neither price is
 * published. */
export function priceLabel(price: FormalPrice | null): string | null {
  if (!price) return null
  const parts: string[] = []
  if (price.guest !== null) parts.push(`Guest ${POUNDS.format(price.guest)}`)
  if (price.student !== null) {
    const member = POUNDS.format(price.student)
    parts.push(parts.length > 0 ? `member ${member}` : `Member ${member}`)
  }
  return parts.length > 0 ? `${parts.join(" · ")} (${price.asOf ?? "undated"})` : null
}

/** The day to show once the page has mounted: the one the URL's hash names
 * (and whether it came from the hash, so the page scrolls to it), else today
 * in Europe/London. */
export function initialDay(hash: string, nowMs: number): { day: Weekday; fromHash: boolean } {
  const fromHash = dayFromId(hash)
  return fromHash
    ? { day: fromHash, fromHash: true }
    : { day: londonWeekday(nowMs), fromHash: false }
}

/** The colleges whose weekly nights are not published, with why: the page's
 * "Nights not published" note. */
export function unpublishedNights(
  colleges: readonly CollegeInfo[],
): { college: CollegeInfo; reason: string }[] {
  return colleges
    .filter((college) => college.formal.nightsStatus === "unknown")
    .map((college) => ({
      college,
      reason: college.formal.nightsGaps[0] ?? "No public page lists the weekdays.",
    }))
}
