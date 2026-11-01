import {
  addDays,
  formatDayShort,
  formatEventWhen,
  londonIsoDate,
  londonTime,
  spanEndOf,
} from "./calendar"
import type { CategoryTone } from "./category-tone"
import { utcStamp } from "./ics"
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
}

/** The words a calendar entry carries: who runs it (or takes part), the
 * page here. Nothing from the description: it is long, and it is on the page. */
export function eventCalendarDetails(event: CalendarEvent, pageUrl: string): string {
  const lines: string[] = []
  if (event.cancelled) lines.push("This event is cancelled.")
  const names = event.organisers.filter((o) => o.role !== "sponsor").map((o) => o.name)
  if (names.length > 0) {
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

/** The page's meta description: type, when, where, who. */
export function eventMetaDescription(
  event: CalendarEvent & { eventType: EventType },
  venueName?: string,
): string {
  const names = event.organisers.filter((o) => o.role !== "sponsor").map((o) => o.name)
  const who =
    names.length === 0
      ? undefined
      : event.hosting === "takes_part"
        ? `with ${names.join(", ")} taking part`
        : `by ${names.join(", ")}`
  const where = event.venueText ?? venueName
  const lead = `${EVENT_TYPE_LABELS[event.eventType]}${who ? ` ${who}` : ""}`
  return [lead, formatEventWhen(event), where].filter(Boolean).join(" · ")
}

/** schema.org `Event` for an event's page. Organisers are named only when
 * they run it (never for an event they only take part in, decision D6). */
export function eventJsonLd(
  event: CalendarEvent & { sourceUrl?: string; externalUrl?: string },
  pageUrl: string,
  venueName?: string,
): Record<string, unknown> {
  const where = event.venueText ?? venueName
  const day = londonIsoDate(event.startsAt)
  const organisers =
    event.hosting === "takes_part"
      ? []
      : event.organisers.filter((o) => o.role !== "sponsor").map((o) => o.name)
  return {
    "@context": "https://schema.org",
    "@type": "Event",
    name: event.title,
    url: pageUrl,
    ...(event.externalUrl || event.sourceUrl
      ? { sameAs: event.externalUrl ?? event.sourceUrl }
      : {}),
    startDate: event.allDay ? day : new Date(event.startsAt).toISOString(),
    ...(event.endsAt !== undefined && event.endsAt > event.startsAt
      ? {
          endDate: event.allDay ? lastAllDay(event) : new Date(event.endsAt).toISOString(),
        }
      : {}),
    eventStatus: event.cancelled
      ? "https://schema.org/EventCancelled"
      : "https://schema.org/EventScheduled",
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    ...(where
      ? {
          location: {
            "@type": "Place",
            name: where,
            address: {
              "@type": "PostalAddress",
              addressLocality: "Cambridge",
              addressCountry: "GB",
            },
          },
        }
      : {}),
    ...(organisers.length > 0
      ? {
          organizer: organisers.map((name) => ({ "@type": "Organization", name })),
        }
      : {}),
  }
}
