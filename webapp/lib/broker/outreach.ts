/**
 * The phase-2 outreach export (PLAN §2.4): one row per listed organisation
 * with its best role address, what is still missing, and a personalised
 * notice that doubles as the UK GDPR Art 14 notice (who we are, what we hold,
 * where it came from, the right to object, links to /request and /privacy).
 *
 * Export only. Nothing here sends anything: Joshua sends it himself (J7, by
 * about 13 Nov 2026), from his own address, so "reply to this email" is a
 * real contact route and no address is invented here.
 *
 * Pure (no server imports): the dashboard builds the CSV in the browser from
 * the rows `api.broker.orgs.page` returns, and `outreach.test.ts` pins it.
 */

/** What the export needs from a broker organisation row (structural). */
export type OutreachRow = {
  key: string
  slug: string
  name: string
  isCounterpart: boolean
  hidden: boolean
  suppressed: boolean
  /** The best published, non-personal address; absent when there is none. */
  bestAddress?: { email: string; role: string }
  missingFields: readonly string[]
  /** Fields we hold a value for. */
  heldFields: readonly string[]
  /** Hosts of the public pages those values came from. */
  sourceHosts: readonly string[]
}

/** Plain-English names for the fields a society is asked about. */
const FIELD_LABELS: Record<string, string> = {
  name: "name",
  aliases: "other names",
  shortName: "short name",
  orgType: "type of group",
  level: "level (university / college)",
  collegeKeys: "college",
  categories: "categories",
  activityTypes: "activities",
  audiences: "who can join",
  languages: "languages",
  tags: "tags",
  logo: "logo",
  shortDescription: "one-line description",
  description: "description",
  howToJoin: "how to join",
  joinUrl: "join link",
  membership: "membership fees",
  beginnerFriendly: "beginner-friendliness",
  trials: "trials or auditions",
  timeCommitment: "time commitment",
  termcardUrl: "termcard",
  accessibilityNote: "accessibility",
  "sport.sport": "sport",
  "sport.blueStatus": "Blue status",
  "sport.varsity": "Varsity",
  "sport.bucs": "BUCS",
  "sport.collegeCompetition": "college competition",
  "sport.genderCategories": "gender categories",
  "sport.kitCostNote": "kit costs",
  "sport.venues": "venues",
  website: "website",
  email: "contact email",
  roleEmails: "committee role addresses",
  contactFormUrl: "contact form",
  mailingList: "mailing-list sign-up",
  socials: "social media links",
  chatChannels: "chat channels",
  lastActiveAt: "latest activity",
  "registrations.su": "SU registration",
  "registrations.proctors": "Proctors' registration",
  "registrations.sportsService": "Sports Service registration",
  "registrations.camdram": "Camdram listing",
  "registrations.cucbc": "CUCBC membership",
}

/** A field's plain-English name; unknown fields fall back to spaced words. */
export function fieldLabel(field: string): string {
  return (
    FIELD_LABELS[field] ??
    field
      .split(".")
      .at(-1)!
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
  )
}

function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join("")
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`
}

/** Whether a row belongs in the outreach at all. */
export function isOutreachCandidate(row: OutreachRow): boolean {
  return !row.isCounterpart && !row.hidden && !row.suppressed
}

/**
 * The personalised notice. `siteUrl` is the public origin, e.g.
 * `https://camsocs.vercel.app` (no trailing slash needed).
 */
export function outreachNotice(row: OutreachRow, siteUrl: string): string {
  const site = siteUrl.replace(/\/+$/, "")
  const held = row.heldFields.map(fieldLabel)
  const missing = row.missingFields.map(fieldLabel)
  const sources = row.sourceHosts.length > 0 ? list([...row.sourceHosts]) : "public web pages"
  const paragraphs = [
    `Hello ${row.name},`,
    "I run camsocs, a free, non-commercial directory of Cambridge student societies and clubs. It is a personal project by Joshua Fehn and is not affiliated with the University of Cambridge or Cambridge SU.",
    held.length > 0
      ? `Your listing currently shows your ${list(held)}. We collected this from public pages: ${sources}. Every fact on the listing shows where it came from and when.`
      : `Your listing currently shows only your name, collected from public pages: ${sources}.`,
    missing.length > 0
      ? `We could not find your ${list(missing)}. If you would like the listing to be complete, you can send these, or any correction, at ${site}/request.`
      : `If anything on it is wrong, you can correct it at ${site}/request.`,
    "We hold this to help students find societies and to connect societies with each other (legitimate interests). The public listing shows role addresses only, never personal ones, and names no committee members. Privately, to suggest introductions between societies, we also keep committee roles as your own pages publish them; these are never shown and expire at each handover.",
    `You can object to this, or ask us to remove the listing, at ${site}/request or by replying to this email; we will act on it. The privacy notice at ${site}/privacy explains what we hold, how long we keep it and your rights, including complaining to the ICO.`,
    "This is a one-off message; we will not email you again unless you reply.",
    "Joshua Fehn, camsocs",
  ]
  return paragraphs.join("\n\n")
}

/** One CSV field, quoted when it holds a comma, quote or line break (RFC 4180).
 * A leading `=`, `+`, `-` or `@` is prefixed with `'` so a spreadsheet never
 * runs a society's text as a formula. */
export function csvField(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export const OUTREACH_COLUMNS = [
  "org_name",
  "org_key",
  "role",
  "email",
  "missing_count",
  "missing_fields",
  "held_fields",
  "sources",
  "notice",
] as const

/**
 * The CSV (CRLF line ends, a header row), one line per candidate with an
 * address, sorted by name. Organisations without a usable address, hidden or
 * suppressed ones, and counterparts are left out — see `isOutreachCandidate`.
 */
export function outreachCsv(rows: readonly OutreachRow[], siteUrl: string): string {
  const lines = [OUTREACH_COLUMNS.join(",")]
  const candidates = rows
    .filter((row) => isOutreachCandidate(row) && row.bestAddress)
    .sort((a, b) => a.name.localeCompare(b.name, "en"))
  for (const row of candidates) {
    const fields = [
      row.name,
      row.key,
      row.bestAddress?.role ?? "",
      row.bestAddress?.email ?? "",
      String(row.missingFields.length),
      row.missingFields.join("; "),
      row.heldFields.join("; "),
      row.sourceHosts.join("; "),
      outreachNotice(row, siteUrl),
    ]
    lines.push(fields.map(csvField).join(","))
  }
  return `${lines.join("\r\n")}\r\n`
}
