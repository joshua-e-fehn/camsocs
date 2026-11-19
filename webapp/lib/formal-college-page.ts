import { COLLEGE_INFO, type CollegeInfo, type FormalNight, type Weekday } from "./colleges"
import { listNames } from "./formal-facts"
import { formalCollegePath } from "./formal-paths"
import { frequencyLabel, isGraduateNight, WEEK, WEEKDAY_NAMES } from "./formal-week"
import { MAX_DESCRIPTION_LENGTH } from "./page-metadata"
import { MAX_TITLE_LENGTH } from "./site"

/**
 * One college's formal hall page, `/formals/<slug>` (formals SEO audit
 * 2026-11-19, content plan P1 option a): its title, description and the
 * sentences that sum up its nights, all from lib/data/colleges.json. Pure.
 */

/** The college whose page `slug` is, if any. */
export function formalCollegeBySlug(slug: string): CollegeInfo | undefined {
  return COLLEGE_INFO.find((college) => college.slug === slug)
}

/** Every college's page path, for pages.xml (with when its nights were
 * checked, an honest `lastmod`). */
export function formalCollegeSitemapEntries(): { path: string; lastModified: number }[] {
  return COLLEGE_INFO.map((college) => ({
    path: formalCollegePath(college.slug),
    lastModified: Date.parse(`${college.formal.nightsCheckedOn}T00:00:00Z`),
  }))
}

/** "King’s formal hall: nights, price, booking, dress code", shortened to
 * "… nights, price, dress code" when the long form would not fit. `fitTitle`
 * then drops the " · CAMsocs" suffix where it must. */
export function formalCollegeTitle(college: CollegeInfo): string {
  const long = `${college.shortName} formal hall: nights, price, booking, dress code`
  if (long.length <= MAX_TITLE_LENGTH) return long
  return `${college.shortName} formal hall: nights, price, dress code`
}

/** "Formal hall at King's College". */
export function formalCollegeHeading(college: CollegeInfo): string {
  return `Formal hall at ${college.name}`
}

function byWeek(a: FormalNight, b: FormalNight): number {
  return WEEK.indexOf(a.weekday) - WEEK.indexOf(b.weekday)
}

/** "Tuesday and Friday (first Friday of the month)": each day once, with how
 * often it runs when that is not every week. */
function dayList(nights: readonly FormalNight[]): string {
  const days: Weekday[] = []
  for (const night of [...nights].sort(byWeek)) {
    if (!days.includes(night.weekday)) days.push(night.weekday)
  }
  return listNames(
    days.map((day) => {
      const labels = new Set(
        nights.filter((night) => night.weekday === day).map((night) => frequencyLabel(night)),
      )
      const [often] = labels
      return labels.size === 1 && often ? `${WEEKDAY_NAMES[day]} (${often})` : WEEKDAY_NAMES[day]
    }),
  )
}

function timeList(nights: readonly FormalNight[]): string | null {
  const times = [...new Set(nights.map((night) => night.startTime).filter((t) => t !== null))]
  return times.length === 1 ? times[0] : null
}

/**
 * The nights in one sentence fragment: "Tuesday and Friday at 19:30, and a
 * graduate formal on Friday". The time is given only when every regular
 * night shares one.
 */
export function nightsSummary(college: CollegeInfo): string {
  const regular = college.formal.nights.filter((night) => !isGraduateNight(night))
  const graduate = college.formal.nights.filter(isGraduateNight)
  const parts: string[] = []
  if (regular.length > 0) {
    const time = timeList(regular)
    const allTimed = regular.every((night) => night.startTime !== null)
    parts.push(`${dayList(regular)}${time && allTimed ? ` at ${time}` : ""}`)
  }
  if (graduate.length > 0) {
    parts.push(`${parts.length > 0 ? "and a " : "A "}graduate formal on ${dayList(graduate)}`)
  }
  return parts.join(", ")
}

const POUNDS = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
})

/** " Member £12.60, guest £17.39 (2024-25)." Only for a price with a short
 * year and no qualifier ("around", "first guest"): a description has no room
 * for either, and a figure without them would mislead. "" otherwise; the
 * page itself shows every price with its year and source. */
function priceSentence(college: CollegeInfo): string {
  const price = college.formal.priceGbp
  if (!price?.asOf || price.asOf.length > 12 || price.caveat) return ""
  const parts: string[] = []
  if (price.student !== null) parts.push(`member ${POUNDS.format(price.student)}`)
  if (price.guest !== null) parts.push(`guest ${POUNDS.format(price.guest)}`)
  if (parts.length === 0) return ""
  const text = parts.join(", ")
  return ` ${text[0].toUpperCase()}${text.slice(1)} (${price.asOf}).`
}

/** The meta description, at most `MAX_DESCRIPTION_LENGTH` whole: the nights,
 * the published price, and what else the page answers, dropping the last of
 * those, then the price, where the whole would not fit (never cut mid-way). */
export function formalCollegeDescription(college: CollegeInfo): string {
  const head = `${college.shortName} formal hall: ${nightsSummary(college)}.`
  const rest = " Booking, deadline, dress code and how a visitor gets in."
  const price = priceSentence(college)
  const fits = [`${head}${price}${rest}`, `${head}${price}`, `${head}${rest}`, head].find(
    (text) => text.length <= MAX_DESCRIPTION_LENGTH,
  )
  return fits ?? head
}

/** The weekdays a college holds any formal on, Monday first. */
export function formalDays(college: CollegeInfo): Weekday[] {
  return WEEK.filter((day) => college.formal.nights.some((night) => night.weekday === day))
}

/** Every source the page cites, the college's own page first, without
 * repeats: the rules' sources, then the nights'. */
export function formalSourceUrls(college: CollegeInfo): string[] {
  const { formal } = college
  return [
    ...new Set([
      formal.primarySourceUrl,
      ...formal.sourceUrls,
      ...formal.nightsSourceUrls,
      ...(formal.priceGbp?.sourceUrl ? [formal.priceGbp.sourceUrl] : []),
    ]),
  ].filter((url) => !formal.nightsSources.some((source) => source.url === url))
}
