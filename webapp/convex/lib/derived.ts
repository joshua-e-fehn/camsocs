import { DAY_MS, londonIsoDate, londonOffsetMs } from "../../lib/calendar"
import type { CampusProfile } from "../../lib/campus"
import { deploymentProfile } from "../../lib/campus/deployment"
import { classifyMemberEmail, NAME_SHAPED_LOCAL } from "../../lib/campus/member-email"
import { termWeekLabel as campusTermWeekLabel } from "../../lib/campus/terms"
import {
  CATEGORY_LABELS,
  type Category,
  type EmailType,
  type OrgStatus,
  type RegistrationBody,
  type Term,
} from "../../lib/vocab"
import { type ApplicabilityContext, type FieldSpec, normaliseUrl } from "./fields"
import type { FieldMeta } from "./resolve"

/**
 * Derived fields (docs/data-model.md §6), as pure functions of an entity's
 * resolved values and a clock. convex/derive.ts applies them on ingest and
 * from the daily cron; nothing here reads the database.
 *
 * The campus rules (term weeks, member addresses, the university's own
 * listings, current registers) come from the deployment's campus profile
 * (lib/campus, decision D8): `cam` unless `CAMSOCS_CAMPUS` says otherwise.
 * Each takes the profile as a last, defaulted argument, so tests can pass
 * another campus's.
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

/**
 * "MT26 Wk 3" for an instant inside a term's teaching weeks, else undefined
 * (lib/campus/terms.ts, under the campus's term model).
 *
 * Cambridge convention (as Camdram and CUCBC label weeks): Full Term starts
 * on a Tuesday, and a "week" runs Thursday to Wednesday, so Week 1 begins on
 * the first Thursday of Full Term. Week 0 is the week before. Labels run from
 * Week 0 to the last day of Full Term: the last week ends with Full Term
 * (Michaelmas 2026: Week 9 = Thu 3 – Fri 4 Dec; source-research §19).
 */
export function termWeekLabel(
  ms: number,
  terms: readonly TermDates[],
  profile: CampusProfile = deploymentProfile(),
): string | undefined {
  return campusTermWeekLabel(ms, terms, profile.facts.terms)
}

// --- withdrawn events --------------------------------------------------------------------------

/**
 * Sources that list every current event each time they are read, by how far
 * one reading reaches: the whole source (one diary or listing) or one listing
 * URL (a feed, a talks list, a league, a society's events page, a termcard).
 * An event such a listing stops showing was withdrawn — moved, renamed or
 * dropped — even though nobody says so. A society's events page and a
 * termcard are re-read (from the reply cache) on every run, and their events'
 * keys come from the model's wording and the date, so a renamed or moved
 * event is a new key and the old one must fall behind its society's site
 * (review 2026-10-10; `OWN_SITE_SOURCES`). Mail, posts and manual entries are
 * one-off readings: never.
 */
const WHOLE_SOURCE_LISTINGS = new Set(["camdram", "cucbc", "su_whatson"])
/**
 * A society's own site — its pages (`website`) and the term cards and posters
 * those pages show or link (`termcard` read off a page: its listing URL, the
 * page, differs from its source URL, the card file) — is one listing per
 * society, keyed by the organisation in the external id (`<org key>:<London
 * date>:<slug>`), not one per page (ENG-36). The website stage reads the
 * whole site, its cards included, in one pass each run and leaves out a
 * card's event the site's own text already lists, on any of its pages; a card
 * event posted before the site's text listed it would otherwise keep a
 * listing of its own that nothing sights any more, which withdraws nothing,
 * and show beside the page's event (the German Society's term card and its
 * calendar page, 2026-11-02). A card read as a file (a `termcardUrl` that is
 * the file) is fetched on its own, often from another host, and may go
 * unread while the site is still read (a failed fetch, the termcards stage's
 * budget), so it keeps its own listing. An external id without an
 * organisation falls back to its listing URL.
 */
const OWN_SITE_SOURCES = new Set(["website", "termcard"])
const ORG_SCOPED_ID = /^(org-[a-z0-9-]+):/
const PER_URL_LISTINGS = new Set([
  "talks_cam",
  "ics",
  "luma",
  "google_calendar",
  "playwaze",
  "uni_events_api",
  "website",
  "termcard",
])

/** How far a listed event's last sighting may lag its listing's newest
 * before it counts as no longer listed: a few daily runs. */
