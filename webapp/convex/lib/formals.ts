import { ConvexError } from "convex/values"
import { isIsoDate, londonIsoDate } from "../../lib/calendar"

/**
 * Rules for the formal tracker (convex/formals.ts, ENG-272), ported from the
 * Cambridge Tracker's `convex/lib/formals.ts`. Pure: every check returns a
 * fresh value or throws a `ConvexError` whose message the form shows as is.
 */

/**
 * The 31 colleges by organisation key, with the short name the leaderboard
 * shows. Held here, not read from lib/data/colleges.json, so the Convex bundle
 * carries no formal-hall text; convex/lib/formals.test.ts asserts the two
 * agree.
 */
export const FORMAL_COLLEGES: Readonly<Record<string, string>> = {
  "org-christs-college": "Christ’s",
  "org-churchill-college": "Churchill",
  "org-clare-college": "Clare",
  "org-clare-hall": "Clare Hall",
  "org-corpus-christi-college": "Corpus Christi",
  "org-darwin-college": "Darwin",
  "org-downing-college": "Downing",
  "org-emmanuel-college": "Emmanuel",
  "org-fitzwilliam-college": "Fitzwilliam",
  "org-girton-college": "Girton",
  "org-gonville-and-caius-college": "Gonville & Caius",
  "org-homerton-college": "Homerton",
  "org-hughes-hall": "Hughes Hall",
  "org-jesus-college": "Jesus",
  "org-kings-college": "King’s",
  "org-lucy-cavendish-college": "Lucy Cavendish",
  "org-magdalene-college": "Magdalene",
  "org-murray-edwards-college": "Murray Edwards",
  "org-newnham-college": "Newnham",
  "org-pembroke-college": "Pembroke",
  "org-peterhouse": "Peterhouse",
  "org-queens-college": "Queens’",
  "org-robinson-college": "Robinson",
  "org-selwyn-college": "Selwyn",
  "org-sidney-sussex-college": "Sidney Sussex",
  "org-st-catharines-college": "St Catharine’s",
  "org-st-edmunds-college": "St Edmund’s",
  "org-st-johns-college": "St John’s",
  "org-trinity-college": "Trinity",
  "org-trinity-hall": "Trinity Hall",
  "org-wolfson-college": "Wolfson",
}

export const FORMAL_LIMITS = {
  visits: 200,
  notes: 2_000,
  displayNameMin: 2,
  displayNameMax: 24,
  leaderboard: 50,
} as const

const COLLEGE_KEYS: ReadonlySet<string> = new Set(Object.keys(FORMAL_COLLEGES))

export function validateCollegeKey(collegeKey: string): string {
  if (!COLLEGE_KEYS.has(collegeKey)) {
    throw new ConvexError("Choose one of the 31 Cambridge colleges.")
  }
  return collegeKey
}

/**
 * A formal's date: a real `YYYY-MM-DD` day, not after today in London, and
 * not before 1950. Null clears it.
 */
export function validateVisitedOn(value: string | null, now: number): string | null {
  if (value === null) return null
  const date = value.trim()
  if (date === "") return null
  if (!isIsoDate(date) || date < "1950-01-01") {
    throw new ConvexError("Enter the formal's date as a real day (YYYY-MM-DD).")
  }
  if (date > londonIsoDate(now)) {
    throw new ConvexError("The formal's date cannot be in the future.")
  }
  return date
}

export function validateVisits(visits: number): number {
  if (!Number.isInteger(visits) || visits < 0 || visits > FORMAL_LIMITS.visits) {
    throw new ConvexError(
      `Formals at one college must be a whole number from 0 to ${FORMAL_LIMITS.visits}.`,
    )
  }
  return visits
}

export function validateNotes(notes: string): string {
  const text = notes.trim()
  if (text.length > FORMAL_LIMITS.notes) {
    throw new ConvexError(
      `Notes must be ${FORMAL_LIMITS.notes.toLocaleString("en-GB")} characters or fewer.`,
    )
  }
  return text
}

/** Letters (any script), digits, spaces and ' - _ . ’ only. */
const NAME_CHARS = /^[\p{L}\p{M}\d '\-_.’]+$/u
/** A word shaped like a Cambridge CRSid (`abc123`). */
const CRSID = /^[a-z]{2,5}\d{1,5}$/i
/** A domain-like run (`camsocs.uk`, `www.x`), spaced dots too (`bit . ly`). */
const DOMAIN = /[\p{L}\d]\s*\.\s*\p{L}{2,}/u
/** What splits a name into words for the CRSid check: every allowed separator,
 * so `jef76_`, `x-jef76` and `jef76’s` are caught as well as `jef76`. */
const WORD_BREAK = /[\s'\-_.’]+/

/**
 * A leaderboard name: 2–24 characters of the allowed set, no address, URL or
 * CRSid, so the public-to-members board never names someone by an
 * identifier. Inner whitespace collapses to one space. Null clears it.
 */
export function validateDisplayName(value: string | null): string | null {
  if (value === null) return null
  const name = value.trim().replace(/\s+/g, " ")
  if (name === "") return null
  if (name.length < FORMAL_LIMITS.displayNameMin || name.length > FORMAL_LIMITS.displayNameMax) {
    throw new ConvexError(
      `Your leaderboard name must be ${FORMAL_LIMITS.displayNameMin}–${FORMAL_LIMITS.displayNameMax} characters.`,
    )
  }
  if (name.includes("@")) throw new ConvexError("Your leaderboard name cannot be an email address.")
  if (!NAME_CHARS.test(name)) {
    throw new ConvexError("Use letters, numbers, spaces and ' - _ . only in your leaderboard name.")
  }
  if (DOMAIN.test(name)) throw new ConvexError("Your leaderboard name cannot be a web address.")
  if (name.split(WORD_BREAK).some((word) => CRSID.test(word))) {
    throw new ConvexError("Your leaderboard name cannot look like a CRSid.")
  }
  return name
}

/** What one row contributes to a profile's counts. */
export type TrackedCollege = { attended: boolean; visits: number }

/** A profile's counts from its entries: ticked colleges, and their formals
 * (a ticked college counts at least one). */
export function trackerCounts(entries: readonly TrackedCollege[]): {
  colleges: number
  visits: number
} {
  let colleges = 0
  let visits = 0
  for (const entry of entries) {
    if (!entry.attended) continue
    colleges += 1
    visits += Math.max(1, entry.visits)
  }
  return { colleges, visits }
}

/** One leaderboard row before naming. */
export type RankedProfile = { colleges: number; visits: number; reachedAt: number }

/** Leaderboard order: colleges desc, then formals desc, then who got there first. */
export function compareProfiles(a: RankedProfile, b: RankedProfile): number {
  return b.colleges - a.colleges || b.visits - a.visits || a.reachedAt - b.reachedAt
}
