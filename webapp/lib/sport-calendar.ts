import { londonIsoDate } from "./calendar"

/**
 * The races and fixtures the rowing and Varsity guides list as "coming up"
 * (ENG-109, ENG-110): picked from the sport events CAMsocs already holds
 * (the CUCBC timetable, clubs' own sites), so the guides' dates move on with
 * the data and are never typed by hand. Pure.
 *
 * Clubs repost the same races under their own titles, so one
 * race can arrive several times under different titles ("Fairbairn Cup -
 * Novices (Jesus)", "Fairbairn Cup (novices)"): one per day and first word
 * is kept, the host's own listing first.
 */

export type SportEvent = {
  key: string
  title: string
  startsAt: number
  endsAt?: number
  allDay: boolean
  cancelled?: boolean
  source?: string
  hosting?: string
  talksDerived?: boolean
  organisers: { key: string; name: string; slug: string }[]
}

const ROWING = /\b(bumps|fairbairns?|regatta|head|sprint|trial eights|boat race|getting-on)\b/i
const VARSITY = /\b(varsity|boat race|blues? match)\b/i

/** Rowing dates come from the rowing bodies themselves: CUCBC's timetable and
 * the University Boat Club. A college club reposting the calendar on its own
 * site can carry an older date (Clare Hall BC's Lent Bumps getting-on race,
 * 26 Feb, against CUCBC's 5 Mar 2027), so those are left out. */
const fromRowingBody = (event: SportEvent) =>
  event.source === "cucbc" || event.organisers.some((org) => org.slug === "boat-club-rowing")

function firstWord(title: string): string {
  return title.toLowerCase().match(/[a-z]+/)?.[0] ?? ""
}

/** One event per London day and first title word; hosts before guests. */
export function dedupeRuns<T extends SportEvent>(events: readonly T[]): T[] {
  const ranked = [...events].sort(
    (a, b) =>
      a.startsAt - b.startsAt ||
      Number(a.hosting === "takes_part") - Number(b.hosting === "takes_part"),
  )
  const seen = new Set<string>()
  return ranked.filter((event) => {
    const id = `${londonIsoDate(event.startsAt)}|${firstWord(event.title)}`
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

const listable = (event: SportEvent) => !event.cancelled && !event.talksDerived

/** Upcoming college and University rowing races, in date order. */
export function rowingRaces<T extends SportEvent>(events: readonly T[]): T[] {
  return dedupeRuns(
    events.filter((event) => listable(event) && fromRowingBody(event) && ROWING.test(event.title)),
  )
}

/** Upcoming Varsity fixtures (any sport), in date order. */
export function varsityFixtures<T extends SportEvent>(events: readonly T[]): T[] {
  return dedupeRuns(events.filter((event) => listable(event) && VARSITY.test(event.title)))
}
