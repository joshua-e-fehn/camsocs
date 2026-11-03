import {
  addDays,
  DAY_MS,
  formatDayShort,
  formatEventWhen,
  londonIsoDate,
  londonMidnight,
  londonTime,
  spanEndOf,
} from "./calendar"
import type { CategoryTone } from "./category-tone"
import { universityListingLine, utcStamp } from "./ics"
import { summary } from "./rich-text"
import { MAX_TITLE_LENGTH, TITLE_SUFFIX } from "./site"
import { breadcrumbList, eventId, organizationId, pageId, WEBSITE_ID } from "./structured-data"
import { physicalVenue } from "./talks"
import { isTalksCamUrl } from "./talks-boundary"
import { TERM_SHORT, type TermDatesRow, termWeekOf } from "./term-week"
import { EVENT_TYPE_LABELS, type EventType } from "./vocab"
import { type DayCount, termWeekTag } from "./week-strip"

/**
 * The pure side of the /events agenda (talks-redesign-spec §6 "/events") and
 * the event pages: matching the search box, the time column of a row, the
 * week strip's counts, the type colours, Add to calendar links and the
 * page's JSON-LD. Dates are London ISO days (`YYYY-MM-DD`).
 */

type Organiser = { name: string; role: string }

type Searchable = {
  title: string
  organisers: readonly Organiser[]
  venueText?: string
  /** The University's own listing (ENG-24): "University" finds it. */
  fromUniversity?: boolean
}

/** Lower case without accents, so "Cafe" finds "Café". */
function fold(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
}

/**
 * Whether every word of `q` appears in the event's title, an organiser's
 * name or its venue. The agenda matches in the browser over the days it has
 * loaded (a week or a few), so a search is instant and reaches beyond the
 * title without a server round trip.
 */
