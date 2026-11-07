import data from "@/lib/data/guides/rowing.json"
import type { GuideParagraph, GuideSection } from "./guide-content"

/**
 * The rowing guide's researched text, key dates and glossary (ENG-109), from
 * CUCBC, CUBC, The Boat Race and the clubs' own pages (`checkedOn`). A date
 * CUCBC has only on its river-closures list, not yet on its own race page,
 * is `provisional`.
 */

export type RowingDate = {
  event: string
  start: string | null
  end: string | null
  provisional: boolean
  sources: string[]
}
export type GlossaryEntry = GuideParagraph & { term: string }

export const ROWING_CHECKED_ON: string = data.checkedOn
export const ROWING_SECTIONS: readonly GuideSection[] = data.sections
export const ROWING_DATES: readonly RowingDate[] = data.dates
export const ROWING_GLOSSARY: readonly GlossaryEntry[] = data.glossary

/** The glossary as a guide section, so its sources join the page's list. */
export const GLOSSARY_SECTION: GuideSection = {
  id: "glossary",
  title: "Words you will hear",
  paragraphs: data.glossary.map(({ text, sources }) => ({ text, sources })),
}
