import data from "@/lib/data/guides/varsity.json"
import type { GuideSection } from "./guide-content"

/**
 * The Varsity guide's researched text and this season's fixtures (ENG-110,
 * ENG-111), from the organisers' own pages (`checkedOn`). A date no organiser
 * has published is null and its text says so.
 */

export type Fixture = {
  sport: string
  event: string
  date: string | null
  dateText: string
  venue: string | null
  sources: string[]
}

export const VARSITY_CHECKED_ON: string = data.checkedOn
export const VARSITY_SECTIONS: readonly GuideSection[] = data.sections
export const VARSITY_FIXTURES: readonly Fixture[] = data.fixtures

/** Fixtures in date order, those with a published date first. */
export function fixturesByDate(fixtures: readonly Fixture[] = VARSITY_FIXTURES): Fixture[] {
  return [...fixtures].sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999"))
}
