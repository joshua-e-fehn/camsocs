import type { FunctionReturnType } from "convex/server"
import type { api } from "@/convex/_generated/api"
import { formatDayShort, londonIsoDate, londonTime } from "./calendar"
import { joinNames } from "./format"
import { utcStamp } from "./ics"
import { MAX_TITLE_LENGTH, TITLE_SUFFIX } from "./site"
import { breadcrumbList, pageId, talkId, WEBSITE_ID } from "./structured-data"
import { TALK_KIND_LABELS, type TalkKind, type TalkSchool } from "./vocab"
import { relativeDay } from "./week-strip"

/**
 * The talks pillar's display side (talks-redesign-spec §6): the public API's
 * talk types, School colours and short names, and pure formatters for rows,
 * day headers, calendar links and the detail page's JSON-LD.
 */

// --- types (the `returns` validators of convex/talks.ts) -----------------------------------

/** A talk in a list (`talks.list`, `talks.search`): no abstract. */
export type TalkListItem = FunctionReturnType<typeof api.talks.list>["page"][number]
/** One talk with its abstract and provenance (`talks.get`). */
export type TalkPublic = NonNullable<FunctionReturnType<typeof api.talks.get>>
/** A department with its upcoming count (`talks.departments`), or the
 * virtual "Other series" bucket (`virtual: true`). */
export type TalkDepartment = FunctionReturnType<typeof api.talks.departments>[number]
export type TalkOverview = FunctionReturnType<typeof api.talks.overview>

// --- Schools ---------------------------------------------------------------------------------

/** The rail's and chips' names: short enough for a pill. */
export const TALK_SCHOOL_SHORT: Record<TalkSchool, string> = {
  arts_humanities: "Arts & Humanities",
  humanities_social_sciences: "Hum. & Social Sciences",
  biological_sciences: "Biological Sci.",
  clinical_medicine: "Clinical Medicine",
  physical_sciences: "Physical Sci.",
  technology: "Technology",
  other: "Other",
}

/**
 * Tailwind classes per School, from the `--school-*` tokens (globals.css,
 * ink on tint ≥ 5.8:1 in both themes). Written out whole so Tailwind sees
 * every class: `chip` is ink on tint, `dot` a solid mark, `ink` text only,
 * `border` a rule in the School's ink.
 */
export const SCHOOL_TONE: Record<
  TalkSchool,
  { chip: string; dot: string; ink: string; border: string }
> = {
  arts_humanities: {
    chip: "bg-school-arts-tint text-school-arts",
    dot: "bg-school-arts",
    ink: "text-school-arts",
    border: "border-school-arts",
  },
  humanities_social_sciences: {
    chip: "bg-school-hss-tint text-school-hss",
    dot: "bg-school-hss",
    ink: "text-school-hss",
    border: "border-school-hss",
  },
  biological_sciences: {
    chip: "bg-school-bio-tint text-school-bio",
    dot: "bg-school-bio",
    ink: "text-school-bio",
    border: "border-school-bio",
  },
  clinical_medicine: {
    chip: "bg-school-clinical-tint text-school-clinical",
    dot: "bg-school-clinical",
    ink: "text-school-clinical",
    border: "border-school-clinical",
  },
  physical_sciences: {
    chip: "bg-school-physical-tint text-school-physical",
    dot: "bg-school-physical",
    ink: "text-school-physical",
    border: "border-school-physical",
  },
  technology: {
    chip: "bg-school-tech-tint text-school-tech",
    dot: "bg-school-tech",
    ink: "text-school-tech",
    border: "border-school-tech",
  },
  other: {
    chip: "bg-school-other-tint text-school-other",
    dot: "bg-school-other",
    ink: "text-school-other",
    border: "border-school-other",
  },
}

/** Upcoming talks per School, summed from the department index. */
export function schoolCounts(departments: readonly TalkDepartment[]): Record<TalkSchool, number> {
  const counts: Record<TalkSchool, number> = {
    arts_humanities: 0,
    humanities_social_sciences: 0,
    biological_sciences: 0,
    clinical_medicine: 0,
    physical_sciences: 0,
    technology: 0,
    other: 0,
  }
  for (const department of departments) counts[department.school] += department.upcomingCount
  return counts
}

