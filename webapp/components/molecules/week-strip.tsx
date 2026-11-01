import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import { formatDayShort, monthShort } from "@/lib/calendar"
import { cn } from "@/lib/utils"
import { type DayCount, densityLevel, relativeDay, weekdayLetter } from "@/lib/week-strip"

/**
 * A horizontal week strip (talks-redesign-spec §6, the /talks and /events
 * agendas): one column per day — weekday letter, date numeral, how many
 * things that day — with the selected day filled in the pillar colour, an
 * optional soft band over a range (a preset such as "This week"), and
 * chevrons to page weeks. Generic: the caller owns the days, the counts, the
 * selection and what a tap does.
 *
 *   <WeekStrip
 *     days={[{ date: "2026-11-02", count: 14 }, …]}   // usually Monday–Sunday
 *     selected="2026-11-03"
 *     onSelect={(date) => …}
 *     termLabel="Mich · Wk 4"
 *     onPrev={…} onNext={…}
 *   />
 *
 * Days before `minDate` are shown but cannot be picked (the past, for an
 * agenda of what is coming). Every day is a 44 px button whose name says the
 * date and the count, so the strip reads well without its visual density bar.
 */
export function WeekStrip({
  days,
  selected,
  onSelect,
  termLabel,
  today,
  minDate,
  range,
  onPrev,
  onNext,
  prevDisabled,
  nextDisabled,
  noun = ["event", "events"],
  accent = "talks",
  className,
}: {
  days: readonly DayCount[]
  /** `YYYY-MM-DD`: filled. */
  selected?: string
  onSelect: (date: string) => void
  /** The week's Cambridge name, "Mich · Wk 4" (lib/week-strip.ts `stripTermLabel`). */
  termLabel?: string
  /** Marks today with a dot and lets "Today" / "Tomorrow" into the labels. */
  today?: string
  /** Days before it are disabled. */
  minDate?: string
  /** Inclusive `YYYY-MM-DD` bounds of a highlighted run of days. */
  range?: { first: string; last: string }
  onPrev?: () => void
  onNext?: () => void
  prevDisabled?: boolean
  nextDisabled?: boolean
  /** [singular, plural] for the counts' spoken names. */
  noun?: [string, string]
  accent?: "talks" | "events" | "primary"
  className?: string
}) {
  const max = Math.max(0, ...days.map((day) => day.count))
  const first = days[0]?.date
  const last = days[days.length - 1]?.date
  const span =
    first && last
      ? first.slice(5, 7) === last.slice(5, 7)
        ? `${Number(first.slice(8))} – ${Number(last.slice(8))} ${monthShort(last)}`
        : `${Number(first.slice(8))} ${monthShort(first)} – ${Number(last.slice(8))} ${monthShort(last)}`
      : ""
  const fill = {
    talks: "bg-talks text-talks-foreground",
    events: "bg-events text-events-foreground",
    primary: "bg-primary text-primary-foreground",
  }[accent]
  const band = {
    talks: "bg-talks-tint",
    events: "bg-events-tint",
    primary: "bg-accent",
  }[accent]
  const bar = { talks: "bg-talks", events: "bg-events", primary: "bg-primary" }[accent]
  const chevron =
    "inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-35 sm:size-9"

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-center gap-1">
        {onPrev && (
          <button
            type="button"
            className={chevron}
            onClick={onPrev}
            disabled={prevDisabled}
            aria-label="Previous week"
          >
            <ChevronLeftIcon aria-hidden className="size-4" />
          </button>
        )}
        <p className="flex min-w-0 flex-1 items-baseline justify-between gap-2 px-1">
          <span className="truncate font-mono text-[0.6875rem] font-medium tracking-[0.14em] uppercase">
            {termLabel}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{span}</span>
        </p>
        {onNext && (
          <button
            type="button"
            className={chevron}
            onClick={onNext}
            disabled={nextDisabled}
            aria-label="Next week"
          >
            <ChevronRightIcon aria-hidden className="size-4" />
          </button>
        )}
      </div>
      <ol
        className="grid gap-0.5"
        style={{ gridTemplateColumns: `repeat(${Math.max(1, days.length)}, minmax(0, 1fr))` }}
      >
        {days.map(({ date, count }) => {
          const isSelected = date === selected
          const inRange = range ? date >= range.first && date <= range.last : false
          const disabled = minDate !== undefined && date < minDate
          const level = densityLevel(count, max)
          const relative = today ? relativeDay(date, today) : undefined
          const spoken = `${relative ? `${relative}, ` : ""}${formatDayShort(date)}: ${count} ${count === 1 ? noun[0] : noun[1]}`
          return (
            <li
              key={date}
              className={cn(
                "min-w-0",
                inRange && band,
                inRange && (date === range?.first || date === first) && "rounded-l-xl",
                inRange && (date === range?.last || date === last) && "rounded-r-xl",
              )}
            >
              <button
                type="button"
                onClick={() => onSelect(date)}
                disabled={disabled}
                aria-pressed={isSelected}
                aria-label={spoken}
                className={cn(
                  "group relative flex min-h-[4.25rem] w-full flex-col items-center justify-center gap-0.5 rounded-xl px-0.5 py-1.5 transition-colors duration-150",
                  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
                  "disabled:cursor-default disabled:opacity-40",
                  isSelected ? fill : "hover:bg-muted",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "font-mono text-[0.625rem] tracking-wider uppercase",
                    isSelected ? "opacity-80" : "text-muted-foreground",
                  )}
                >
                  {weekdayLetter(date)}
                </span>
                <span aria-hidden className="font-serif text-xl leading-none tabular-nums">
                  {Number(date.slice(8, 10))}
                </span>
                <span
                  aria-hidden
                  className={cn(
                    "font-mono text-[0.6875rem] leading-none tabular-nums",
                    isSelected
                      ? "opacity-90"
                      : count === 0
                        ? "text-muted-foreground/70"
                        : "text-muted-foreground",
                  )}
                >
                  {count === 0 ? "–" : count}
                </span>
                <span aria-hidden className="mt-0.5 flex h-0.5 w-6 justify-center">
                  {level > 0 && (
                    <span
                      className={cn(
                        "h-full rounded-full",
                        isSelected ? "bg-current opacity-70" : bar,
                        level === 1 ? "w-2" : level === 2 ? "w-4" : "w-6",
                      )}
                    />
                  )}
                </span>
                {date === today && !isSelected && (
                  <span
                    aria-hidden
                    className={cn(
                      "absolute top-1 right-1/2 size-1 translate-x-[0.85rem] rounded-full",
                      bar,
                    )}
                  />
                )}
              </button>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
