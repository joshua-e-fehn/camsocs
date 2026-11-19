import { londonIsoDate, weekdayIndex } from "@/lib/calendar"
import type {
  CollegeCrest,
  CollegeInfo,
  FormalNight,
  FormalPrice,
  NightFrequency,
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
  /** The college's formal hall page (`formalCollegePath`). */
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

const FREQUENCY: Readonly<Record<NightFrequency, string | null>> = {
  weekly: null,
  fortnightly: "every other week",
  first_of_month: "first {day} of the month",
  some_weeks: "some weeks",
}

/** How often a night runs, in plain words ("every other week", "first Friday
 * of the month"), or null for a weekly one, which needs no words. */
export function frequencyLabel(night: Pick<FormalNight, "frequency" | "weekday">): string | null {
  return FREQUENCY[night.frequency]?.replace("{day}", WEEKDAY_NAMES[night.weekday]) ?? null
}

/** The view the page opens on once mounted: the day the URL's hash names
 * (`#saturday`), else the whole week, as the server drew it, so nothing
 * moves when the page hydrates (formals SEO audit 2026-11-19: CLS). */
export function initialSelection(hash: string): Weekday | "all" {
  return dayFromId(hash) ?? "all"
}