export function matchesEventQuery(event: Searchable, q: string | undefined): boolean {
  const words = fold(q ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (words.length === 0) return true
  const haystack = fold(
    [
      event.title,
      ...event.organisers.map((organiser) => organiser.name),
      event.fromUniversity ? UNIVERSITY_NAME : "",
      event.venueText ?? "",
    ].join("\n"),
  )
  return words.every((word) => haystack.includes(word))
}

// --- emoji in titles -----------------------------------------------------------------------

/** One pictograph with its modifiers and joins: 🚩, 👩🏽‍💻, ❤️, a flag 🇬🇧. Digits
 * and `#` are emoji too in Unicode, but never pictographs, so they stay. */
const EMOJI =
  /(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:️|⃣|\p{Emoji_Modifier}|‍(?:\p{Extended_Pictographic}|\p{Regional_Indicator})|\p{Regional_Indicator})*/gu

export type TitlePart = { text: string; emoji: boolean }

/**
 * A title in runs of text and emoji, so the page can hide the emoji from
 * screen readers ("🚩 HAM-DEFCON" was read as "triangular flag on post
 * HAM-DEFCON") while they stay on screen.
 */
export function splitEmoji(title: string): TitlePart[] {
  const parts: TitlePart[] = []
  let last = 0
  for (const match of title.matchAll(EMOJI)) {
    const index = match.index ?? 0
    if (index > last) parts.push({ text: title.slice(last, index), emoji: false })
    parts.push({ text: match[0], emoji: true })
    last = index + match[0].length
  }
  if (last < title.length) parts.push({ text: title.slice(last), emoji: false })
  return parts
}

/** A title as it should be spoken or put in a document title: no emoji,
 * single spaces. The title itself when it is nothing but emoji. */
export function spokenTitle(title: string): string {
  const text = splitEmoji(title)
    .filter((part) => !part.emoji)
    .map((part) => part.text)
    .join("")
    .replace(/\s+/g, " ")
    .trim()
  return text || title.trim()
}

// --- the agenda ---------------------------------------------------------------------------

type Timed = { startsAt: number; endsAt?: number; allDay: boolean }

/**
 * The time column of an agenda row: the start over the end ("19:30" /
 * "21:30"), "All day", or for an event over several days its last day
 * ("until Sat 7 Nov").
 */
export function eventTimes(event: Timed): { start: string; end?: string } {
  const span = spanEndOf(event.startsAt, event.endsAt)
  const until = span !== undefined ? `until ${formatDayShort(londonIsoDate(span - 1))}` : undefined
  if (event.allDay) return { start: "All day", end: until }
  const start = londonTime(event.startsAt)
  if (until) return { start, end: until }
  if (event.endsAt === undefined || event.endsAt <= event.startsAt) return { start }
  return { start, end: londonTime(event.endsAt) }
}

/** Two lists of events as one, by start time; a key in both appears once. */
export function mergeByStart<T extends { key: string; startsAt: number }>(
  first: readonly T[],
  second: readonly T[],
): T[] {
  if (second.length === 0) return [...first]
  const seen = new Set(first.map((event) => event.key))
  return [...first, ...second.filter((event) => !seen.has(event.key))].sort(
    (a, b) => a.startsAt - b.startsAt,
  )
}

/** The week strip's days with how many events each lists (`byDay`, as
 * lib/event-runs.ts `eventsByDay` groups them); 0 for a day with none. */
export function dayCounts(
  days: readonly string[],
  byDay: ReadonlyMap<string, readonly unknown[]>,
): DayCount[] {
  return days.map((date) => ({ date, count: byDay.get(date)?.length ?? 0 }))
}

/** `days` in pages of seven, for the week strip: page `n` starts on day 7n. */
export function stripPages(days: readonly string[]): string[][] {
  const pages: string[][] = []
  for (let index = 0; index < days.length; index += 7) pages.push(days.slice(index, index + 7))
  return pages
}

/** The first day on or after `day` that has events (the agenda jumps there
 * when a quiet day is picked on the strip), or undefined. */
export function nextDayWithEvents(day: string, days: readonly string[]): string | undefined {
  return [...days].sort().find((candidate) => candidate >= day)
}

/** The compact term week of a day for the month grid's gutter: "M4", "L1",
 * "E8" (Michaelmas, Lent, Easter), or undefined in the vacation. */
export function termWeekGutter(day: string, terms: readonly TermDatesRow[]): string | undefined {
  for (const term of terms) {
    const week = termWeekOf(day, term)
    if (week !== undefined) return `${TERM_SHORT[term.term][0]}${week}`
  }
  return undefined
}

/** The gutter label of one week row (Monday first): the term week of its
 * Thursday, when term weeks begin. */
export function weekRowGutter(week: readonly string[], terms: readonly TermDatesRow[]) {
  const thursday = week[3] ?? week[0]
  return thursday ? termWeekGutter(thursday, terms) : undefined
}

/**
 * The week strip's label for a run of days that need not start on a Monday
 * (the agenda's pages start today): "Mich · Wk 4–5" when it spans two term
 * weeks, "Mich · Wk 5" within one, "Vacation" outside term.
 */
export function stripRangeLabel(days: readonly string[], terms: readonly TermDatesRow[]): string {
  const first = days[0] ? termWeekTag(days[0], terms) : undefined
  const lastDay = days[days.length - 1]
  const last = lastDay ? termWeekTag(lastDay, terms) : undefined
  if (first && last && first !== last) {
    const [term, week] = first.split(" · Wk ")
    const [lastTerm, lastWeek] = last.split(" · Wk ")
    if (term === lastTerm) return `${term} · Wk ${week}–${lastWeek}`
  }
  return first ?? last ?? "Vacation"
}

// --- colour by type -----------------------------------------------------------------------

/**
 * A colour family per event type (the category tones, lib/category-tone.ts),
 * for the type chip on a row and the month grid's chips: talks in the
 * lecture-hall indigo, the stage in plum, sport in river teal, socials in
 * sage, dinners and fairs in gilt. Always beside the type's name — never
 * colour alone.
 */
export const EVENT_TYPE_TONE: Record<EventType, CategoryTone> = {
  talk: "indigo",
  social: "sage",
  performance: "plum",
  exhibition: "plum",
  competition: "brick",
  match: "teal",
  workshop: "gilt",
  trip: "teal",
  formal: "gilt",
  careers: "neutral",
  meeting: "neutral",
  training: "teal",
  worship: "indigo",
  fair: "gilt",
  other: "neutral",
}

// --- calendar links -----------------------------------------------------------------------

type CalendarEvent = Timed & {
  key: string
  title: string
  cancelled: boolean
  venueText?: string
  organisers: readonly Organiser[]
  hosting: string
  /** A listing from the University's public events programme (ENG-24),
   * linked to no student group here. */
  fromUniversity?: boolean
  sourceUrl?: string
}

/** The University as the organiser of its own listings (ENG-24), in words
 * and in JSON-LD: a factual credit, never our branding. */
export const UNIVERSITY_NAME = "University of Cambridge"
const UNIVERSITY_URL = "https://www.cam.ac.uk"

/** The words a calendar entry carries: who runs it (or takes part; for one
 * of the University's own listings, the programme and its page there), the
 * page here. Nothing from the description: it is long, and it is on the page. */
export function eventCalendarDetails(event: CalendarEvent, pageUrl: string): string {
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
  return lines.join("\n")
}

function compactDate(iso: string): string {
  return iso.replace(/-/g, "")
}

/** A timed event's end for a calendar: its own, or an hour after the start. */
function endOf(event: Timed): number {
  return event.endsAt !== undefined && event.endsAt > event.startsAt
    ? event.endsAt
    : event.startsAt + 60 * 60 * 1000
}

/** The last London day of an all-day event. */
function lastAllDay(event: Timed): string {
  const first = londonIsoDate(event.startsAt)
  if (event.endsAt === undefined || event.endsAt <= event.startsAt) return first
  const last = londonIsoDate(event.endsAt - 1)
  return last < first ? first : last
}

/** Google Calendar's "add event" template link. */
export function eventGoogleCalendarUrl(event: CalendarEvent, pageUrl: string): string {
  const dates = event.allDay
    ? `${compactDate(londonIsoDate(event.startsAt))}/${compactDate(addDays(lastAllDay(event), 1))}`
    : `${utcStamp(event.startsAt)}/${utcStamp(endOf(event))}`
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: event.cancelled ? `Cancelled: ${event.title}` : event.title,
    dates,
    details: eventCalendarDetails(event, pageUrl),
    ctz: "Europe/London",
  })
  if (event.venueText) params.set("location", event.venueText)
  return `https://calendar.google.com/calendar/render?${params.toString()}`
}

