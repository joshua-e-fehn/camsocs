/**
 * The phase-2 outreach export (PLAN §2.4): one row per listed organisation
 * with its best role address, what is still missing, and a personalised
 * notice that doubles as the UK GDPR Art 14 notice (who we are, what we hold,
 * where it came from, the right to object, links to /request and /privacy).
 *
 * Export only. Nothing here sends anything: Joshua sends it himself (J7, by
 * about 13 Nov 2026) from the published contact address, so "reply to this
 * email" is a real contact route and no address is invented here. The
 * address is the row's `bestAddress` (`convex/lib/brokerRows.ts`
 * `bestRoleAddress`): a role address, never a personal, mailing-list or
 * webmail one.
 *
 * The send log closes the loop (Art 5(2) evidence of who was told, and
 * when): the export has empty `sent_on` and `bounced` columns; once the mail
 * merge has gone out they are filled in and the file is imported back
 * (`parseSendLog` here, then `api.broker.interactions.recordSendLog`), one
 * email interaction per organisation and address sent to. The procedure is
 * in docs/webapp.md "Sending the Art 14 notice".
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
  /** The outreach address and its `EMAIL_TYPES` kind; absent when the listing
   * publishes no role address the outreach may use. */
  bestAddress?: { email: string; role: string; kind: string }
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
 * `https://camsocs.uk` (no trailing slash needed).
 */
