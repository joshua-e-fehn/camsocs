/**
 * Display helpers for the broker area. Dates show in Europe/London
 * (data-model §0 rule 6); vocabulary values become sentence-case words.
 */

const LONDON = "Europe/London"

/** "7 Oct 2026" from epoch ms or an ISO date. */
export function formatDate(value: number | string | undefined): string {
  if (value === undefined || value === "") return "—"
  const date = typeof value === "number" ? new Date(value) : new Date(`${value}T12:00:00Z`)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: LONDON,
  })
}

/** "7 Oct 2026, 14:05". */
export function formatDateTime(ms: number | undefined | null): string {
  if (ms === undefined || ms === null) return "—"
  return new Date(ms).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: LONDON,
  })
}

/** Today's London date as ISO `YYYY-MM-DD`. */
export function todayIso(now: number = Date.now()): string {
  return new Date(now).toLocaleDateString("en-CA", { timeZone: LONDON })
}

/** `careers_access` → "Careers access"; `sport.blueStatus` → "Sport blue status". */
export function humanize(value: string): string {
  const words = value
    .replace(/[._]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** "42%" for a 0..1 share. */
export function percent(share: number): string {
  return `${Math.round(share * 100)}%`
}

/** The host of an http(s) URL, or null for anything else (internal URIs). */
export function urlHost(url: string | undefined): string | null {
  if (!url || !/^https?:\/\//i.test(url)) return null
  try {
    return new URL(url).host.replace(/^www\./, "")
  } catch {
    return null
  }
}

/** "contact email" → "Contact email" (only the first letter changes). */
export function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Event sources as people name them. */
export const EVENT_SOURCE_LABELS: Record<string, string> = {
  camdram: "Camdram",
  talks_cam: "talks.cam",
  ics: "Calendar feeds (ICS)",
  luma: "Luma",
  google_calendar: "Google Calendar",
  playwaze: "Playwaze",
  uni_events_api: "University events",
  cucbc: "CUCBC",
  su_whatson: "SU What's On",
  mailing_list: "Mailing lists",
  instagram_api: "Instagram",
  termcard: "Termcards",
  website: "Websites",
  manual: "Manual",
}

/** Relationship types as phrases. */
export const RELATIONSHIP_LABELS: Record<string, string> = {
  sponsors: "Sponsors",
  co_hosted: "Co-hosted",
  sister_of: "Sister society",
  affiliated_with: "Affiliated with",
  parent_of: "Parent of",
  member_college: "Member college",
  speaker_from: "Speaker from",
  partner_of: "Partner of",
  venue_host: "Venue host",
}
