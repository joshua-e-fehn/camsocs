/**
 * The Europe/London calendar, as pure functions over epoch milliseconds and
 * ISO dates (`YYYY-MM-DD`) — shared by the Convex functions (term weeks,
 * "upcoming", convex/lib/derived.ts) and the events calendar in the browser.
 *
 * Instants are stored in UTC and shown in London time (data-model §0.6). The
 * offset is computed from the UK clock-change rule rather than through `Intl`,
 * whose time-zone data is not guaranteed in every runtime, and so that a page
 * renders the same on the server and in the browser whatever the visitor's own
 * time zone is.
 */

export const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

/** Epoch ms of the last Sunday of `month` (0-based) in `year`, 01:00 UTC — when
 * UK clocks change (EU rule, in force since 1996). */
function lastSundayAt1Utc(year: number, month: number): number {
  const lastDay = new Date(Date.UTC(year, month + 1, 0))
  const sunday = lastDay.getUTCDate() - lastDay.getUTCDay()
  return Date.UTC(year, month, sunday, 1)
}

/** Offset of Europe/London from UTC at `ms`, in ms (0 or 1 h). */
export function londonOffsetMs(ms: number): number {
  const year = new Date(ms).getUTCFullYear()
  const bst = ms >= lastSundayAt1Utc(year, 2) && ms < lastSundayAt1Utc(year, 9)
  return bst ? HOUR_MS : 0
}

/** The Europe/London calendar date of an instant, `YYYY-MM-DD`. */
export function londonIsoDate(ms: number): string {
  return new Date(ms + londonOffsetMs(ms)).toISOString().slice(0, 10)
}

/** The Europe/London wall-clock time of an instant, `HH:MM`. */
export function londonTime(ms: number): string {
  return new Date(ms + londonOffsetMs(ms)).toISOString().slice(11, 16)
}

/** Whether `value` is a real calendar date written `YYYY-MM-DD`. */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
}

/** Midnight UTC of an ISO date, as epoch ms — for day arithmetic on dates. */
export function isoDateMs(iso: string): number {
  const [year, month, day] = iso.split("-").map(Number)
  return Date.UTC(year, month - 1, day)
}

/** The instant London's day `iso` begins. UK clocks change at 01:00 UTC, so
 * London midnight always exists and is unique. */
export function londonMidnight(iso: string): number {
  const naive = isoDateMs(iso)
  return naive - londonOffsetMs(naive - HOUR_MS)
}

export function addDays(iso: string, days: number): string {
  return new Date(isoDateMs(iso) + days * DAY_MS).toISOString().slice(0, 10)
}

/** 0 = Monday … 6 = Sunday. */
export function weekdayIndex(iso: string): number {
  return (new Date(isoDateMs(iso)).getUTCDay() + 6) % 7
}

/** The Monday on or before `iso`. */
export function startOfWeek(iso: string): string {
  return addDays(iso, -weekdayIndex(iso))
}