export function outreachNotice(row: OutreachRow, siteUrl: string): string {
  const site = siteUrl.replace(/\/+$/, "")
  const held = row.heldFields.map(fieldLabel)
  const missing = row.missingFields.map(fieldLabel)
  const sources = row.sourceHosts.length > 0 ? list([...row.sourceHosts]) : "public web pages"
  const paragraphs = [
    `Hello ${row.name},`,
    "I run camsocs, a free-to-use directory of Cambridge student societies and clubs. It is a personal project by Joshua Fehn and is not affiliated with the University of Cambridge or Cambridge SU.",
    held.length > 0
      ? `Your listing currently shows your ${list(held)}. We collected this from public pages: ${sources}. Every fact on the listing shows where it came from and when.`
      : `Your listing currently shows only your name, collected from public pages: ${sources}.`,
    missing.length > 0
      ? `We could not find your ${list(missing)}. If you would like the listing to be complete, you can send these, or any correction, at ${site}/request.`
      : `If anything on it is wrong, you can correct it at ${site}/request.`,
    "We hold this for two purposes (legitimate interests): a public directory that helps students find societies, and suggesting introductions between societies and to possible partners such as sponsors, speakers and venues. The public listing names no committee members; it shows the contact addresses your society publishes, but never a personal CRSid or alumni address.",
    "Privately, to suggest those introductions, we also keep the names and roles of committee members as your society's own public pages give them. These are never shown on the site, and we do not hand them or your addresses to sponsors or other organisations: an introduction is made by passing a message on. They are kept until the end of the academic year (30 June) and deleted within 30 days after it, unless the person agrees to more.",
    `You can object to this, or ask us to remove the listing or any committee member's details, at ${site}/request or by replying to this email; we will act on it. The privacy notice at ${site}/privacy explains what we hold, how long we keep it and your rights, including the right to complain to the Information Commissioner's Office (ICO).`,
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
  "email_kind",
  "missing_count",
  "missing_fields",
  "held_fields",
  "sources",
  "notice",
  "sent_on",
  "bounced",
] as const

/**
 * The CSV (CRLF line ends, a header row), one line per candidate with an
 * address, sorted by name. Organisations without a usable address, hidden or
 * suppressed ones, and counterparts are left out — see `isOutreachCandidate`.
 * `sent_on` and `bounced` are left empty for the send log (`parseSendLog`).
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
      row.bestAddress?.kind ?? "",
      String(row.missingFields.length),
      row.missingFields.join("; "),
      row.heldFields.join("; "),
      row.sourceHosts.join("; "),
      outreachNotice(row, siteUrl),
      "",
      "",
    ]
    lines.push(fields.map(csvField).join(","))
  }
  return `${lines.join("\r\n")}\r\n`
}

/** Parses RFC 4180 CSV: quoted fields with `""` escapes, CRLF or LF rows, a
 * leading byte-order mark. Blank lines are dropped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let field = ""
  let fields: string[] = []
  let quoted = false
  const endRow = () => {
    fields.push(field)
    if (fields.length > 1 || fields[0] !== "") rows.push(fields)
    fields = []
    field = ""
  }
  const source = text.replace(/^\uFEFF/, "")
  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        field += '"'
        i++
      } else if (char === '"') quoted = false
      else field += char
    } else if (char === '"') quoted = true
    else if (char === ",") {
      fields.push(field)
      field = ""
    } else if (char === "\n") endRow()
    else if (char === "\r" && source[i + 1] === "\n") {
      endRow()
      i++
    } else field += char
  }
  if (field !== "" || fields.length > 0) endRow()
  return rows
}

/** Rows per `api.broker.interactions.recordSendLog` call; the dashboard
 * sends a longer log in chunks. */
export const SEND_LOG_BATCH = 200

/** One sent notice, as the send log records it. */
export type SendLogEntry = {
  orgKey: string
  email: string
  /** ISO `YYYY-MM-DD`. */
  sentOn: string
  bounced: boolean
}

/** The columns a send log must have; `bounced` is optional. Extra columns
 * (the rest of the export) are ignored, so the export itself can go back. */
export const SEND_LOG_COLUMNS = ["org_key", "email", "sent_on", "bounced"] as const

const BOUNCED_YES = new Set(["yes", "y", "true", "1", "x", "bounced"])
const BOUNCED_NO = new Set(["", "no", "n", "false", "0"])

/** `2026-11-05`, or the `5/11/2026` a UK spreadsheet turns it into, as ISO. */
export function sendLogDate(value: string): string | undefined {
  const text = value.trim()
  const uk = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text)
  const iso = uk ? `${uk[3]}-${uk[2].padStart(2, "0")}-${uk[1].padStart(2, "0")}` : text
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return undefined
  const date = new Date(`${iso}T12:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(iso) ? iso : undefined
}

/**
 * Reads a filled-in send log: one entry per row with a `sent_on` date (rows
 * without one were not sent and are counted as `notSent`), de-duplicated by
 * organisation, address and date. `errors` name the row (1 = the header);
 * any error means nothing should be recorded until the file is fixed.
 */
export function parseSendLog(text: string): {
  entries: SendLogEntry[]
  notSent: number
  errors: string[]
} {
  const [header, ...rows] = parseCsv(text)
  const columns = (header ?? []).map((name) => name.trim().toLowerCase())
  const at = (name: string) => columns.indexOf(name)
  const missing = SEND_LOG_COLUMNS.filter((name) => name !== "bounced" && at(name) < 0)
  if (missing.length > 0) {
    return {
      entries: [],
      notSent: 0,
      errors: [`The file needs the columns ${list(missing.map((name) => `"${name}"`))}`],
    }
  }
  const entries = new Map<string, SendLogEntry>()
  const errors: string[] = []
  let notSent = 0
  rows.forEach((cells, index) => {
    const line = index + 2
    const before = errors.length
    const cell = (name: string) => (at(name) < 0 ? "" : (cells[at(name)] ?? "").trim())
    if (cell("sent_on") === "") {
      notSent++
      return
    }
    const sentOn = sendLogDate(cell("sent_on"))
    const orgKey = cell("org_key")
    const email = cell("email").toLowerCase()
    const bounced = cell("bounced").toLowerCase()
    if (!sentOn) errors.push(`Row ${line}: "${cell("sent_on")}" is not a date (YYYY-MM-DD)`)
    if (!orgKey) errors.push(`Row ${line}: no org_key`)
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) errors.push(`Row ${line}: "${email}" is not an address`)
    if (!BOUNCED_YES.has(bounced) && !BOUNCED_NO.has(bounced)) {
      errors.push(`Row ${line}: bounced should be "yes" or empty, not "${cell("bounced")}"`)
    }
    if (!sentOn || errors.length > before) return
    const entry = { orgKey, email, sentOn, bounced: BOUNCED_YES.has(bounced) }
    const key = `${orgKey}\n${email}\n${sentOn}`
    entries.set(key, { ...entry, bounced: entry.bounced || (entries.get(key)?.bounced ?? false) })
  })
  return { entries: [...entries.values()], notSent, errors }
}