export const WITHDRAWN_AFTER_MS = 3 * DAY_MS

/**
 * The listing an event was read from (`events.sweepGroup`), or undefined for
 * a one-off source. Its newest sighting is what the event's own `lastSeenAt`
 * is compared with: a listing that is read again re-sights everything it
 * still shows, so an event it dropped falls behind — and a pipeline that
 * stops running stops every sighting at once, which hides nothing. A
 * society's own site and the cards read off its pages are one listing
 * (`OWN_SITE_SOURCES`): `own:<org key>`.
 */
export function sweepGroupOf(
  source: string,
  listingUrl: string | undefined,
  row: { externalId?: string; sourceUrl?: string } = {},
): string | undefined {
  if (WHOLE_SOURCE_LISTINGS.has(source)) return source
  const owner = ownSiteOf(source, listingUrl, row)
  if (owner) return `own:${owner}`
  if (PER_URL_LISTINGS.has(source) && listingUrl) return `${source}:${normaliseUrl(listingUrl)}`
  return undefined
}

/** The society whose own site an event was read from (`OWN_SITE_SOURCES`). */
function ownSiteOf(
  source: string,
  listingUrl: string | undefined,
  row: { externalId?: string; sourceUrl?: string },
): string | undefined {
  if (!OWN_SITE_SOURCES.has(source)) return undefined
  if (source === "termcard") {
    const readOffPage =
      listingUrl !== undefined &&
      row.sourceUrl !== undefined &&
      normaliseUrl(listingUrl) !== normaliseUrl(row.sourceUrl)
    if (!readOffPage) return undefined
  }
  return row.externalId?.match(ORG_SCOPED_ID)?.[1]
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

// --- University events ---------------------------------------------------------------------

/**
 * Whether an event is the University's own listing (ENG-24): read from the
 * university's public events programme (the campus's
 * `officialEventSources`; Cambridge: `uni_events_api`) and credited to no
 * student group as organiser or co-host. Such an event is
 * shown as "University of Cambridge" and is what the calendar's University
 * switch selects. The projection derives `fromUniversity` from the row with
 * this at every read; the stored, indexed copy is `events.stream`
 * (`eventStreamOf`, ENG-31), which only selects rows.
 */
export function isUniversityListing(
  event: {
    source: string
    organiserKeys: readonly string[]
    coHostKeys: readonly string[]
  },
  profile: CampusProfile = deploymentProfile(),
): boolean {
  return (
    profile.facts.officialEventSources.includes(event.source) &&
    event.organiserKeys.length === 0 &&
    event.coHostKeys.length === 0
  )
}

/** The two listing streams of the calendar (ENG-31): the University's own
 * listings and everything else (a society's, a club's, a college's). */
export const EVENT_STREAMS = ["society", "university"] as const
export type EventStream = (typeof EVENT_STREAMS)[number]

/**
 * The stream an event belongs to (`events.stream`, ENG-31): `university` for
 * the University's own listing (`isUniversityListing`), else `society`.
 * Stored and indexed so `events.list` reads each stream through its own
 * index range, and a window crowded with one stream (the Cambridge
 * Festival's University listings) cannot push the other past the 1,000-row
 * cap. Every write of `source` or of the organiser keys re-derives it
 * (lib/materialise.ts, ingest/relationships.ts, ingest/purge.ts), and the
 * daily walk (convex/derive.ts `recomputeEvents`) fills it in on rows written
 * before it existed.
 */
export function eventStreamOf(
  event: {
    source: string
    organiserKeys: readonly string[]
    coHostKeys: readonly string[]
  },
  profile: CampusProfile = deploymentProfile(),
): EventStream {
  return isUniversityListing(event, profile) ? "university" : "society"
}

// --- organisation status --------------------------------------------------------------------

type RegistrationLike = { registered: boolean; year?: string }

/**
 * The registers that list only the current year's groups (the campus's
 * `currentYearRegisters`; Cambridge: the SU directory, the Proctors'
 * register, the Sports Service, CUCBC). Camdram is a directory that keeps
 * every society that ever put on a show (ENG-36: "Sketch Club" listed since
 * 2017, and 0 of 801 groups dormant), so a Camdram listing is not a current
 * registration; a theatre group's shows count through its events
 * (`lastActiveAt`), like any group's.
 */
export function currentYearRegisters(
  profile: CampusProfile = deploymentProfile(),
): readonly RegistrationBody[] {
  return profile.currentYearRegisters
}

/**
 * `active` if dated activity falls within 180 days or the organisation is on
 * a register for the current academic year (`currentYearRegisters`);
 * `dormant` if its last activity is older and it is on no current register;
 * `archived` if marked defunct; otherwise `unknown` (data-model §6).
 *
 * A registration without a `year` counts as current when the claim that
 * reported it was retrieved in the current academic year — the registers list
 * the current year's societies.
 */
export function deriveOrgStatus(
  org: {
    defunct?: boolean
    lastActiveAt?: number
    registrations?: Partial<Record<RegistrationBody, RegistrationLike>>
    meta?: Record<string, FieldMeta | undefined>
  },
  now: number,
  profile: CampusProfile = deploymentProfile(),
): OrgStatus {
  if (org.defunct === true) return "archived"
  const currentYear = academicYearOf(now)
  const registeredNow = currentYearRegisters(profile).some((body) => {
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

// The member-id rule (Cambridge: a CRSid, 2–5 letters then digits, on
// cam.ac.uk, its subdomains, SRCF user mail and the alumni forwarding
// services) is the campus's `memberEmail` (lib/campus/member-email.ts
// `classifyMemberEmail`).

/** Alumni addresses: the campus's forwarding services (`memberEmail.alumni`;
 * Cambridge's cantab.ac.uk and cantab.net, Oxford's oxon.org) and any
 * `alumni.` / `alum.` host (alumni.cam.ac.uk, alum.example.edu). Each address
 * there is one graduate's, whatever its shape (`jane.smith2@`, `janesmith@`,
 * `anna.lena.van.berg@`, `jane+chess@`), unless it is named after a post. */
function isAlumniDomain(domain: string, profile: CampusProfile): boolean {
  return (
    profile.facts.memberEmail.alumni.includes(domain) ||
    domain.split(".").some((label) => label === "alumni" || label === "alum")
  )
}

/** Words that make an alumni address a post's or an office's
 * (`president@cantab.net`, `development@alumni.cam.ac.uk`); mirrored in
 * pipeline/.../sources/links.py `_POST_WORDS`. */
const POST_WORDS = new Set([
  "president",
  "secretary",
  "treasurer",
  "sponsorship",
  "events",
  "publicity",
  "welfare",
  "captain",
  "chair",
  "info",
  "contact",
  "enquiries",
  "hello",
  "admin",
  "office",
  "committee",
  "society",
  "club",
  "association",
  "team",
  "members",
  "membership",
  "webmaster",
  "development",
  "alumni",
  "news",
])

/** Whether an alumni address is named after a post: one of its words (runs
 * of letters) is a post word, and it is not name-shaped (`jane.president@`
 * still names Jane). */
function isPostAddress(local: string): boolean {
  if (NAME_SHAPED_LOCAL.test(local)) return false
  return local.split(/[^a-z]+/).some((word) => POST_WORDS.has(word))
}

/**
 * What kind of address an email is (`EMAIL_TYPES`). Derived on the server from
 * the resolved address — never claimed — because the public projection
 * depends on it: a `personal_crsid` address names a person and is never shown.
 *
 * In order: the campus's member rule (`classifyMemberEmail`: Cambridge's
 * CRSid on cam.ac.uk or any subdomain, SRCF or cantab), alumni addresses,
 * the campus's own domain kinds (`emailDomainTypes`; Cambridge: legacy CUSU,
 * Cambridge SU, SRCF), its list host (`memberEmail.excluded`: `lists_cam`),
 * a subdomain of a member domain (`college_domain`), webmail, else a role
 * address on the society's own domain.
 */
export function classifyEmail(
  email: string,
  profile: CampusProfile = deploymentProfile(),
): EmailType {
  const address = email.trim().toLowerCase()
  const at = address.lastIndexOf("@")
  const local = address.slice(0, at)
  const domain = address.slice(at + 1)
  const member = classifyMemberEmail(local, domain, profile)
  if (member) return member
  // An alumni address is one person's unless it is named after a post.
  if (isAlumniDomain(domain, profile) && !isPostAddress(local)) return "personal_crsid"
  const kind = profile.emailDomainTypes.find((rule) => rule.matches(domain))
  if (kind) return kind.type
  const { domains, excluded } = profile.facts.memberEmail
  if (excluded.includes(domain)) return "lists_cam"
  if (domains.some((base) => domain.endsWith(`.${base}`))) return "college_domain"
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
