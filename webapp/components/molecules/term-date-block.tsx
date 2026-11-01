import { londonIsoDate, monthShort, weekdayShort } from "@/lib/calendar"
import { cn } from "@/lib/utils"

/** "MT26 Wk 4" → "Wk 4"; undefined for anything else. */
export function termWeekShort(label: string | undefined): string | undefined {
  const match = label?.match(/Wk\s*(\d+)$/)
  return match ? `Wk ${match[1]}` : undefined
}

/**
 * A date as a small calendar block: the term week in the coloured band
 * ("WK 4", or the month out of term), the day number in the serif and the
 * weekday under it. `sm` is the directory card's chip; `lg` a detail page's
 * tile. `accent` is the pillar's colour (Events brick by default, Talks
 * indigo). Decorative to screen readers: the caller states the date in words
 * (`label`).
 */
export function TermDateBlock({
  startsAt,
  termWeekLabel,
  size = "md",
  accent = "events",
  label,
  className,
}: {
  startsAt: number
  termWeekLabel?: string
  size?: "sm" | "md" | "lg"
  accent?: "events" | "talks"
  /** Read out instead of the block, e.g. "Next event: Thu 5 Nov". */
  label?: string
  className?: string
}) {
  const day = londonIsoDate(startsAt)
  const band = termWeekShort(termWeekLabel) ?? monthShort(day)
  return (
    <span
      className={cn(
        "inline-flex shrink-0 flex-col overflow-hidden rounded-md border bg-card text-center leading-none",
        size === "sm" ? "w-11" : size === "lg" ? "w-[4.5rem]" : "w-14",
        className,
      )}
    >
      {label && <span className="sr-only">{label}</span>}
      <span
        aria-hidden
        className={cn(
          "font-mono tracking-wider uppercase",
          accent === "talks"
            ? "bg-talks text-talks-foreground"
            : "bg-events text-events-foreground",
          size === "sm" ? "py-0.5 text-[10px]" : "py-1 text-[11px]",
        )}
      >
        {band}
      </span>
      <span
        aria-hidden
        className={cn(
          "font-serif font-medium tabular-nums",
          size === "sm" ? "pt-1 text-lg" : size === "lg" ? "pt-2 text-[2rem]" : "pt-1.5 text-2xl",
        )}
      >
        {Number(day.slice(8, 10))}
      </span>
      <span
        aria-hidden
        className={cn(
          "font-mono tracking-wider text-muted-foreground uppercase",
          size === "sm" ? "pb-1 text-[10px]" : "pb-1.5 text-[11px]",
        )}
      >
        {weekdayShort(day)}
      </span>
    </span>
  )
}
