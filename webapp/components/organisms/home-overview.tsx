"use client"

import { ArrowRightIcon } from "lucide-react"
import Link from "next/link"
import { useRef, useState } from "react"
import { cn } from "@/lib/utils"

export type OverviewItem = {
  key: string
  href: string
  /** "19:30", "All day" or "On". */
  time: string
  /** The weekday above the time ("Tue"), in the week view. */
  weekday?: string
  /** Today's weekday, marked in apricot. */
  isToday?: boolean
  title: string
  meta?: string
}

export type OverviewSociety = { key: string; href: string; name: string; count: number }

export type OverviewColumn<T> = { items: T[]; total: number; href: string }

/** One view of the three columns: today, the week, or one day of it. */
export type OverviewSlice = {
  heading: string
  /** "31 events · 23 talks · 18 societies hosting". */
  summary: string
  events: OverviewColumn<OverviewItem>
  /** Null when the talks module could not be read. */
  talks: OverviewColumn<OverviewItem> | null
  societies: OverviewColumn<OverviewSociety>
}

export type OverviewDay = {
  iso: string
  /** "Tue". */
  weekday: string
  /** "3". */
  date: string
  isToday: boolean
  events: number
  talks: number | null
  slice: OverviewSlice
}

type Mode = "today" | "week" | string

/**
 * The home page's overview (DESIGN.md "River & ink"): Events · Talks ·
 * Societies side by side for today, the next seven days, or one day picked in
 * the week strip below it. Every view is rendered on the server and passed
 * in; switching is instant and needs no request.
 */
