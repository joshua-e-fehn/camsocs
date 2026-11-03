import { addDays, londonIsoDate } from "./calendar"
import {
  TALK_KIND_LABELS,
  TALK_KINDS,
  TALK_SCHOOL_LABELS,
  TALK_SCHOOLS,
  type TalkKind,
  type TalkSchool,
} from "./vocab"

/**
 * The talks calendar feed (`/talks.ics`, talks-redesign-spec §4) as RFC 5545
 * text: pure functions, so the route only fetches and the format is unit-tested.
 *
 * The rules the serializer keeps (RFC 5545 §3.1, §3.3.11):
 *
 *  - lines end in CRLF;
 *  - a content line longer than 75 octets is folded: CRLF then one space, the
 *    octets counted in UTF-8 and never splitting a character;
 *  - TEXT values escape backslash, semicolon and comma, and a line break
 *    becomes `\n`;
 *  - times are UTC (`DTSTART:20261031T150000Z`); an all-day talk has London
 *    `VALUE=DATE` dates with an exclusive `DTEND`.
 */

/** What the feed shows of a talk: the public list item's fields it uses. */
export type IcsTalk = {
  key: string
  title: string
  speakers: readonly { name: string; affiliation?: string }[]
  series: string | null
  departments?: readonly { shortName: string; slug?: string }[]
  startsAt: number
  endsAt: number | null
  allDay: boolean
  venue: string | null
  online: boolean
  cancelled: boolean
  url: string
}

/** The domain of every UID (`<key>@camsocs.uk`): stable across hosts. */
export const ICS_UID_DOMAIN = "camsocs.uk"
const CRLF = "\r\n"
const MAX_OCTETS = 75

/** Escapes a TEXT value (RFC 5545 §3.3.11). */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n")
}

const encoder = new TextEncoder()

/** Folds one content line at 75 octets (RFC 5545 §3.1). A continuation line
 * starts with a space, which counts towards its 75. */
export function foldLine(line: string): string {
  if (encoder.encode(line).length <= MAX_OCTETS) return line
  const parts: string[] = []
  let current = ""
  let octets = 0
  let limit = MAX_OCTETS
  for (const char of line) {
    const size = encoder.encode(char).length
    if (octets + size > limit) {
      parts.push(current)
      current = ""
      octets = 0
      // The leading space of the continuation takes one octet.
      limit = MAX_OCTETS - 1
    }
    current += char
    octets += size
  }
  parts.push(current)
  return parts.join(`${CRLF} `)
}

/** `YYYYMMDDTHHMMSSZ`. */
export function utcStamp(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "")
}

/** `YYYYMMDD` from `YYYY-MM-DD`. */
function compactDate(iso: string): string {
  return iso.replace(/-/g, "")
}

function speakerText(speaker: { name: string; affiliation?: string }): string {
  return speaker.affiliation ? `${speaker.name} (${speaker.affiliation})` : speaker.name
}

/** The DESCRIPTION: speakers, series, departments, the talk's own page. */
export function talkDescription(talk: IcsTalk): string {
  const lines: string[] = []
  if (talk.cancelled) lines.push("This talk is cancelled.")
  if (talk.speakers.length > 0) {
    const label = talk.speakers.length === 1 ? "Speaker" : "Speakers"
    lines.push(`${label}: ${talk.speakers.map(speakerText).join("; ")}`)
  }
  if (talk.series) lines.push(`Series: ${talk.series}`)
  const departments = talk.departments?.map((department) => department.shortName) ?? []
  if (departments.length > 0) lines.push(`Department: ${departments.join(", ")}`)
  if (talk.online) lines.push("Online or hybrid: see the talk's page for the link.")
  lines.push(`Source: ${talk.url}`)
  return lines.join("\n")
}

/** One VEVENT, whatever it is: a talk (the feed, `/talks/<key>/ics`) or a
 * society event (`/events/<key>/ics`). */
export type IcsEntry = {
  /** Unique across hosts: `<key>@camsocs.uk`. */
  uid: string
  startsAt: number
  /** Epoch ms; absent or not after the start: no DTEND. */
  endsAt?: number | null
  allDay: boolean
  title: string
  location?: string | null
  url: string
  description: string
  cancelled: boolean
}