// --- venues ---------------------------------------------------------------------------------

const VIRTUAL_VENUE =
  /^\W*(online|virtual|zoom|ms teams|microsoft teams|teams|webinar|livestream|live stream)\b/i
const MORE_THAN_ONE_PLACE = /\b(and|or|plus|also)\b|[&+]/i

/**
 * The room a talk is in, or null when its "venue" only names a meeting
 * service ("Online (Zoom)", "Zoom link on registration", "Microsoft Teams").
 * Listings put those in the venue field; they are not a place to walk to,
 * so they get no map link and do not make an online talk "hybrid". A venue
 * that names a room as well ("Online and LT1") stays a place.
 */
export function physicalVenue(venue: string | null): string | null {
  if (venue === null) return null
  return VIRTUAL_VENUE.test(venue) && !MORE_THAN_ONE_PLACE.test(venue) ? null : venue
}

// --- rows and days ---------------------------------------------------------------------------

type Timed = { startsAt: number; endsAt: number | null; allDay: boolean }

/** A row's time column: "13:00" over "14:00", or "All day". London time. */
export function talkTimes(talk: Timed): { start: string; end?: string } {
  if (talk.allDay) return { start: "All day" }
  const start = londonTime(talk.startsAt)
  const sameDay =
    talk.endsAt !== null &&
    talk.endsAt > talk.startsAt &&
    londonIsoDate(talk.endsAt) === londonIsoDate(talk.startsAt)
  return sameDay && talk.endsAt !== null ? { start, end: londonTime(talk.endsAt) } : { start }
}

/** "Tue 3 Nov, 13:00–14:00", "Tue 3 Nov (all day)". London time. */
export function talkWhen(talk: Timed): string {
  const day = formatDayShort(londonIsoDate(talk.startsAt))
  if (talk.allDay) return `${day} (all day)`
  const { start, end } = talkTimes(talk)
  return end ? `${day}, ${start}–${end}` : `${day}, ${start}`
}

type Speaker = { name: string; affiliation?: string }

/** "Ada Lovelace · Analytical Engines", "Ada Lovelace and Charles Babbage",
 * "Ada Lovelace, Charles Babbage and 2 others"; "" without speakers. */
export function speakerLine(speakers: readonly Speaker[]): string {
  if (speakers.length === 0) return ""
  if (speakers.length === 1) {
    const [only] = speakers
    return only.affiliation ? `${only.name} · ${only.affiliation}` : only.name
  }
  const names = speakers.map((speaker) => speaker.name)
  if (names.length <= 3) return joinNames(names)
  const rest = names.length - 2
  return `${names[0]}, ${names[1]} and ${rest} others`
}

export type TalkDay<T> = { day: string; talks: T[] }

/** Talks grouped by London day, days and talks in start order. */
export function groupTalksByDay<T extends { startsAt: number }>(talks: readonly T[]): TalkDay<T>[] {
  const sorted = [...talks].sort((a, b) => a.startsAt - b.startsAt)
  const days: TalkDay<T>[] = []
  for (const talk of sorted) {
    const day = londonIsoDate(talk.startsAt)
    const last = days[days.length - 1]
    if (last?.day === day) last.talks.push(talk)
    else days.push({ day, talks: [talk] })
  }
  return days
}

/** A sticky day header's words: "Today · Tue 3 Nov", or "Thu 5 Nov". */
export function dayHeading(day: string, today: string): { relative?: string; date: string } {
  return { relative: relativeDay(day, today), date: formatDayShort(day) }
}

export type TalkTiming = { kind: "now" } | { kind: "soon"; minutes: number } | { kind: "past" }

/** In progress, starting within the hour, or over — for a quiet status pill;
 * undefined for anything later, an all-day talk, or before `now` is known. */