export function HomeOverview({
  today,
  week,
  days,
  weekRange,
}: {
  today: OverviewSlice
  week: OverviewSlice
  days: OverviewDay[]
  /** "Sun 1 – Sat 7 Nov". */
  weekRange: string
}) {
  const [mode, setMode] = useState<Mode>("today")
  const headingRef = useRef<HTMLHeadingElement>(null)
  const picked = days.find((day) => day.iso === mode && !day.isToday)
  const slice = mode === "week" ? week : (picked?.slice ?? today)
  const isToday = mode !== "week" && !picked
  const hasTalks = slice.talks !== null

  const pickDay = (day: OverviewDay) => {
    setMode(day.isToday ? "today" : day.iso)
    const heading = headingRef.current
    if (heading && heading.getBoundingClientRect().top < 0) {
      heading.scrollIntoView({ block: "start" })
    }
    heading?.focus({ preventScroll: true })
  }

  return (
    <>
      <section
        aria-labelledby="overview-heading"
        className="mx-auto w-full max-w-7xl scroll-mt-24 px-4 pt-10 pb-12 sm:px-8 sm:pt-12"
      >
        <div className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
          <div className="min-w-0">
            <h2
              id="overview-heading"
              ref={headingRef}
              tabIndex={-1}
              className="flex scroll-mt-24 items-center gap-3.5 font-serif text-[clamp(2.1rem,4vw,2.9rem)] leading-tight tracking-[-0.01em] outline-none"
            >
              {isToday && <span aria-hidden className="size-3 shrink-0 rounded-full bg-today" />}
              {slice.heading}
            </h2>
            <p
              aria-live="polite"
              className="mt-1.5 font-mono text-[0.8125rem] text-muted-foreground tabular-nums"
            >
              {slice.summary}
            </p>
          </div>
          <fieldset
            aria-label="Show"
            className="flex w-full gap-0.5 rounded-xl border p-[3px] sm:w-auto"
          >
            {(
              [
                ["today", "Today"],
                ["week", "This week"],
              ] as const
            ).map(([value, label]) => {
              const pressed = value === "week" ? mode === "week" : mode !== "week"
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={pressed}
                  onClick={() => setMode(value)}
                  className="min-h-11 flex-1 rounded-[9px] px-[18px] text-[0.9375rem] font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring aria-pressed:bg-brand aria-pressed:text-brand-foreground sm:min-h-10 sm:flex-none"
                >
                  {label}
                </button>
              )
            })}
          </fieldset>
        </div>

        <div
          className={cn(
            "grid grid-cols-1 gap-9 md:gap-8 lg:gap-12",
            hasTalks ? "md:grid-cols-3" : "md:grid-cols-2",
          )}
        >
          <Column
            title="Events"
            href="/events"
            column={slice.events}
            noun={["event", "events"]}
            empty="Nothing listed yet."
          />
          {slice.talks && (
            <Column
              title="Talks"
              href="/talks"
              column={slice.talks}
              noun={["talk", "talks"]}
              empty="No talks listed."
            />
          )}
          <SocietiesColumn column={slice.societies} />
        </div>
      </section>

      <section
        aria-labelledby="week-heading"
        className="mx-auto w-full max-w-7xl px-4 pb-12 sm:px-8"
      >
        <div className="mb-3.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2
            id="week-heading"
            className="font-serif text-[1.45rem] leading-tight sm:text-[1.625rem]"
          >
            The week ahead
          </h2>
          <p className="font-mono text-[0.8125rem] text-muted-foreground tabular-nums">
            {weekRange}
          </p>
        </div>
        <fieldset
          aria-label="Pick a day"
          className="grid grid-cols-7 border-t border-b border-t-foreground"
        >
          {days.map((day, index) => {
            const empty = day.events === 0 && !day.talks
            const pressed = day.isToday ? mode === "today" : mode === day.iso
            return (
              <button
                key={day.iso}
                type="button"
                aria-pressed={pressed}
                onClick={() => pickDay(day)}
                className={cn(
                  "group relative flex min-h-21 min-w-0 flex-col items-start gap-0.5 py-3 pr-0 pl-[7px] text-left transition-colors hover:bg-muted focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-ring sm:px-4 sm:py-3.5",
                  index > 0 && "border-l",
                  pressed && "bg-brand text-brand-foreground hover:bg-brand",
                )}
              >
                {day.isToday && (
                  <span aria-hidden className="absolute inset-x-0 -top-px h-1 bg-today" />
                )}
                <span
                  className={cn(
                    "text-[0.6875rem] font-semibold tracking-[0.04em] uppercase sm:text-xs sm:tracking-[0.08em]",
                    pressed
                      ? "text-brand-foreground"
                      : day.isToday
                        ? "text-today-text"
                        : empty
                          ? "text-faint"
                          : "text-muted-foreground",
                  )}
                >
                  {day.isToday ? "Today" : day.weekday}
                </span>
                <span
                  className={cn(
                    "font-serif text-[1.375rem] leading-tight sm:text-[1.75rem]",
                    empty && !pressed && "text-faint",
                  )}
                >
                  {day.date}
                </span>
                <span
                  className={cn(
                    "font-mono text-[0.75rem] leading-normal whitespace-nowrap tabular-nums sm:text-[0.78rem]",
                    pressed
                      ? "text-brand-foreground"
                      : empty
                        ? "text-faint"
                        : "text-muted-foreground",
                  )}
                >
                  <span className="block">
                    {day.events}
                    <span className="max-sm:hidden"> {day.events === 1 ? "event" : "events"}</span>
                    <span className="sr-only sm:hidden"> events</span>
                    <span className="sm:hidden" aria-hidden>
                      {" "}
                      ev
                    </span>
                  </span>
                  {day.talks !== null && (
                    <span className="block max-sm:hidden">
                      {day.talks} {day.talks === 1 ? "talk" : "talks"}
                    </span>
                  )}
                </span>
                <span className="sr-only">
                  {day.isToday ? `, ${day.weekday}` : ""}: show this day above
                </span>
              </button>
            )
          })}
        </fieldset>
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-x-5 gap-y-1">
          <p className="text-sm text-muted-foreground">Pick a day to see it above.</p>
          <MoreLink href="/events">Open the full calendar</MoreLink>
        </div>
      </section>
    </>
  )
}

function ColumnHead({ title, href, count }: { title: string; href: string; count: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h3 className="min-w-0 font-serif text-2xl leading-snug sm:text-[1.6875rem]">
        <Link
          href={href}
          className="group inline-flex min-h-11 items-center gap-2.5 hover:text-brand-text focus-visible:outline-2 focus-visible:outline-ring"
        >
          {title}
          <ArrowRightIcon
            aria-hidden
            className="size-[18px] transition-transform group-hover:translate-x-[3px]"
          />
        </Link>
      </h3>
      <span className="font-mono text-[0.8125rem] whitespace-nowrap text-muted-foreground tabular-nums">
        {count}
      </span>
    </div>
  )
}