function entryLines(entry: IcsEntry, stamp: string): string[] {
  const lines = ["BEGIN:VEVENT", `UID:${entry.uid}`, `DTSTAMP:${stamp}`]
  const end = entry.endsAt ?? null
  if (entry.allDay) {
    const first = londonIsoDate(entry.startsAt)
    const lastIncluded = end !== null && end > entry.startsAt ? londonIsoDate(end - 1) : first
    const last = lastIncluded < first ? first : lastIncluded
    lines.push(`DTSTART;VALUE=DATE:${compactDate(first)}`)
    lines.push(`DTEND;VALUE=DATE:${compactDate(addDays(last, 1))}`)
  } else {
    lines.push(`DTSTART:${utcStamp(entry.startsAt)}`)
    if (end !== null && end > entry.startsAt) lines.push(`DTEND:${utcStamp(end)}`)
  }
  const title = entry.cancelled ? `Cancelled: ${entry.title}` : entry.title
  lines.push(`SUMMARY:${escapeText(title)}`)
  if (entry.location) lines.push(`LOCATION:${escapeText(entry.location)}`)
  lines.push(`URL:${entry.url}`)
  lines.push(`DESCRIPTION:${escapeText(entry.description)}`)
  lines.push(`STATUS:${entry.cancelled ? "CANCELLED" : "CONFIRMED"}`)
  lines.push("TRANSP:OPAQUE", "END:VEVENT")
  return lines
}

function eventLines(talk: IcsTalk, stamp: string): string[] {
  return entryLines(
    {
      uid: `${talk.key}@${ICS_UID_DOMAIN}`,
      startsAt: talk.startsAt,
      endsAt: talk.endsAt,
      allDay: talk.allDay,
      title: talk.title,
      location: talk.venue ?? (talk.online ? "Online" : null),
      url: talk.url,
      description: talkDescription(talk),
      cancelled: talk.cancelled,
    },
    stamp,
  )
}

/** A whole calendar of `talks`, CRLF line ends, every line folded. A feed
 * (the default) names itself and asks to be refreshed; a one-off file
 * (`feed: false`) carries neither, so a calendar app adds its event to a
 * calendar the viewer picks instead of offering a new named calendar. */
export function talksCalendar(
  talks: readonly IcsTalk[],
  options: { name: string; now: number; feed?: boolean },
): string {
  const stamp = utcStamp(options.now)
  const feed = options.feed ?? true
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//camsocs//Talks//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    ...(feed
      ? [
          `X-WR-CALNAME:${escapeText(options.name)}`,
          "X-WR-TIMEZONE:Europe/London",
          "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
          "X-PUBLISHED-TTL:PT6H",
        ]
      : []),
    ...talks.flatMap((talk) => eventLines(talk, stamp)),
    "END:VCALENDAR",
  ]
  return lines.map(foldLine).join(CRLF) + CRLF
}

// --- the feed's query parameters --------------------------------------------------------

/** The `/talks` URL state the feed accepts. */
export type TalkFeedFilters = {
  school?: TalkSchool
  /** A department slug (or `other-series`). */
  department?: string
  kind?: TalkKind
  /** true: online or hybrid talks only; false: in person only. */
  online?: boolean
  q?: string
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Reads `school`, `dept`, `kind`, `online` (`yes` / `no`) and `q`; an unknown value is an error
 * rather than silently a wider feed. Empty values count as absent. */
export function parseTalkFeedParams(
  params: URLSearchParams,
): { ok: true; filters: TalkFeedFilters } | { ok: false; error: string } {
  const filters: TalkFeedFilters = {}
  const school = params.get("school") || undefined
  if (school !== undefined) {
    if (!(TALK_SCHOOLS as readonly string[]).includes(school)) {
      return { ok: false, error: `Unknown school: ${school}` }
    }
    filters.school = school as TalkSchool
  }
  const department = params.get("dept") || undefined
  if (department !== undefined) {
    if (!SLUG.test(department) || department.length > 120) {
      return { ok: false, error: "dept must be a department slug" }
    }
    filters.department = department
  }
  const kind = params.get("kind") || undefined
  if (kind !== undefined) {
    if (!(TALK_KINDS as readonly string[]).includes(kind)) {
      return { ok: false, error: `Unknown kind: ${kind}` }
    }
    filters.kind = kind as TalkKind
  }
  const online = params.get("online") || undefined
  if (online !== undefined) {
    if (online !== "yes" && online !== "no") return { ok: false, error: "online must be yes or no" }
    filters.online = online === "yes"
  }
  const q = params.get("q")?.trim()
  if (q) filters.q = q.slice(0, 200)
  return { ok: true, filters }
}

/** The calendar's name in the subscriber's app, from the filters. */
export function talkFeedName(filters: TalkFeedFilters, departmentName?: string): string {
  const parts = ["camsocs talks"]
  if (departmentName) parts.push(departmentName)
  else if (filters.school) parts.push(TALK_SCHOOL_LABELS[filters.school])
  if (filters.kind) {
    parts.push(filters.kind === "other" ? "Other talks" : `${TALK_KIND_LABELS[filters.kind]}s`)
  }
  if (filters.online !== undefined) parts.push(filters.online ? "Online" : "In person")
  if (filters.q) parts.push(`“${filters.q}”`)
  return parts.join(" · ")
}

// --- one talk ------------------------------------------------------------------------------

/** One talk as a downloadable `.ics` (`/talks/<key>/ics`, "Add to calendar"
 * for Apple Calendar and desktop Outlook): the same VEVENT the feed carries
 * (UID `<key>@camsocs.uk`), without the feed's name and refresh hints, and
 * a file name from the title. */
export function talkIcsFile(talk: IcsTalk, now: number): { body: string; filename: string } {
  return {
    body: talksCalendar([talk], { name: talk.title, now, feed: false }),
    filename: `${fileSlug(talk.title, "talk")}.ics`,
  }
}

// --- one event --------------------------------------------------------------------------------

/** What an event's `.ics` needs (the public event, `events.get`). */
export type IcsEvent = {
  key: string
  title: string
  startsAt: number
  endsAt?: number
  allDay: boolean
  venueText?: string
  cancelled: boolean
  hosting: "hosts" | "takes_part" | string
  organisers: readonly { name: string; role: string }[]
  /** A listing from the University's public events programme (ENG-24),
   * linked to no student group here. */
  fromUniversity?: boolean
  /** The listing it was read from: for a University listing, its page there. */
  sourceUrl?: string
}

/** Who lists one of the University's own events (ENG-24), for a calendar
 * entry's description: the programme and the event's page in it. */
export function universityListingLine(sourceUrl: string | undefined): string {
  const programme = "Listed in the University of Cambridge’s public events programme"
  return sourceUrl ? `${programme}: ${sourceUrl}` : `${programme}.`
}

/** A file name from a title: lower-case words joined by hyphens, ≤ 60 chars. */
function fileSlug(title: string, fallback: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "-")
    .slice(0, 60)
    .replace(/-+$/, "")
  return slug || fallback
}