/** Outlook on the web's compose link (personal accounts; a University
 * Microsoft 365 account opens it at outlook.office.com). */
export function eventOutlookCalendarUrl(
  event: CalendarEvent,
  pageUrl: string,
  host: "outlook.live.com" | "outlook.office.com" = "outlook.live.com",
): string {
  const params = new URLSearchParams({
    path: "/calendar/action/compose",
    rru: "addevent",
    subject: event.cancelled ? `Cancelled: ${event.title}` : event.title,
    body: eventCalendarDetails(event, pageUrl),
  })
  if (event.allDay) {
    params.set("startdt", londonIsoDate(event.startsAt))
    params.set("enddt", addDays(lastAllDay(event), 1))
    params.set("allday", "true")
  } else {
    params.set("startdt", new Date(event.startsAt).toISOString())
    params.set("enddt", new Date(endOf(event)).toISOString())
  }
  if (event.venueText) params.set("location", event.venueText)
  return `https://${host}/calendar/0/action/compose?${params.toString()}`
}

// --- the event's page ---------------------------------------------------------------------

/** What the page, its metadata and its JSON-LD read of an event (`EventPublic`
 * has all of it; the tests pass less). */
export type PageEvent = Omit<CalendarEvent, "organisers"> & {
  eventType: EventType
  organisers: readonly (Organiser & { key?: string; slug?: string })[]
  status?: string
  visibility?: string
  source: string
  sourceUrl?: string
  externalUrl?: string
  bookingUrl?: string
  description?: string
  imageUrl?: string
  price?: { free: boolean; minPence?: number; maxPence?: number; text?: string }
  speakers?: readonly { name: string; affiliation?: string }[]
  meta?: Record<string, { status?: string } | undefined>
  /** Convex's talks-boundary verdict (lib/talks-boundary.ts). */
  talksDerived: boolean
}

