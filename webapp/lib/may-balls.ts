import data from "@/lib/data/guides/may-balls.json"
import type { GuideParagraph, GuideSection } from "./guide-content"

/**
 * May Balls and June Events (ENG-108): what each college's ball publishes
 * for the coming May Week, researched from the balls' own sites
 * (`checkedOn`), and the guide's text. A college's page shows its ball in a
 * "May Ball" section (#may-ball), whose URL stays the same every year, so a
 * search for "<college> May Ball 2027" finds a page that is updated, not a
 * new one. What a ball has not announced is null, never guessed.
 */

export type BallKind = "ball" | "june_event" | "garden_party" | "other"

export type MayBall = {
  collegeKey: string
  /** The event's own name ("First and Third Trinity May Ball"). */
  name: string
  kind: BallKind
  website: string | null
  /** `YYYY-MM-DD` of the next ball, when announced. */
  date: string | null
  /** The date as the site gives it, or "Not yet announced". */
  dateText: string
  frequency: string | null
  dress: string | null
  tickets: string | null
  price: string | null
  workers: string | null
  theme: string | null
  sources: string[]
}

export const MAY_BALL_ANCHOR = "may-ball"
export const MAY_BALLS_CHECKED_ON: string = data.checkedOn
export const MAY_WEEK: GuideParagraph = data.mayWeek
export const MAY_BALL_SECTIONS: readonly GuideSection[] = data.sections
export const MAY_BALLS: readonly MayBall[] = data.balls as MayBall[]

export const BALL_KIND_LABELS: Record<BallKind, string> = {
  ball: "May Ball",
  june_event: "June Event",
  garden_party: "Garden party",
  other: "Ball outside May Week",
}

/** The first sentence of a ball's ticket news, for the guide's table. */
export function ticketsInBrief(tickets: string | null): string {
  if (!tickets) return "Not yet announced"
  const [first] = tickets.split(/(?<=\.)\s/)
  return first
}

/** A college's ball(s), by its organisation key. */
export function ballsOf(collegeKey: string): MayBall[] {
  return MAY_BALLS.filter((ball) => ball.collegeKey === collegeKey)
}

/** Balls by date (announced first, earliest first), then by name. */
export function ballsByDate(balls: readonly MayBall[] = MAY_BALLS): MayBall[] {
  return [...balls].sort(
    (a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999") || a.name.localeCompare(b.name),
  )
}
