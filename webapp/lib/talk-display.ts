import { londonIsoDate, londonTime } from "./calendar"
import type { TalkListItem } from "./public-api"
import { TALK_SCHOOLS, type TalkSchool } from "./vocab"

/**
 * How a talk shows up outside /talks, as pure functions (tested in
 * lib/talk-display.test.ts): its link, the home page's agenda line and
 * "Talks by department" columns, and its line in the ⌘K palette.
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