/** A venue resolved from the event's `venueKey` (`venues.get`). */
export type EventVenue = {
  name: string
  address?: string
  /** A college venue: in Cambridge by definition. */
  collegeKey?: string
  lat?: number
  lng?: number
}

/** Cambridge, generously: the city and its edges (Girton, the West Cambridge
 * site, Addenbrooke's). A venue inside it is a Cambridge venue. */
const CAMBRIDGE_BOUNDS = { south: 52.15, north: 52.26, west: 0.03, east: 0.22 }
const NAMES_CAMBRIDGE = /\bcambridge\b/i

/**
 * Whether an event's place is known to be in Cambridge, so the JSON-LD may
 * say so (review of 2026-11-02: never assert a town no source gave). A keyed
 * venue that is a college's, whose coordinates fall in the city or whose
 * address names it; else a venue text that names Cambridge. An away fixture
 * written as a place ("Iffley Road, Oxford") is not.
 */
export function placeIsInCambridge(venue: EventVenue | undefined, venueText?: string): boolean {
  if (venue) {
    if (venue.collegeKey) return true
    const { lat, lng } = venue
    if (
      lat !== undefined &&
      lng !== undefined &&
      lat >= CAMBRIDGE_BOUNDS.south &&
      lat <= CAMBRIDGE_BOUNDS.north &&
      lng >= CAMBRIDGE_BOUNDS.west &&
      lng <= CAMBRIDGE_BOUNDS.east
    ) {
      return true
    }
    return NAMES_CAMBRIDGE.test(venue.address ?? "") || NAMES_CAMBRIDGE.test(venue.name)
  }
  return NAMES_CAMBRIDGE.test(venueText ?? "")
}

/** The organisers who run it — none for someone else's event it only takes
 * part in (D6), never a sponsor. */
function runners(event: Pick<PageEvent, "organisers" | "hosting">): PageEvent["organisers"] {
  return event.hosting === "takes_part"
    ? []
    : event.organisers.filter((organiser) => organiser.role !== "sponsor")
}

/** When an event is over: its end, else the end of its (London) day — an
 * event with no end time is "on" all its day. */
export function eventEnd(event: Timed): number {
  if (event.endsAt !== undefined && event.endsAt > event.startsAt) return event.endsAt
  return londonMidnight(addDays(londonIsoDate(event.startsAt), 1))
}

/** Owner decision G4: an event's page says it has ended once it has, and is
 * marked noindex this long after (the page stays, and keeps its links, until
 * retention purges it — then its URL is a 404). */
export const ENDED_NOINDEX_MS = 30 * DAY_MS

export function eventHasEnded(event: Timed, now: number): boolean {
  return eventEnd(event) <= now
}

/** Whether search engines should drop the page: ended over 30 days ago (G4). */
export function eventEndedLongAgo(event: Timed, now: number): boolean {
  return now - eventEnd(event) > ENDED_NOINDEX_MS
}

/** A document title, at most this long with the " · CAMsocs" the layout's
 * template adds (owner decision G2's limit, applied to events too). */
export const TITLE_MAX = MAX_TITLE_LENGTH

/** `text` cut at a word to at most `max` characters, ending in "…". */
function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max - 1)
  const space = cut.lastIndexOf(" ")
  const words = space > max * 0.5 ? cut.slice(0, space) : cut
  return `${words.replace(/[\s,;:.–—-]+$/, "")}…`
}

/**
 * The page's document title (SEO audit "event-titles-generic"): the event, who
 * runs it and the day — "The Union Ball – Cambridge Union Society, Fri 6 Nov"
 * — because a bare title ("Open training session", "Hunstanton") repeats
 * across nights and societies. Each night keeps its own page and title (a
 * distinct Event); the day tells them apart. At most `TITLE_MAX` characters:
 * the " · CAMsocs" suffix goes first (`absolute`), then the host, then the
 * title is cut at a word. A host already named in the title is not repeated.
 * For one of the University's own listings the host is the University.
 */