export function talkTiming(talk: Timed, now: number | undefined): TalkTiming | undefined {
  if (now === undefined || talk.allDay) return undefined
  const end = talk.endsAt ?? talk.startsAt + 60 * 60 * 1000
  if (now >= end) return { kind: "past" }
  if (now >= talk.startsAt) return { kind: "now" }
  const minutes = Math.ceil((talk.startsAt - now) / 60_000)
  return minutes <= 60 ? { kind: "soon", minutes } : undefined
}

export const TALK_KIND_PLURAL: Record<TalkKind, string> = {
  seminar: "seminars",
  lecture: "lectures",
  workshop: "workshops",
  conference: "conferences",
  other: "talks",
}

// --- calendar links ----------------------------------------------------------------------

type CalendarTalk = Timed & {
  key: string
  title: string
  speakers: readonly Speaker[]
  series: string | null
  venue: string | null
  online: boolean
  cancelled: boolean
  url: string
}

/** The words a calendar entry carries: speakers, series, where to read more. */
export function calendarDetails(talk: CalendarTalk, pageUrl: string): string {
  const lines: string[] = []
  if (talk.cancelled) lines.push("This talk is cancelled.")
  if (talk.speakers.length > 0) {
    lines.push(
      talk.speakers
        .map((speaker) =>
          speaker.affiliation ? `${speaker.name} (${speaker.affiliation})` : speaker.name,
        )
        .join("; "),
    )
  }
  if (talk.series) lines.push(`Series: ${talk.series}`)
  if (talk.online) lines.push("Online or hybrid: the link is on the talk's page.")
  lines.push(`Details: ${pageUrl}`)
  lines.push(`Source: ${talk.url}`)
  return lines.join("\n")
}

function compactDate(iso: string): string {
  return iso.replace(/-/g, "")
}

function nextDay(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10)
}

/** The end of a timed talk for a calendar: its own, or an hour after the start. */
function endOf(talk: Timed): number {
  return talk.endsAt !== null && talk.endsAt > talk.startsAt
    ? talk.endsAt
    : talk.startsAt + 60 * 60 * 1000
}

/** Google Calendar's "add event" template link. */
export function googleCalendarUrl(talk: CalendarTalk, pageUrl: string): string {
  const day = londonIsoDate(talk.startsAt)
  const dates = talk.allDay
    ? `${compactDate(day)}/${compactDate(nextDay(day))}`
    : `${utcStamp(talk.startsAt)}/${utcStamp(endOf(talk))}`
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: talk.cancelled ? `Cancelled: ${talk.title}` : talk.title,
    dates,
    details: calendarDetails(talk, pageUrl),
    ctz: "Europe/London",
  })
  const location = talk.venue ?? (talk.online ? "Online" : null)
  if (location) params.set("location", location)
  return `https://calendar.google.com/calendar/render?${params.toString()}`
}

/** Outlook on the web's compose link (outlook.live.com: personal accounts;
 * a University Microsoft 365 account opens it at outlook.office.com). */
export function outlookCalendarUrl(
  talk: CalendarTalk,
  pageUrl: string,
  host: "outlook.live.com" | "outlook.office.com" = "outlook.live.com",
): string {
  const day = londonIsoDate(talk.startsAt)
  const params = new URLSearchParams({
    path: "/calendar/action/compose",
    rru: "addevent",
    subject: talk.cancelled ? `Cancelled: ${talk.title}` : talk.title,
    body: calendarDetails(talk, pageUrl),
  })
  if (talk.allDay) {
    params.set("startdt", day)
    params.set("enddt", nextDay(day))
    params.set("allday", "true")
  } else {
    params.set("startdt", new Date(talk.startsAt).toISOString())
    params.set("enddt", new Date(endOf(talk)).toISOString())
  }
  const location = talk.venue ?? (talk.online ? "Online" : null)
  if (location) params.set("location", location)
  return `https://${host}/calendar/0/action/compose?${params.toString()}`
}

// --- the agenda's title --------------------------------------------------------------------

/** The talks pillar's document title (SEO audit "hub-page-titles-weak"):
 * what a search for Cambridge seminars should find. */
export const TALKS_TITLE = "Public talks & seminars in Cambridge"

