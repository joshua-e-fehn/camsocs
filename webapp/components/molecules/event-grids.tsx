import Link from "next/link"
import { EventChip, TONE_DOT } from "@/components/molecules/event-item"
import { formatDayShort, WEEKDAYS } from "@/lib/calendar"
import { linkProps } from "@/lib/crawl-traps"
import { EVENT_TYPE_TONE, weekRowGutter } from "@/lib/events"
import type { EventListItem } from "@/lib/public-api"
import type { TermDatesRow } from "@/lib/term-week"
import { cn } from "@/lib/utils"
import { weekdayLetter } from "@/lib/week-strip"

/** Chips a month cell shows before "+N more". */
export const MONTH_CELL_CHIPS = 3

type GridProps = {
  days: readonly string[]
  byDay: ReadonlyMap<string, EventListItem[]>
  today: string
  /** The event's link (its page; a plain click opens the sheet). */
  eventHref: (event: EventListItem) => string
  onSelect: (event: EventListItem, target: HTMLElement) => void
  /** The list view of one day ("+3 more", a phone's tap on a day): a
   * robots.txt trap, linked rel=nofollow (lib/crawl-traps.ts). */
  dayHref: (day: string) => string
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * The week view (Monday to Sunday): seven columns on a desktop — a weekday
 * letter over the date in the serif, a count, then the day's events as chips
 * coloured by type — and the days stacked on a phone.
 */
export function EventWeekGrid({ days, byDay, today, eventHref, onSelect, dayHref }: GridProps) {
  return (
    <ol className="grid grid-cols-1 gap-2 md:grid-cols-7 md:gap-1.5">
      {days.map((day) => {
        const dayEvents = byDay.get(day) ?? []
        const isToday = day === today
        return (
          <li
            key={day}
            className={cn(
              "flex min-w-0 flex-col gap-1.5 rounded-xl border bg-card/60 p-2 md:min-h-40",
              isToday && "border-events/50 bg-events-tint/40",
            )}
          >
            <h3 className="flex items-baseline justify-between gap-2 px-0.5 md:flex-col md:items-start md:gap-0">
              <Link
                {...linkProps(dayHref(day))}
                className="flex min-h-11 items-baseline gap-1.5 rounded-md underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring md:min-h-0"
              >
                <span className="font-mono text-[0.6875rem] tracking-wider text-muted-foreground uppercase md:hidden">
                  {formatDayShort(day).split(" ")[0]}
                </span>
                <span
                  aria-hidden
                  className="hidden font-mono text-[0.625rem] tracking-wider text-muted-foreground uppercase md:inline"
                >
                  {weekdayLetter(day)}
                </span>
                <span className={cn("font-serif text-2xl leading-none", isToday && "text-events")}>
                  {Number(day.slice(8, 10))}
                </span>
                <span className="sr-only">
                  {formatDayShort(day)}
                  {isToday ? ", today" : ""}: {plural(dayEvents.length, "event", "events")}
                </span>
              </Link>
              <span
                aria-hidden
                className="font-mono text-[0.6875rem] text-muted-foreground tabular-nums"
              >
                {dayEvents.length === 0 ? "–" : plural(dayEvents.length, "event", "events")}
              </span>
            </h3>
            {dayEvents.length > 0 && (
              <ul className="flex flex-col gap-1">
                {dayEvents.map((event) => (
                  <li key={event.key} className="min-w-0">
                    <EventChip
                      event={event}
                      href={eventHref(event)}
                      onSelect={(target) => onSelect(event, target)}
                      className="min-h-11 items-center py-1.5 md:min-h-0 md:items-baseline md:py-1"
                    />
                  </li>
                ))}
              </ul>
            )}
          </li>
        )
      })}
    </ol>
  )
}

/**
 * The month view: whole weeks, Monday first, with the term week of each row
 * in a gutter ("M4" — Michaelmas Week 4; blank in the vacation, its gutter
 * shaded), at most three chips a day coloured by type, then "+N more". On a
 * phone a day is its number and a dot per type; tapping it lists the day.
 */
export function EventMonthGrid({
  days,
  byDay,
  today,
  month,
  terms,
  eventHref,
  onSelect,
  dayHref,
}: GridProps & {
  /** `YYYY-MM` of the month shown; other days are muted. */
  month: string
  terms: readonly TermDatesRow[]
}) {
  const weeks: string[][] = []
  for (let index = 0; index < days.length; index += 7) weeks.push(days.slice(index, index + 7))
  return (
    <div className="flex flex-col gap-1">
      <div
        aria-hidden
        className="grid grid-cols-[1.75rem_repeat(7,minmax(0,1fr))] gap-1 font-mono text-[0.6875rem] tracking-wider text-muted-foreground uppercase sm:grid-cols-[2.5rem_repeat(7,minmax(0,1fr))]"
      >
        <span className="text-center">Wk</span>
        {WEEKDAYS.map((name) => (
          <span key={name} className="px-1 text-center md:text-left">
            <span className="md:hidden">{name[0]}</span>
            <span className="hidden md:inline">{name}</span>
          </span>
        ))}
      </div>
      <ol className="flex flex-col gap-1">
        {weeks.map((week) => {
          const gutter = weekRowGutter(week, terms)
          return (
            <li
              key={week[0]}
              className="grid grid-cols-[1.75rem_repeat(7,minmax(0,1fr))] gap-1 sm:grid-cols-[2.5rem_repeat(7,minmax(0,1fr))]"
            >
              <span
                className={cn(
                  "flex items-start justify-center rounded-md pt-2 font-mono text-[0.6875rem] font-medium tabular-nums",
                  gutter
                    ? "text-events"
                    : "bg-[repeating-linear-gradient(135deg,var(--muted)_0_2px,transparent_2px_6px)] text-muted-foreground",
                )}
              >
                {gutter ? (
                  <>
                    <span aria-hidden>{gutter}</span>
                    <span className="sr-only">
                      {`${gutter[0] === "M" ? "Michaelmas" : gutter[0] === "L" ? "Lent" : "Easter"} week ${gutter.slice(1)}`}
                    </span>
                  </>
                ) : (
                  <span className="sr-only">Vacation</span>
                )}
              </span>
              {week.map((day) => (
                <MonthCell
                  key={day}
                  day={day}
                  events={byDay.get(day) ?? []}
                  isToday={day === today}
                  inMonth={day.slice(0, 7) === month}
                  eventHref={eventHref}
                  onSelect={onSelect}
                  dayHref={dayHref(day)}
                />
              ))}
            </li>
          )
        })}
      </ol>
      <p className="pt-1 text-xs text-muted-foreground md:hidden">
        A dot is an event, in its type’s colour; tap a day to list it.
      </p>
    </div>
  )
}

function MonthCell({
  day,
  events,
  isToday,
  inMonth,
  eventHref,
  onSelect,
  dayHref,
}: {
  day: string
  events: EventListItem[]
  isToday: boolean
  inMonth: boolean
  eventHref: GridProps["eventHref"]
  onSelect: GridProps["onSelect"]
  dayHref: string
}) {
  const label = `${formatDayShort(day)}${isToday ? ", today" : ""}: ${plural(events.length, "event", "events")}`
  const numeral = (
    <span
      className={cn(
        "inline-flex size-7 items-center justify-center rounded-full font-serif text-base leading-none tabular-nums",
        isToday && "bg-events text-events-foreground",
      )}
    >
      {Number(day.slice(8, 10))}
    </span>
  )
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col rounded-lg border md:min-h-32 md:gap-1 md:p-1",
        inMonth ? "bg-card" : "border-dashed bg-transparent text-muted-foreground",
      )}
    >
      {/* Phones: the whole cell is the day and opens it in the list. */}
      <Link
        {...linkProps(dayHref)}
        aria-label={label}
        className="flex min-h-14 flex-col items-center justify-center gap-1 rounded-lg hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring md:hidden"
      >
        {numeral}
        <span aria-hidden className="flex h-1.5 items-center gap-0.5">
          {events.slice(0, 3).map((event) => (
            <span
              key={event.key}
              className={cn("size-1.5 rounded-full", TONE_DOT[EVENT_TYPE_TONE[event.eventType]])}
            />
          ))}
        </span>
      </Link>
      <Link
        {...linkProps(dayHref)}
        aria-label={label}
        className="hidden self-start rounded-full hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring md:block"
      >
        {numeral}
      </Link>
      {events.length > 0 && (
        <ul className="hidden min-w-0 flex-col gap-1 md:flex">
          {events.slice(0, MONTH_CELL_CHIPS).map((event) => (
            <li key={event.key} className="min-w-0">
              <EventChip
                event={event}
                href={eventHref(event)}
                onSelect={(target) => onSelect(event, target)}
              />
            </li>
          ))}
          {events.length > MONTH_CELL_CHIPS && (
            <li>
              <Link
                {...linkProps(dayHref)}
                className="inline-flex px-1.5 text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
              >
                +{events.length - MONTH_CELL_CHIPS} more
                <span className="sr-only"> on {formatDayShort(day)}</span>
              </Link>
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
