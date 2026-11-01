import { ArrowRightIcon } from "lucide-react"
import Link from "next/link"
import { cn } from "@/lib/utils"

/**
 * A day-grouped agenda: a day header ("Today · Sat 31 Oct", term stamp on
 * the right), then ruled rows with a time column — the home page's "This
 * week". Pillar-neutral: `accent` picks the rail colour (Events brick, Talks
 * indigo), so the wave-2 Talks tab renders talks with the same molecule.
 * No client JavaScript.
 */

export type AgendaItem = {
  key: string
  href: string
  /** "19:30", "All day". */
  time: string
  title: string
  /** "Organiser · Venue", "Speaker · Department". */
  meta?: string
  /** A short tag after the title: "3 nights", "Online". */
  tag?: string
  cancelled?: boolean
}

export type AgendaDay = {
  /** `YYYY-MM-DD` (London). */
  day: string
  /** "Today", "Tomorrow", "Monday". */
  label: string
  /** "Sat 31 Oct". */
  date: string
  /** The term-week stamp, "MT26 Wk 4". */
  stamp?: string
  items: AgendaItem[]
  /** More that day than shown. */
  more?: { count: number; href: string }
}

const RAIL = {
  events: "bg-events",
  talks: "bg-talks",
} as const

export function AgendaList({
  days,
  accent = "events",
  className,
}: {
  days: AgendaDay[]
  accent?: keyof typeof RAIL
  className?: string
}) {
  return (
    <ol className={cn("flex flex-col gap-7", className)}>
      {days.map((day) => (
        <li key={day.day} className="grid gap-2 md:grid-cols-[11rem_1fr] md:gap-6">
          <h3 className="flex items-baseline justify-between gap-3 border-b pb-2 md:flex-col md:justify-start md:gap-0.5 md:border-b-0 md:pb-0">
            <span className="flex items-baseline gap-2 md:flex-col md:gap-0">
              <span className="font-serif text-xl leading-tight italic">{day.label}</span>
              <span className="text-sm text-muted-foreground">{day.date}</span>
            </span>
            {day.stamp && (
              <span className="font-mono text-[0.6875rem] tracking-wide text-muted-foreground uppercase md:mt-1">
                {day.stamp}
              </span>
            )}
          </h3>
          <ul className="flex flex-col">
            {day.items.map((item) => (
              <li
                key={item.key}
                className="border-b border-dashed last:border-b-0 md:first:border-t-0"
              >
                <Link
                  href={item.href}
                  className="group grid min-h-14 grid-cols-[3.75rem_1fr] items-start gap-3 rounded-md px-2 py-2.5 -mx-2 transition-colors duration-150 hover:bg-card focus-visible:outline-2 focus-visible:outline-ring sm:grid-cols-[4.5rem_1fr]"
                >
                  <span className="flex items-center gap-2 pt-0.5 font-mono text-[0.8125rem] text-muted-foreground tabular-nums">
                    <span
                      aria-hidden
                      className={cn("size-1.5 shrink-0 rounded-full", RAIL[accent])}
                    />
                    {item.time}
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <span
                        className={cn(
                          "font-medium leading-snug group-hover:underline group-hover:decoration-1 group-hover:underline-offset-4",
                          item.cancelled && "text-muted-foreground line-through",
                        )}
                      >
                        {item.title}
                      </span>
                      {item.cancelled && (
                        <span className="text-xs text-destructive">Cancelled</span>
                      )}
                      {item.tag && (
                        <span className="font-mono text-[0.6875rem] text-muted-foreground">
                          {item.tag}
                        </span>
                      )}
                    </span>
                    {item.meta && (
                      <span className="truncate text-sm text-muted-foreground">{item.meta}</span>
                    )}
                  </span>
                </Link>
              </li>
            ))}
            {day.more && (
              <li>
                <Link
                  href={day.more.href}
                  className="inline-flex min-h-11 items-center gap-1 pl-[4.25rem] text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring sm:pl-[5rem]"
                >
                  {day.more.count} more on {day.label === "Today" ? "today" : day.date}
                  <ArrowRightIcon aria-hidden className="size-3.5" />
                </Link>
              </li>
            )}
          </ul>
        </li>
      ))}
    </ol>
  )
}