const TITLE_MAX = MAX_TITLE_LENGTH

/**
 * The agenda's title for its filters, the same on the server (metadata) and
 * in the browser (after a filter change): the pillar's own, "Computer
 * Science talks & seminars in Cambridge" for a department or a School (SEO
 * audit "talks-department-hubs"), or the kind and scope for other slices.
 * Within 60 characters, the " · camsocs" suffix dropped first (`absolute`).
 */
export function talksPageTitle(
  filters: { school?: TalkSchool; kind?: TalkKind },
  departmentName?: string,
): { title: string; absolute: boolean } {
  const scope = departmentName ?? (filters.school ? TALK_SCHOOL_SHORT[filters.school] : undefined)
  const kind = filters.kind ? `${TALK_KIND_LABELS[filters.kind]}s` : undefined
  const candidates = !scope
    ? [kind ? `${kind} in Cambridge` : TALKS_TITLE]
    : kind
      ? [`${kind} · ${scope} talks`]
      : [
          /\bcambridge\b/i.test(scope) ? undefined : `${scope} talks & seminars in Cambridge`,
          `${scope} talks & seminars`,
          `${scope} talks`,
        ]
  for (const title of candidates) {
    if (title && title.length + TITLE_SUFFIX.length <= TITLE_MAX) return { title, absolute: false }
  }
  for (const title of candidates) {
    if (title && title.length <= TITLE_MAX) return { title, absolute: true }
  }
  const last = candidates[candidates.length - 1] ?? TALKS_TITLE
  return { title: `${last.slice(0, TITLE_MAX - 1).trimEnd()}…`, absolute: true }
}

/** The title as the browser shows it: with the suffix unless `absolute`. */
export function documentTitle({ title, absolute }: { title: string; absolute: boolean }): string {
  return absolute ? title : `${title}${TITLE_SUFFIX}`
}

// --- the detail page -----------------------------------------------------------------------

/** The page's meta description: who, when, where (no abstract: it is the
 * source's words, and the page shows it). */
export function talkMetaDescription(talk: TalkListItem): string {
  const parts = [
    speakerLine(talk.speakers),
    talkWhen(talk),
    talk.venue ?? (talk.online ? "Online" : ""),
  ]
  const department = talk.departments[0]?.shortName
  const lead = talk.series ?? department
  const text = parts.filter(Boolean).join(" · ")
  return lead ? `${lead}: ${text}` : text
}

/**
 * schema.org `Event` for a talk's page, as a node of the site's graph (owner
 * decision G8: talk markup stays; only its errors are fixed, SEO audit
 * "talk-jsonld-details"). The abstract is left out: it stays on the source's
 * page and ours. An online talk's VirtualLocation stays the source listing,
 * where the joining link is (a page of ours is not where anyone attends; G8
 * keeps that as it was, review of 2026-11-02); the organizer is the
 * department by its full name.
 */
export function talkJsonLd(talk: TalkPublic, pageUrl: string): Record<string, unknown> {
  const room = physicalVenue(talk.venue)
  const mode = talk.online
    ? room
      ? "https://schema.org/MixedEventAttendanceMode"
      : "https://schema.org/OnlineEventAttendanceMode"
    : "https://schema.org/OfflineEventAttendanceMode"
  const place = room
    ? {
        "@type": "Place",
        name: room,
        address: { "@type": "PostalAddress", addressLocality: "Cambridge", addressCountry: "GB" },
      }
    : null
  const virtual = talk.online ? { "@type": "VirtualLocation", url: talk.url } : null
  const location = [place, virtual].filter(Boolean)
  const day = londonIsoDate(talk.startsAt)
  const department = talk.departments[0]
  return {
    "@type": "Event",
    "@id": talkId(talk.key),
    name: talk.title,
    url: pageUrl,
    sameAs: talk.url,
    startDate: talk.allDay ? day : new Date(talk.startsAt).toISOString(),
    ...(talk.endsAt !== null && talk.endsAt > talk.startsAt
      ? {
          endDate: talk.allDay
            ? londonIsoDate(talk.endsAt - 1)
            : new Date(talk.endsAt).toISOString(),
        }
      : {}),
    eventStatus: talk.cancelled
      ? "https://schema.org/EventCancelled"
      : "https://schema.org/EventScheduled",
    eventAttendanceMode: mode,
    ...(location.length > 0 ? { location: location.length === 1 ? location[0] : location } : {}),
    ...(talk.speakers.length > 0
      ? {
          performer: talk.speakers.map((speaker) => ({
            "@type": "Person",
            name: speaker.name,
            ...(speaker.affiliation
              ? { affiliation: { "@type": "Organization", name: speaker.affiliation } }
              : {}),
          })),
        }
      : {}),
    ...(department
      ? { organizer: { "@type": "Organization", name: department.name ?? department.shortName } }
      : {}),
    ...(talk.series ? { superEvent: { "@type": "EventSeries", name: talk.series } } : {}),
  }
}