export function eventPageTitle(event: PageEvent): { title: string; absolute: boolean } {
  const name = `${event.cancelled ? "Cancelled: " : ""}${spokenTitle(event.title)}`
  // The University's own listing (ENG-24) has no organisers here: its host is
  // the University, as the description, row and JSON-LD say.
  const host = event.fromUniversity ? UNIVERSITY_NAME : runners(event)[0]?.name
  const day = formatDayShort(londonIsoDate(event.startsAt))
  const withHost =
    host && !name.toLowerCase().includes(host.toLowerCase())
      ? `${name} – ${host}, ${day}`
      : undefined
  const plain = `${name}, ${day}`
  for (const title of [withHost, plain]) {
    if (!title) continue
    if (title.length + TITLE_SUFFIX.length <= TITLE_MAX) return { title, absolute: false }
    if (title.length <= TITLE_MAX) return { title, absolute: true }
  }
  return { title: `${clip(name, TITLE_MAX - day.length - 2)}, ${day}`, absolute: true }
}

/** "Tue 3 Nov 2026, 19:30–22:00": `formatEventWhen` with the year, which a
 * search result shows without the page's context. */
function whenWithYear(event: Timed): string {
  const when = formatEventWhen(event)
  const day = londonIsoDate(event.startsAt)
  const head = formatDayShort(day)
  return when.startsWith(head) ? `${head} ${day.slice(0, 4)}${when.slice(head.length)}` : when
}

/** A meta description's length: what search results show before cutting. */
const DESCRIPTION_MAX = 160

/**
 * The page's meta description: type, who, when (with the year), where — the
 * venue named by its key too — then as much of the event's own description
 * as fits in about 160 characters.
 */
export function eventMetaDescription(event: PageEvent, venueName?: string): string {
  const names = event.organisers.filter((o) => o.role !== "sponsor").map((o) => o.name)
  const who = event.fromUniversity
    ? `listed by the ${UNIVERSITY_NAME}`
    : names.length === 0
      ? undefined
      : event.hosting === "takes_part"
        ? `with ${names.join(", ")} taking part`
        : `by ${names.join(", ")}`
  const where = usableVenueText(event.venueText) ?? venueName
  const lead = `${EVENT_TYPE_LABELS[event.eventType]}${who ? ` ${who}` : ""}`
  const facts = [lead, whenWithYear(event), where].filter(Boolean).join(" · ")
  const room = DESCRIPTION_MAX - facts.length - 2
  const about = event.description && room >= 40 ? summary(event.description, room) : ""
  return about ? `${facts}. ${about}` : facts
}

/** Venue texts that name no place: a fixture's side, a placeholder. */
const NO_PLACE =
  /^\W*(?:(?:home|away)(?:\s+(?:game|match|fixture))?|tb[ac]|to be (?:confirmed|announced)|various|n\/?a)\W*$/i

/** The venue text when it names a place; undefined for "Home Game", "TBC"… */
export function usableVenueText(text: string | undefined): string | undefined {
  const trimmed = text?.trim()
  return trimmed && !NO_PLACE.test(trimmed) ? trimmed : undefined
}

/** Whether the venue text only names a meeting service ("Zoom", "Online"),
 * as talks are read (lib/talks.ts `physicalVenue`). */
export function isOnlineOnly(text: string | undefined): boolean {
  return !!text && physicalVenue(text) === null
}

/** URL path endings that are a file, not a page about one event. */
const FILE_PATH = /\.(?:ics|ical|png|jpe?g|gif|webp|svg|pdf|docx?|pptx?)$/i
/** Calendar feeds by host and path. */
const FEED = [
  /^calendar\.google\.com$/i,
  /^(?:api\.)?lu\.ma$/i,
  /^outlook\.(?:live|office|office365)\.com$/i,
]

