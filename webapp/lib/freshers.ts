import data from "@/lib/data/guides/freshers.json"
import type { GuideSection } from "./guide-content"

/**
 * The Freshers' and Refreshers' guide's researched text and key dates
 * (ENG-117), from the University, Cambridge SU and college pages
 * (`checkedOn`), with the CAMsocs pages each section points to.
 */

export type KeyDate = { event: string; date: string | null; sources: string[] }

export const FRESHERS_CHECKED_ON: string = data.checkedOn
export const FRESHERS_SECTIONS: readonly GuideSection[] = data.sections
export const FRESHERS_DATES: readonly KeyDate[] = data.keyDates
export const FRESHERS_LINKS: Record<string, readonly (readonly [string, string])[]> =
  Object.fromEntries(
    Object.entries(data.links as Record<string, string[][]>).map(([id, links]) => [
      id,
      links.map(([href, label]) => [href, label] as const),
    ]),
  )