function Column({
  title,
  href,
  column,
  noun,
  empty,
}: {
  title: string
  href: string
  column: OverviewColumn<OverviewItem>
  noun: [string, string]
  empty: string
}) {
  return (
    <div className="flex min-w-0 flex-col border-t-2 border-foreground pt-3">
      <ColumnHead
        title={title}
        href={href}
        count={`${column.total.toLocaleString("en-GB")} ${column.total === 1 ? noun[0] : noun[1]}`}
      />
      {column.items.length === 0 ? (
        <p className="mt-1 border-y py-4 text-[0.9375rem] text-muted-foreground">{empty}</p>
      ) : (
        <ul className="mt-1">
          {column.items.map((item, index) => (
            // Phones stack the columns, so each shows three rows.
            <li key={item.key} className={cn(index >= 3 && "max-md:hidden")}>
              <Link
                href={item.href}
                className="group grid grid-cols-[50px_minmax(0,1fr)] gap-3 border-b py-[13px] focus-visible:outline-2 focus-visible:outline-ring sm:grid-cols-[54px_minmax(0,1fr)] sm:gap-3.5 sm:py-[15px] [li:first-child>&]:border-t"
              >
                <span className="font-mono text-sm leading-[1.45] tabular-nums">
                  {item.weekday && (
                    <span
                      className={cn(
                        "block text-[0.6875rem] font-medium tracking-[0.06em] uppercase",
                        item.isToday ? "text-today-text" : "text-muted-foreground",
                      )}
                    >
                      {item.weekday}
                    </span>
                  )}
                  {item.time}
                </span>
                <span className="min-w-0">
                  <span className="block text-base leading-[1.38] font-semibold text-pretty group-hover:text-brand-text group-hover:underline group-hover:decoration-1 group-hover:underline-offset-[3px]">
                    {item.title}
                  </span>
                  {item.meta && (
                    <span className="mt-0.5 block truncate text-sm leading-[1.45] text-muted-foreground">
                      {item.meta}
                    </span>
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <MoreLink href={column.href} className="mt-auto pt-3">
        {column.total > 3
          ? `All ${column.total.toLocaleString("en-GB")} ${noun[1]}`
          : `All ${noun[1]}`}
      </MoreLink>
    </div>
  )
}

function SocietiesColumn({ column }: { column: OverviewColumn<OverviewSociety> }) {
  return (
    <div className="flex min-w-0 flex-col border-t-2 border-foreground pt-3">
      <ColumnHead
        title="Societies"
        href="/societies"
        count={`${column.total.toLocaleString("en-GB")} hosting`}
      />
      {column.items.length === 0 ? (
        <p className="mt-1 border-y py-4 text-[0.9375rem] text-muted-foreground">
          No society events listed.
        </p>
      ) : (
        <ul className="mt-1">
          {column.items.map((society, index) => (
            <li key={society.key} className={cn(index >= 3 && "max-md:hidden")}>
              <Link
                href={society.href}
                className="group flex items-baseline justify-between gap-3 border-b py-[13px] focus-visible:outline-2 focus-visible:outline-ring sm:py-[15px] [li:first-child>&]:border-t"
              >
                <span className="min-w-0 text-base leading-[1.38] font-semibold text-pretty group-hover:text-brand-text group-hover:underline group-hover:decoration-1 group-hover:underline-offset-[3px]">
                  {society.name}
                </span>
                <span className="shrink-0 font-mono text-sm text-muted-foreground tabular-nums">
                  {society.count}
                  <span className="sr-only"> {society.count === 1 ? "event" : "events"}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <MoreLink href={column.href} className="mt-auto pt-3">
        Browse every society
      </MoreLink>
    </div>
  )
}

export function MoreLink({
  href,
  className,
  children,
}: {
  href: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <Link
      href={href}
      className={cn(
        "group inline-flex min-h-11 items-center gap-2 self-start text-[0.9375rem] font-semibold text-brand-text focus-visible:outline-2 focus-visible:outline-ring",
        className,
      )}
    >
      <span className="underline decoration-sky-line decoration-1 underline-offset-4 group-hover:decoration-current">
        {children}
      </span>
      <ArrowRightIcon
        aria-hidden
        className="size-4 transition-transform group-hover:translate-x-[3px]"
      />
    </Link>
  )
}