/**
 * Whether `url` can be the `sameAs` of one event (SEO audit
 * "event-sameas-misuse"): an http(s) page, not a file (a poster, an `.ics`
 * feed, a PDF term card), not a calendar feed, never talks.cam (G1). A page
 * shared by many events (a fixtures list, a society's "talks" page) cannot be
 * told apart here, so callers pass only URLs that belong to the event: its
 * own page (`externalUrl`) or a per-event listing (Camdram, Luma, the SU).
 */
export function isEventIdentityUrl(url: string | undefined): url is string {
  if (!url) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false
  if (isTalksCamUrl(url)) return false
  if (FILE_PATH.test(parsed.pathname)) return false
  if (FEED.some((host) => host.test(parsed.hostname)) && /ical|\/ics|\.ics/i.test(url)) return false
  return parsed.pathname.replace(/\/+$/, "") !== ""
}

/** Sources whose `sourceUrl` is the event's own listing page, one per event
 * (a show on Camdram, an event on Luma or the SU's what's-on, the
 * University's own listing, ENG-24). Others
 * (a society's calendar feed, website or term card) list many events. */
const PER_EVENT_SOURCES = new Set(["camdram", "luma", "su_whatson", "uni_events_api"])

/** The event's `sameAs`, if one of its URLs is a page about it alone. */
export function eventSameAs(event: PageEvent): string | undefined {
  if (isEventIdentityUrl(event.externalUrl)) return event.externalUrl
  if (PER_EVENT_SOURCES.has(event.source) && isEventIdentityUrl(event.sourceUrl)) {
    return event.sourceUrl
  }
  return undefined
}

/** A title that says its date is not settled ("Formal (DATE TBC)"). */
const TBC_TITLE = /\b(?:date\s+)?(?:tbc|tba)\b|to be (?:confirmed|announced)/i

/** What `eventHasStructuredData` reads: fields an event's page
 * (`EventPublic`) and a list item (`EventListItem`) both carry. */
export type StructuredDataFacts = {
  title: string
  visibility?: string
  status?: string
  meta?: { startsAt?: { status?: string } }
  talksDerived: boolean
}

/**
 * Whether an event's page carries schema.org JSON-LD (SEO audit
 * "event-tbc-marked-scheduled"): only a public, confirmed event with a start
 * time that was read, not inferred, and whose title does not say "TBC" —
 * an Event rich result with a guessed date would mislead. Never a
 * talks.cam-derived event (owner decision G1). Over a list item too, so a
 * profile links by `@id` only the Event nodes that exist
 * (lib/directory-profile.ts `jsonLdEvents`).
 */
export function eventHasStructuredData(event: StructuredDataFacts): boolean {
  return (
    event.visibility === "public" &&
    (event.status ?? "confirmed") === "confirmed" &&
    event.meta?.startsAt?.status !== "inferred" &&
    !TBC_TITLE.test(event.title) &&
    !event.talksDerived
  )
}

/** schema.org `Place` / `VirtualLocation` for an event: the venue its key
 * names (with its address and coordinates) before the source's venue text,
 * and nothing for a text that names no place ("Home Game", "TBC"). The town
 * only when it is known to be Cambridge (`placeIsInCambridge`); an online
 * event's VirtualLocation only where one joins it (its booking link) — our
 * own page is not where anyone attends (review of 2026-11-02). */
function eventLocation(event: PageEvent, venue: EventVenue | undefined) {
  if (!venue && isOnlineOnly(event.venueText)) {
    return event.bookingUrl ? { "@type": "VirtualLocation", url: event.bookingUrl } : undefined
  }
  const name = venue?.name ?? usableVenueText(event.venueText)
  if (!name) return undefined
  const local = placeIsInCambridge(venue, event.venueText)
  const address = {
    ...(venue?.address ? { streetAddress: venue.address } : {}),
    ...(local
      ? { addressLocality: "Cambridge", addressRegion: "Cambridgeshire", addressCountry: "GB" }
      : {}),
  }
  return {
    "@type": "Place",
    name,
    ...(Object.keys(address).length > 0
      ? { address: { "@type": "PostalAddress", ...address } }
      : {}),
    ...(venue?.lat !== undefined && venue.lng !== undefined
      ? { geo: { "@type": "GeoCoordinates", latitude: venue.lat, longitude: venue.lng } }
      : {}),
  }
}

