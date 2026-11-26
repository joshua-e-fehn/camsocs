import { sha1Hex } from "../../lib/hash"
import { isTalksDerivedEvent, type TalksBoundaryRecord } from "../../lib/talks-boundary"

/**
 * Recurring events (ENG-282): which series an event belongs to, so a named
 * yearly event keeps one page (`/events/series/<slug>`) while each year's
 * edition gets a new event URL. Search ranking then builds on the series
 * page instead of restarting every year (evidence: "steele bodgers 2026",
 * "fairbairn cup 2026" ranked ~8 on single event pages).
 *
 * A series is derived on the server from the event alone, never claimed:
 *
 *  - a short curated list of famous fixtures whose titles carry no year
 *    (`CURATED_SERIES`), matched on the title across organisers;
 *  - otherwise an edition title, "<name> <year>[: subtitle]" ("The Cambridge
 *    Greek Play 2026", "CUADC/Footlights Pantomime 2026: Cinderella"): the
 *    name before the year, with one organiser, is the series.
 *
 * Never a series: someone else's event a society only takes part in
 * (`hosting: takes_part`, D6), a talks.cam-derived event (G1, checked by the
 * callers), a year that is part of a topic ("2026 US Midterm Elections",
 * "1748–2026") or a date ("10 Nov 2026").
 */

/** Famous yearly fixtures whose listings name no year. */
export const CURATED_SERIES: readonly { slug: string; name: string; match: RegExp }[] = [
  {
    slug: "steele-bodger",
    name: "The Steele-Bodger Match",
    match: /^(the\s+)?steele[\s-]?bodgers?\b/i,
  },
  { slug: "fairbairn-cup", name: "The Fairbairn Cup (Fairbairns)", match: /^fairbairns?\b/i },
]

export type SeriesMatch = {
  /** Stable identity: `ser-` + a hash of the organiser and the normalised name. */
  key: string
  /** Display name of the series, as the latest edition spells it. */
  name: string
  /** The curated slug, when the series is curated; else minted at creation. */
  slug?: string
}

const MONTHS =
  "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec"
const SEASONS = "michaelmas|lent|easter|summer|winter|spring|autumn"
/** A year, optionally an academic one ("2026-27", "2026/2027"), optionally in brackets. */
const YEAR = /\(?\b(20\d{2})(?:\s?[-–/]\s?(?:20)?\d{2})?\b\)?/u
const DAY_MONTH = new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})\\.?$`, "i")
const MONTH_OR_SEASON = new RegExp(`\\s+(?:${MONTHS}|${SEASONS})$`, "i")
/** What may follow the year in an edition title: the end, a subtitle, an aside. */
const AFTER_YEAR = /^(?:$|[:(\-–—|,])/u
const SEGMENT = /\s+[-–—|]\s+/u

/** Lower-case, accents and punctuation dropped, spaces collapsed. */
export function normaliseSeriesName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
}

/** The series name an edition title carries, or null when it carries none. */
export function seriesNameOf(title: string): string | null {
  const text = title.replace(/^[^\p{L}\p{N}"'(]+/u, "").trim()
  const found = YEAR.exec(text)
  if (!found) return null
  // "1748–2026": the year closes a range, so it is a topic.
  if (/[\p{N}][-–/]$/u.test(text.slice(0, found.index))) return null
  let before = text.slice(0, found.index).trimEnd()
  const after = text.slice(found.index + found[0].length).trimStart()
  if (!before || !AFTER_YEAR.test(after)) return null
  if (DAY_MONTH.test(before)) return null
  const stripped = before.replace(MONTH_OR_SEASON, "")
  if (stripped.trim()) before = stripped
  before = before.replace(/[\s:,\-–—|]+$/u, "").trim()
  const segments = before.split(SEGMENT)
  const last = segments[segments.length - 1]
  if (segments.length > 1 && last.split(/\s+/).length >= 2) before = last
  return normaliseSeriesName(before).replace(/\s/g, "").length >= 8 ? before : null
}

/** The series an event belongs to, or null. */
export function seriesOf(event: {
  title: string
  organiserKeys: readonly string[]
  hosting?: string
}): SeriesMatch | null {
  if (event.hosting === "takes_part") return null
  const text = event.title.replace(/^[^\p{L}\p{N}"'(]+/u, "").trim()
  for (const curated of CURATED_SERIES) {
    if (curated.match.test(text)) {
      return { key: `ser-${curated.slug}`, name: curated.name, slug: curated.slug }
    }
  }
  const name = seriesNameOf(text)
  if (!name) return null
  const organiser = event.organiserKeys[0] ?? "none"
  return {
    key: `ser-${sha1Hex(`${organiser}|${normaliseSeriesName(name)}`).slice(0, 16)}`,
    name,
  }
}

/** A URL slug for a series name: "The Cambridge Greek Play" → "cambridge-greek-play". */
export function seriesSlugOf(name: string): string {
  return normaliseSeriesName(name.replace(/['’]/g, ""))
    .replace(/^the\s+/, "")
    .replace(/\s+/g, "-")
    .slice(0, 80)
    .replace(/-+$/, "")
}

/** The series of a stored event: `seriesOf`, and never for a talks.cam-derived
 * event (G1: its title must not reach a page outside /talks). */
export function eventSeriesOf(
  event: TalksBoundaryRecord & {
    title: string
    organiserKeys: readonly string[]
    hosting?: string
  },
): SeriesMatch | null {
  return isTalksDerivedEvent(event) ? null : seriesOf(event)
}
