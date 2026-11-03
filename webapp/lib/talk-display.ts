import { addDays, londonIsoDate, londonMidnight, londonTime, weekdayShort } from "./calendar"
import type { TalkListItem } from "./public-api"
import { TALK_SCHOOLS, type TalkSchool } from "./vocab"

/**
 * How a talk shows up outside /talks, as pure functions (tested in
 * lib/talk-display.test.ts): its link, the home page's agenda line, rows and
 * "Talks by department" columns, and its line in the ⌘K palette.
 *
 * Outside /talks a talk's words are only ever rendered in the browser after
 * hydration (owner decision G1, lib/talks-boundary.ts): the home page's
 * server render carries the talk counts, never a title or a speaker.
 */

/** Where a talk opens: its detail sheet on /talks. */
export function talkHref(key: string): string {
  return `/talks?talk=${encodeURIComponent(key)}`
}

/** "Prof. Ada Lovelace (Analytical Engines Ltd)", "A and B", "A, B and 2 more". */
export function speakerLine(speakers: TalkListItem["speakers"]): string | undefined {
  const [first, second, ...rest] = speakers
  if (!first) return undefined
  const one = (s: { name: string; affiliation?: string }) =>
    s.affiliation ? `${s.name} (${s.affiliation})` : s.name
  if (!second) return one(first)
  if (rest.length === 0) return `${first.name} and ${second.name}`
  return `${first.name}, ${second.name} and ${rest.length} more`
}

/** A talk's time column: "16:00", "All day", or "On" for one that began on
 * an earlier day and is still running. */
export function talkTime(talk: Pick<TalkListItem, "startsAt" | "allDay">, today: string): string {
  if (londonIsoDate(talk.startsAt) < today) return "On"
  return talk.allDay ? "All day" : londonTime(talk.startsAt)
}

/** "Department · Speaker (Affiliation)", with the series when no department
 * claims the talk. The department leads: on a phone the line truncates, and
 * an affiliation is the part to lose. */
export function talkMeta(talk: TalkListItem): string | undefined {
  const where = talk.departments[0]?.shortName ?? talk.series ?? undefined
  return [where, speakerLine(talk.speakers)].filter(Boolean).join(" · ") || undefined
}

/** The palette's second line: "16:00 · Computer Science" (else the series). */
export function talkPaletteLine(talk: TalkListItem): string {
  const when = talk.allDay ? "All day" : londonTime(talk.startsAt)
  const whose = talk.departments[0]?.shortName ?? talk.series
  return [when, whose].filter(Boolean).join(" · ")
}

/** What the columns read of a `talks.departments` row. */
export type DepartmentCount = {
  key: string
  slug: string
  shortName: string
  school: TalkSchool
  upcomingCount: number
  /** The "Other series" bucket, not a registry department. */
  virtual: boolean
}

export type SchoolColumn<T extends DepartmentCount = DepartmentCount> = {
  school: TalkSchool
  /** Upcoming talks across the School's departments (next 28 days). */
  total: number
  /** Departments with an upcoming talk. */
  active: number
  /** The busiest few, most talks first, then by short name. */
  top: T[]
}

/** The departments with talks coming up, School by School in the fixed
 * School order, the `perSchool` busiest of each first. A School without an
 * upcoming talk keeps its column (with nothing in it), so the grid's shape
 * does not change week to week. */
export function schoolColumns<T extends DepartmentCount>(
  departments: readonly T[],
  perSchool: number,
): SchoolColumn<T>[] {
  return TALK_SCHOOLS.map((school) => {
    const busy = departments
      .filter((department) => department.school === school && department.upcomingCount > 0)
      .sort(
        (a, b) =>
          b.upcomingCount - a.upcomingCount ||
          Number(a.virtual) - Number(b.virtual) ||
          a.shortName.localeCompare(b.shortName, "en-GB"),
      )
    return {
      school,
      total: busy.reduce((sum, department) => sum + department.upcomingCount, 0),
      active: busy.length,
      top: busy.slice(0, perSchool),
    }
  })
}

// --- the home page's Talks column (read in the browser, G1) -----------------------------------

/** Rows per column on the home page; the rest is one "N more" link. */
export const HOME_ROWS = 5
/** A talk with no end time still counts as on for this long. */
const DEFAULT_LENGTH_MS = 2 * 60 * 60 * 1000
/** Talks read for one day: the rows shown plus room for cancelled ones. */
const DAY_TALKS = HOME_ROWS + 5
/** Talks read for "This week", from a few hours ago so the next ones are in
 * the page however busy today was. */
const WEEK_TALKS = 30
const WEEK_LOOKBACK_MS = 6 * 60 * 60 * 1000

/** One row of the column, the shape the home page's overview draws. */
export type HomeTalkRow = {
  key: string
  href: string
  time: string
  weekday?: string
  isToday: boolean
  title: string
  meta?: string
}

/** The `talks.list` arguments for one day's column, or the week's (`day`
 * undefined), seen at `now`. */
export function homeTalkArgs(today: string, now: number, day?: string) {
  if (day) {
    return {
      from: londonMidnight(day),
      to: londonMidnight(addDays(day, 1)),
      paginationOpts: { numItems: DAY_TALKS, cursor: null },
    }
  }
  return {
    from: Math.max(londonMidnight(today), now - WEEK_LOOKBACK_MS),
    to: londonMidnight(addDays(today, 7)),
    paginationOpts: { numItems: WEEK_TALKS, cursor: null },
  }
}

/** Timed first, by time; all-day ones (often a vague listing) after them. */
function byTime<T extends { startsAt: number; allDay: boolean }>(a: T, b: T): number {
  return Number(a.allDay) - Number(b.allDay) || a.startsAt - b.startsAt
}

/**
 * The column's rows from a `talks.list` page: for a day, its talks in time
 * order — today from the first one still on, though a quiet evening still
 * shows the day's last few; for the week (`day` undefined), the next timed
 * talks not over yet, with their weekday. Cancelled talks are left out.
 */
export function homeTalkRows(
  talks: readonly TalkListItem[],
  { today, now, day }: { today: string; now: number; day?: string },
): HomeTalkRow[] {
  const notOver = (talk: TalkListItem) =>
    talk.allDay || (talk.endsAt ?? talk.startsAt + DEFAULT_LENGTH_MS) > now
  const live = talks.filter((talk) => !talk.cancelled).sort(byTime)
  const row = (talk: TalkListItem, weekday: boolean): HomeTalkRow => {
    const date = londonIsoDate(talk.startsAt)
    return {
      key: talk.key,
      href: talkHref(talk.key),
      time: talkTime(talk, today),
      weekday: weekday ? (date === today ? "Today" : weekdayShort(date)) : undefined,
      isToday: weekday && date === today,
      title: talk.title,
      meta: talkMeta(talk),
    }
  }
  if (!day) {
    return live
      .filter((talk) => notOver(talk) && !talk.allDay)
      .slice(0, HOME_ROWS)
      .map((talk) => row(talk, true))
  }
  let rows = live.filter((talk) => londonIsoDate(talk.startsAt) === day)
  if (day === today) {
    const first = rows.findIndex(notOver)
    const start = Math.max(0, Math.min(first === -1 ? rows.length : first, rows.length - HOME_ROWS))
    rows = rows.slice(start)
  }
  return rows.slice(0, HOME_ROWS).map((talk) => row(talk, false))
}