/** schema.org `Offer` from the structured price only (never its free text):
 * free → 0; a range → low and high. */
function eventOffers(event: PageEvent, pageUrl: string) {
  const price = event.price
  if (!price) return undefined
  const offer = {
    "@type": "Offer",
    url: event.bookingUrl ?? pageUrl,
    priceCurrency: "GBP",
  }
  if (price.free) return { ...offer, price: 0 }
  const { minPence: min, maxPence: max } = price
  if (min !== undefined && max !== undefined && max > min) {
    return { ...offer, "@type": "AggregateOffer", lowPrice: min / 100, highPrice: max / 100 }
  }
  const one = min ?? max
  return one === undefined ? undefined : { ...offer, price: one / 100 }
}

/**
 * schema.org `Event` for an event's page, as a node of the site's graph
 * (`@id` from lib/structured-data.ts). Organisers are named — and linked to
 * their profile's Organization — only when they run it, never for an event
 * they only take part in (D6). Speakers are performers only for a talk or
 * workshop (D1 publishes them only there). One of the University's own
 * listings names the University instead (ENG-24); its `sameAs` is the
 * University's page for it. Callers check `eventHasStructuredData` first.
 */
export function eventJsonLd(
  event: PageEvent & { key: string },
  pageUrl: string,
  venue?: EventVenue,
): Record<string, unknown> {
  const day = londonIsoDate(event.startsAt)
  const online = !venue && isOnlineOnly(event.venueText)
  const location = eventLocation(event, venue)
  const offers = eventOffers(event, pageUrl)
  const sameAs = eventSameAs(event)
  const organizers = runners(event)
  const performers =
    (event.eventType === "talk" || event.eventType === "workshop") && event.speakers
      ? event.speakers
      : []
  const description = event.description ? summary(event.description, 300) : ""
  return {
    "@type": "Event",
    "@id": eventId(event.key),
    name: event.title,
    url: pageUrl,
    ...(description ? { description } : {}),
    ...(event.imageUrl ? { image: [event.imageUrl] } : {}),
    ...(sameAs ? { sameAs } : {}),
    startDate: event.allDay ? day : new Date(event.startsAt).toISOString(),
    ...(event.endsAt !== undefined && event.endsAt > event.startsAt
      ? {
          endDate: event.allDay ? lastAllDay(event) : new Date(event.endsAt).toISOString(),
        }
      : {}),
    eventStatus: event.cancelled
      ? "https://schema.org/EventCancelled"
      : "https://schema.org/EventScheduled",
    eventAttendanceMode: online
      ? "https://schema.org/OnlineEventAttendanceMode"
      : "https://schema.org/OfflineEventAttendanceMode",
    ...(location ? { location } : {}),
    ...(offers ? { offers } : {}),
    ...(performers.length > 0
      ? {
          performer: performers.map((speaker) => ({
            "@type": "Person",
            name: speaker.name,
            ...(speaker.affiliation
              ? { affiliation: { "@type": "Organization", name: speaker.affiliation } }
              : {}),
          })),
        }
      : {}),
    ...(event.fromUniversity
      ? { organizer: [{ "@type": "Organization", name: UNIVERSITY_NAME, url: UNIVERSITY_URL }] }
      : organizers.length > 0
        ? {
            // A reference to the society's node on its profile, by `@id`.
            // No `url` here: that node's `url` is the society's own website
            // (lib/directory-profile.ts societyJsonLd), and one `@id` must not
            // carry two (integration of the SEO audit lanes, 2026-11-02).
            organizer: organizers.map((organiser) =>
              organiser.slug
                ? {
                    "@type": "Organization",
                    "@id": organizationId(organiser.slug),
                    name: organiser.name,
                  }
                : { "@type": "Organization", name: organiser.name },
            ),
          }
        : {}),
  }
}

