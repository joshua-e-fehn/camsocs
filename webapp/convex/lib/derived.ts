import { DAY_MS, isoDateMs, londonIsoDate, londonOffsetMs } from "../../lib/calendar"
import {
  CATEGORY_LABELS,
  type Category,
  type EmailType,
  type OrgStatus,
  REGISTRATION_BODIES,
  type Term,
} from "../../lib/vocab"
import { type ApplicabilityContext, type FieldSpec, normaliseUrl } from "./fields"
import type { FieldMeta } from "./resolve"

/**
 * Derived fields (docs/data-model.md §6), as pure functions of an entity's
 * resolved values and a clock. convex/derive.ts applies them on ingest and
 * from the daily cron; nothing here reads the database.
 */

/** An organisation is `active` with dated activity within this window. */
export const ACTIVE_WINDOW_MS = 180 * DAY_MS

// The Europe/London calendar lives in lib/calendar.ts (shared with the
// webapp's events calendar); re-exported here for the Convex modules.
export { DAY_MS, londonIsoDate, londonOffsetMs }

/**
 * The academic year an instant falls in, e.g. "2026-27". Years turn over on
 * 1 July (London): society registrations open then, and named contacts
 * expire on 30 June (data-model §6).
 */
export function academicYearOf(ms: number): string {
  const [year, month] = londonIsoDate(ms).split("-").map(Number)
  const start = month >= 7 ? year : year - 1
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`
}

/** The next 30 June on or after `ms` (London date), as `YYYY-MM-DD` — the
 * default `people.staleAfter`. */
export function nextHandoverDate(ms: number): string {
  const [year, month, day] = londonIsoDate(ms).split("-").map(Number)
  const afterThisYears = month > 6 || (month === 6 && day > 30)
  return `${afterThisYears ? year + 1 : year}-06-30`
}

// --- term weeks ---------------------------------------------------------------------------

export type TermDates = {
  academicYear: string
  term: Term
  fullTermStart: string
  fullTermEnd: string
}

const TERM_PREFIX: Record<Term, string> = { michaelmas: "MT", lent: "LT", easter: "ET" }

/**
 * "MT26 Wk 3" for an instant inside a term's teaching weeks, else undefined.
 *
 * Cambridge convention (as Camdram and CUCBC label weeks): Full Term starts
 * on a Tuesday, and a "week" runs Thursday to Wednesday, so Week 1 begins on
 * the first Thursday of Full Term. Week 0 is the week before. Labels run from
 * Week 0 to the last day of Full Term: the last week ends with Full Term
 * (Michaelmas 2026: Week 9 = Thu 3 – Fri 4 Dec; source-research §19).
 */
export function termWeekLabel(ms: number, terms: readonly TermDates[]): string | undefined {
  const day = isoDateMs(londonIsoDate(ms))
  for (const term of terms) {
    const start = isoDateMs(term.fullTermStart)
    const end = isoDateMs(term.fullTermEnd)
    const firstThursday = start + ((4 - new Date(start).getUTCDay() + 7) % 7) * DAY_MS
    const week = Math.floor((day - firstThursday) / (7 * DAY_MS)) + 1
    if (week < 0 || day > end) continue
    const year = new Date(start).getUTCFullYear() % 100
    return `${TERM_PREFIX[term.term]}${String(year).padStart(2, "0")} Wk ${week}`
  }
  return undefined
}

// --- withdrawn events --------------------------------------------------------------------------

/**
 * Sources that list every current event each time they are read, by how far
 * one reading reaches: the whole source (one diary or listing) or one listing
 * URL (a feed, a talks list, a league). An event such a listing stops showing
 * was withdrawn — moved, renamed or dropped — even though nobody says so.
 * Mail, posts, termcards and manual entries are one-off readings: never.
 */
const WHOLE_SOURCE_LISTINGS = new Set(["camdram", "cucbc", "su_whatson"])
const PER_URL_LISTINGS = new Set([
  "talks_cam",
  "ics",
  "luma",
  "google_calendar",
  "playwaze",
  "uni_events_api",
])

/** How far a listed event's last sighting may lag its listing's newest
 * before it counts as no longer listed: a few daily runs. */
export const WITHDRAWN_AFTER_MS = 3 * DAY_MS

/**
 * The listing an event was read from (`events.sweepGroup`), or undefined for
 * a one-off source. Its newest sighting is what the event's own `lastSeenAt`
 * is compared with: a listing that is read again re-sights everything it
 * still shows, so an event it dropped falls behind — and a pipeline that
 * stops running stops every sighting at once, which hides nothing.
 */
export function sweepGroupOf(source: string, listingUrl: string | undefined): string | undefined {
  if (WHOLE_SOURCE_LISTINGS.has(source)) return source
  if (PER_URL_LISTINGS.has(source) && listingUrl) return `${source}:${normaliseUrl(listingUrl)}`
  return undefined
}

/** Whether a future event has fallen behind its listing (`sweepGroupOf`). */
export function isWithdrawn(
  event: { startsAt: number; lastSeenAt: number },
  listingNewest: number | undefined,
  now: number,
): boolean {
  return (
    event.startsAt >= now &&
    listingNewest !== undefined &&
    listingNewest - event.lastSeenAt > WITHDRAWN_AFTER_MS
  )
}

// --- organisation status --------------------------------------------------------------------

type RegistrationLike = { registered: boolean; year?: string }

/**
 * `active` if dated activity falls within 180 days or the organisation is on
 * a register for the current academic year; `dormant` if its last activity is
 * older and it is on no current register; `archived` if marked defunct;
 * otherwise `unknown` (data-model §6).
 *
 * A registration without a `year` counts as current when the claim that
 * reported it was retrieved in the current academic year — the registers list
 * the current year's societies.
 */
export function deriveOrgStatus(
  org: {
    defunct?: boolean
    lastActiveAt?: number
    registrations?: Partial<Record<(typeof REGISTRATION_BODIES)[number], RegistrationLike>>
    meta?: Record<string, FieldMeta | undefined>
  },
  now: number,
): OrgStatus {
  if (org.defunct === true) return "archived"
  const currentYear = academicYearOf(now)
  const registeredNow = REGISTRATION_BODIES.some((body) => {
    const registration = org.registrations?.[body]
    if (!registration?.registered) return false
    if (registration.year !== undefined) return registration.year === currentYear
    const seenAt = org.meta?.[`registrations.${body}`]?.retrievedAt
    return seenAt !== undefined && academicYearOf(seenAt) === currentYear
  })
  if (registeredNow) return "active"
  if (org.lastActiveAt !== undefined) {
    return now - org.lastActiveAt <= ACTIVE_WINDOW_MS ? "active" : "dormant"
  }
  return "unknown"
}

// --- email classification ----------------------------------------------------------------------

const WEBMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "hotmail.co.uk",
  "live.com",
  "live.co.uk",
  "yahoo.com",
  "yahoo.co.uk",
  "icloud.com",
  "me.com",
  "protonmail.com",
  "proton.me",
  "qq.com",
  "163.com",
  "aol.com",
])

/** A Cambridge CRSid: 2–5 letters then digits (e.g. `jf123`). */
const CRSID_LOCAL = /^[a-z]{2,5}[0-9]{1,5}$/

/** Domains outside cam.ac.uk that give every member an address at their
 * CRSid: SRCF user mail (`<crsid>@srcf.net`) and the alumni forwarding
 * services. A CRSid there names a person just as on cam.ac.uk. */
const CRSID_MAIL_DOMAINS = new Set(["srcf.net", "srcf.ucam.org", "cantab.ac.uk", "cantab.net"])

/**
 * What kind of address an email is (`EMAIL_TYPES`). Derived on the server from
 * the resolved address — never claimed — because the public projection
 * depends on it: a `personal_crsid` address names a person and is never shown.
 */
export function classifyEmail(email: string): EmailType {
  const address = email.trim().toLowerCase()
  const at = address.lastIndexOf("@")
  const local = address.slice(0, at)
  const domain = address.slice(at + 1)
  // On cam.ac.uk or any subdomain (hermes, college domains), SRCF or cantab:
  // a CRSid-shaped local part names a person. Errs toward hiding a role
  // address like `jcr1@`.
  const camDomain =
    (domain === "cam.ac.uk" || domain.endsWith(".cam.ac.uk")) && domain !== "lists.cam.ac.uk"
  if ((camDomain || CRSID_MAIL_DOMAINS.has(domain)) && CRSID_LOCAL.test(local)) {
    return "personal_crsid"
  }
  if (/(^|\.)cusu\./.test(domain) || domain === "cusu.org") return "legacy_cusu"
  if (domain === "cambridgesu.co.uk" || domain.endsWith(".cambridgesu.co.uk")) return "cambridgesu"
  if (domain === "lists.cam.ac.uk") return "lists_cam"
  if (/(^|\.)srcf\.(net|ucam\.org)$/.test(domain)) return "srcf"
  if (domain.endsWith(".cam.ac.uk")) return "college_domain"
  if (WEBMAIL_DOMAINS.has(domain)) return "webmail"
  return "role_own_domain"
}

// --- search text, missing fields ----------------------------------------------------------------

/** Lowercased, de-duplicated text the search index matches (data-model §6). */
export function orgSearchText(org: {
  name: string
  aliases?: readonly string[]
  shortName?: string
  shortDescription?: string
  tags?: readonly string[]
  categories?: readonly string[]
}): string {
  const parts = [
    org.name,
    ...(org.aliases ?? []),
    org.shortName,
    org.shortDescription,
    ...(org.tags ?? []).map((tag) => tag.replace(/-/g, " ")),
    ...(org.categories ?? []).map((category) => CATEGORY_LABELS[category as Category] ?? category),
  ]
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of parts) {
    const text = part?.trim().toLowerCase()
    if (!text || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out.join(" · ")
}

/**
 * The tracked fields whose status is `missing` — the phase-2 outreach list.
 * Counterparts (colleges, companies, offices) are never asked, so theirs is
 * empty.
 */
export function missingFields(
  specs: Record<string, FieldSpec>,
  meta: Record<string, FieldMeta | undefined>,
  context: ApplicabilityContext,
): string[] {
  if (context.isCounterpart) return []
  return Object.entries(specs)
    .filter(([field, spec]) => spec.tracked && meta[field]?.status === "missing")
    .map(([field]) => field)
}