export function startOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`
}

/** The first day of the month `months` after the one holding `iso`. */
export function addMonths(iso: string, months: number): string {
  const [year, month] = iso.split("-").map(Number)
  const date = new Date(Date.UTC(year, month - 1 + months, 1))
  return date.toISOString().slice(0, 10)
}

// --- calendar views ------------------------------------------------------------------------

export const CALENDAR_VIEWS = ["list", "week", "month"] as const
export type CalendarView = (typeof CALENDAR_VIEWS)[number]

/** How far the list view looks ahead from its first day. */
export const LIST_DAYS = 28

export type CalendarWindow = {
  /** Epoch ms of the first instant shown (inclusive). */
  from: number
  /** Epoch ms just after the last instant shown (exclusive). */
  to: number
  /** Every London date in the window, in order. */
  days: string[]
}

function windowOf(first: string, dayCount: number): CalendarWindow {
  const days = Array.from({ length: dayCount }, (_, i) => addDays(first, i))
  return {
    from: londonMidnight(first),
    to: londonMidnight(addDays(first, dayCount)),
    days,
  }
}

/**
 * The days a view shows around `anchor`:
 *  - list: `LIST_DAYS` days from the anchor itself;
 *  - week: Monday to Sunday of the anchor's week;
 *  - month: whole weeks (Monday first) covering the anchor's month.
 */
export function viewWindow(view: CalendarView, anchor: string): CalendarWindow {
  if (view === "list") return windowOf(anchor, LIST_DAYS)
  if (view === "week") return windowOf(startOfWeek(anchor), 7)
  const first = startOfWeek(startOfMonth(anchor))
  const last = addDays(addMonths(anchor, 1), -1)
  const weeks = Math.ceil((isoDateMs(last) - isoDateMs(first) + DAY_MS) / (7 * DAY_MS))
  return windowOf(first, weeks * 7)
}

/** The anchor one page earlier (`-1`) or later (`1`) in a view. */
export function shiftAnchor(view: CalendarView, anchor: string, step: -1 | 1): string {
  if (view === "list") return addDays(anchor, step * LIST_DAYS)
  if (view === "week") return addDays(startOfWeek(anchor), step * 7)
  return addMonths(anchor, step)
}

// --- display ---------------------------------------------------------------------------------

/** Monday first, as the calendar grids are laid out. */
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const
/** Indexed by `dayOfWeek` as sessions store it (data-model §2): 0 = Sunday. */
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

/** A session's `dayOfWeek` (0 = Sunday) as a name. */
export function dayName(dayOfWeek: number): string {
  return DAY_NAMES[dayOfWeek] ?? ""
}
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const
const LONG_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const

export function weekdayShort(iso: string): string {
  return WEEKDAYS[weekdayIndex(iso)]
}

/** "Oct" */
export function monthShort(iso: string): string {
  return MONTHS[Number(iso.slice(5, 7)) - 1]
}

/** "Thu 8 Oct" */
export function formatDayShort(iso: string): string {
  const [, month, day] = iso.split("-").map(Number)
  return `${weekdayShort(iso)} ${day} ${MONTHS[month - 1]}`
}

/** "8 Oct 2026" */
export function formatDate(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number)
  return `${day} ${MONTHS[month - 1]} ${year}`
}

/** An ISO date as "8 Oct 2026"; anything else (a date as a source wrote it,
 * "open on 4th October") unchanged. */
export function formatDateOrText(value: string): string {
  return isIsoDate(value) ? formatDate(value) : value
}

/** "October 2026" */
export function formatMonth(iso: string): string {
  const [year, month] = iso.split("-").map(Number)
  return `${LONG_MONTHS[month - 1]} ${year}`
}

/** "8 Oct 2026" for an instant, in London. */
export function formatInstantDate(ms: number): string {
  return formatDate(londonIsoDate(ms))
}

type Timed = { startsAt: number; endsAt?: number; allDay: boolean }

/** The time part of an event, London time: "19:30–21:30", "19:30",
 * "18:00 – Sun 11 Oct, 12:00" across days, "All day". */
export function formatEventTime(event: Timed): string {
  if (event.allDay) return "All day"
  const start = londonTime(event.startsAt)
  if (event.endsAt === undefined || event.endsAt <= event.startsAt) return start
  const endDay = londonIsoDate(event.endsAt)
  return endDay === londonIsoDate(event.startsAt)
    ? `${start}–${londonTime(event.endsAt)}`
    : `${start} – ${formatDayShort(endDay)}, ${londonTime(event.endsAt)}`
}

/** "Thu 8 Oct, 19:30–21:00", "Thu 8 Oct (all day)", or across days
 * "Fri 9 Oct, 18:00 – Sun 11 Oct, 12:00" — London time. */
export function formatEventWhen(event: Timed): string {
  const startDay = londonIsoDate(event.startsAt)
  if (event.allDay) {
    const endDay = event.endsAt === undefined ? startDay : londonIsoDate(event.endsAt - 1)
    return endDay > startDay
      ? `${formatDayShort(startDay)} – ${formatDayShort(endDay)} (all day)`
      : `${formatDayShort(startDay)} (all day)`
  }
  return `${formatDayShort(startDay)}, ${formatEventTime(event)}`
}

/** The label for a view's range: "12 – 18 Oct 2026", "October 2026", … */
export function formatRange(view: CalendarView, window: CalendarWindow, anchor: string): string {
  if (view === "month") return formatMonth(anchor)
  const first = window.days[0]
  const last = window.days[window.days.length - 1]
  const [y1, m1, d1] = first.split("-").map(Number)
  const [y2, m2, d2] = last.split("-").map(Number)
  if (y1 !== y2) return `${formatDate(first)} – ${formatDate(last)}`
  if (m1 !== m2) return `${d1} ${MONTHS[m1 - 1]} – ${d2} ${MONTHS[m2 - 1]} ${y2}`
  return `${d1} – ${d2} ${MONTHS[m2 - 1]} ${y2}`
}