/**
 * The visible breadcrumb trail of `/events/<key>` (components/organisms/
 * event-page.tsx): the calendar. The page itself is the H1, not a crumb; the
 * JSON-LD BreadcrumbList is this trail with the page appended, so the two say
 * the same (review of the SEO audit, event-breadcrumb-mismatch). The event's
 * day on the calendar (`/events?date=<day>`) is no crumb since the bot policy
 * of 2026-11-03: it is a robots.txt trap (lib/crawl-traps.ts), and no crumb
 * may point where a crawler is told not to go.
 */
export function eventTrail(): { name: string; path: string }[] {
  return [{ name: "Events", path: "/events" }]
}

/**
 * The page's JSON-LD graph (SEO audit "jsonld-graph-breadcrumbs"): its
 * WebPage, part of the site's WebSite by `@id`, whose main entity is the
 * Event, and the BreadcrumbList of the visible trail (`eventTrail`: Events)
 * ending with the event. Null when the event gets no structured
 * data at all.
 */
export function eventStructuredData(
  event: PageEvent & { key: string },
  venue?: EventVenue,
): Record<string, unknown> | null {
  if (!eventHasStructuredData(event)) return null
  const path = `/events/${event.key}`
  const pageUrl = pageId(path)
  const name = spokenTitle(event.title)
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebPage",
        "@id": pageUrl,
        url: pageUrl,
        name,
        isPartOf: { "@id": WEBSITE_ID },
        mainEntity: { "@id": eventId(event.key) },
        breadcrumb: { "@id": `${pageUrl}#breadcrumb` },
      },
      eventJsonLd(event, pageUrl, venue),
      breadcrumbList(path, [...eventTrail(), { name, path }]),
    ],
  }
}

// --- the calendar page (/events) -------------------------------------------------------------

/** The calendar's document title (SEO audit "hub-page-titles-weak"): what a
 * search for this week's Cambridge events should find. */
export const EVENTS_TITLE = "What’s on: Cambridge student events this week"

/**
 * The title of one society's calendar (`/events?org=<slug>`): "Chess Club
 * events in Cambridge", or without "in Cambridge" when the name says it
 * already or it would not fit — within `TITLE_MAX`, the " · CAMsocs" suffix
 * dropped first (`absolute`).
 */
export function orgEventsTitle(name: string): { title: string; absolute: boolean } {
  const named = /\bcambridge\b/i.test(name)
  const candidates = [named ? undefined : `${name} events in Cambridge`, `${name} events`]
  for (const title of candidates) {
    if (title && title.length + TITLE_SUFFIX.length <= TITLE_MAX) return { title, absolute: false }
  }
  for (const title of candidates) {
    if (title && title.length <= TITLE_MAX) return { title, absolute: true }
  }
  return { title: `${clip(name, TITLE_MAX - " events".length)} events`, absolute: true }
}

/**
 * The calendar's JSON-LD (SEO audit "listing-itemlist"): a CollectionPage,
 * part of the site, whose main entity is the URL-only ItemList of the event
 * pages it shows — the Event itself is on each page, not repeated here. Only
 * public events (a signed-in reader's Cambridge-only ones are not for
 * search), never cancelled ones; the list never holds a talks.cam-derived
 * event (owner decision G1: `events.list` leaves them out).
 */
export function eventsListStructuredData({
  path,
  name,
  events,
}: {
  /** The page's canonical path: `/events` or `/events?org=<slug>`. */
  path: string
  name: string
  events: readonly {
    key: string
    talksDerived: boolean
    visibility: string
    cancelled: boolean
  }[]
}): Record<string, unknown> {
  const listed = events
    .filter((event) => event.visibility === "public" && !event.cancelled)
    .filter((event) => !event.talksDerived)
    .slice(0, 100)
  const pageUrl = pageId(path)
  return {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    "@id": pageUrl,
    url: pageUrl,
    name,
    isPartOf: { "@id": WEBSITE_ID },
    mainEntity: {
      "@type": "ItemList",
      itemListOrder: "https://schema.org/ItemListOrderAscending",
      numberOfItems: listed.length,
      itemListElement: listed.map((event, index) => ({
        "@type": "ListItem",
        position: index + 1,
        url: pageId(`/events/${event.key}`),
      })),
    },
  }
}