/** An event's VEVENT: UID `<key>@camsocs.uk`, the page here as its URL, who
 * runs it — or who takes part (D6), or for one of the University's own
 * listings the programme and its page there (ENG-24) — in the description. */
function eventEntry(event: IcsEvent, pageUrl: string): IcsEntry {
  const lines: string[] = []
  if (event.cancelled) lines.push("This event is cancelled.")
  const names = event.organisers.filter((o) => o.role !== "sponsor").map((o) => o.name)
  if (event.fromUniversity) {
    lines.push(universityListingLine(event.sourceUrl))
  } else if (names.length > 0) {
    lines.push(
      event.hosting === "takes_part"
        ? `Taking part: ${names.join(", ")}`
        : `Organised by ${names.join(", ")}`,
    )
  }
  lines.push(`Details: ${pageUrl}`)
  return {
    uid: `${event.key}@${ICS_UID_DOMAIN}`,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    allDay: event.allDay,
    title: event.title,
    location: event.venueText,
    url: pageUrl,
    description: lines.join("\n"),
    cancelled: event.cancelled,
  }
}

/**
 * One event as a downloadable `.ics` (`/events/<key>/ics`, "Add to
 * calendar" for Apple Calendar and desktop Outlook), with no feed name, so
 * the calendar app asks where to put it.
 */
export function eventIcsFile(
  event: IcsEvent,
  pageUrl: string,
  now: number,
): { body: string; filename: string } {
  const body = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//camsocs//Events//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    ...entryLines(eventEntry(event, pageUrl), utcStamp(now)),
    "END:VCALENDAR",
  ]
  return {
    body: body.map(foldLine).join(CRLF) + CRLF,
    filename: `${fileSlug(event.title, "event")}.ics`,
  }
}

/**
 * A feed of events (`/events.ics`: societies' and the University's own
 * listings, or one society's; SEO audit "calendar-feeds-discovery"): named,
 * refreshed every six hours like the talks feed, each event's page here as
 * its URL (`pageUrl`).
 */
export function eventsCalendar(
  events: readonly IcsEvent[],
  options: { name: string; now: number; pageUrl: (key: string) => string },
): string {
  const stamp = utcStamp(options.now)
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//camsocs//Events//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(options.name)}`,
    "X-WR-TIMEZONE:Europe/London",
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
    "X-PUBLISHED-TTL:PT6H",
    ...events.flatMap((event) => entryLines(eventEntry(event, options.pageUrl(event.key)), stamp)),
    "END:VCALENDAR",
  ]
  return lines.map(foldLine).join(CRLF) + CRLF
}