/**
 * A talk page's JSON-LD graph (SEO audit "jsonld-graph-breadcrumbs"): its
 * WebPage, part of the site's WebSite by `@id`, whose main entity is the
 * talk's Event, and the BreadcrumbList of the visible trail (Talks › the
 * department › the talk).
 */
export function talkStructuredData(talk: TalkPublic): Record<string, unknown> {
  const path = `/talks/${talk.key}`
  const pageUrl = pageId(path)
  const department = talk.departments[0]
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebPage",
        "@id": pageUrl,
        url: pageUrl,
        name: talk.title,
        isPartOf: { "@id": WEBSITE_ID },
        mainEntity: { "@id": talkId(talk.key) },
        breadcrumb: { "@id": `${pageUrl}#breadcrumb` },
      },
      talkJsonLd(talk, pageUrl),
      breadcrumbList(path, [
        { name: "Talks", path: "/talks" },
        ...(department
          ? [{ name: department.shortName, path: `/talks?dept=${department.slug}` }]
          : []),
        { name: talk.title, path },
      ]),
    ],
  }
}

/** JSON for a `<script type="application/ld+json">` (lib/structured-data.ts). */
export { jsonLdScript } from "./structured-data"

// --- the Subscribe sentence ----------------------------------------------------------------

export type SentencePart = { text: string; strong?: boolean }

/**
 * The Subscribe dialog's sentence for a feed's filters, as plain and strong
 * runs: "All **talks** in **Computer Science**", "All **lectures** across the
 * **School of Technology**, **online or hybrid** only, matching **“ageing”**".
 */
export function feedSentence(
  filters: { school?: TalkSchool; kind?: TalkKind; online?: boolean; q?: string },
  departmentName?: string,
): SentencePart[] {
  const parts: SentencePart[] = [
    { text: "All " },
    { text: filters.kind ? TALK_KIND_PLURAL[filters.kind] : "talks", strong: true },
  ]
  if (departmentName) {
    parts.push({ text: " in " }, { text: departmentName, strong: true })
  } else if (filters.school === "other") {
    parts.push({ text: " at " }, { text: "institutes, museums and colleges", strong: true })
  } else if (filters.school) {
    parts.push(
      { text: " across the " },
      { text: `School of ${TALK_SCHOOL_NAMES[filters.school]}`, strong: true },
    )
  } else {
    parts.push({ text: " across " }, { text: "every department", strong: true })
  }
  if (filters.online !== undefined) {
    parts.push(
      { text: ", " },
      { text: filters.online ? "online or hybrid" : "in person", strong: true },
      { text: " only" },
    )
  }
  if (filters.q) parts.push({ text: ", matching " }, { text: `“${filters.q}”`, strong: true })
  return parts
}

/** The Schools' names after "School of". */
const TALK_SCHOOL_NAMES: Record<Exclude<TalkSchool, "other">, string> = {
  arts_humanities: "Arts and Humanities",
  humanities_social_sciences: "the Humanities and Social Sciences",
  biological_sciences: "the Biological Sciences",
  clinical_medicine: "Clinical Medicine",
  physical_sciences: "the Physical Sciences",
  technology: "Technology",
}
