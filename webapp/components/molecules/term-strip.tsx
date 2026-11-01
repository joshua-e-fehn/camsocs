import Link from "next/link"
import { formatDayShort } from "@/lib/calendar"
import {
  TERM_NAMES,
  type TermClock,
  termClockLabel,
  termClockParts,
  weekOfTerm,
} from "@/lib/term-week"

/**
 * The term clock strip above the header (spec §5 "Motifs"): "MICH · WK 4 ·
 * SAT 31 OCT", or "VACATION · LENT STARTS IN 9 WEEKS". Server-rendered from
 * `termDates`; nothing at all when the dates could not be read.
 */
export function TermStrip({ clock }: { clock: TermClock | null }) {
  if (!clock) return null
  const parts = termClockParts(clock)
  const detail =
    clock.kind === "term"
      ? `${TERM_NAMES[clock.term]} ${clock.fullTermStart.slice(0, 4)} · ${weekOfTerm(clock.week)} · Full Term ends ${formatDayShort(clock.fullTermEnd)}`
      : clock.next
        ? `${TERM_NAMES[clock.next.term]} Full Term starts ${formatDayShort(clock.next.fullTermStart)}`
        : undefined
  // A landmark of its own: it sits above the header, and content outside every
  // landmark fails axe `region` on every page.
  return (
    <aside
      aria-label="Term dates"
      className="border-b border-primary/10 bg-accent text-accent-foreground"
    >
      <div className="mx-auto flex h-7 w-full max-w-7xl items-center gap-4 px-4 font-mono text-[0.6875rem] tracking-[0.14em] uppercase sm:px-6">
        <p className="flex min-w-0 items-center gap-2" title={termClockLabel(clock)}>
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />
          {parts.map((part, index) => (
            <span key={part} className="flex items-center gap-2 whitespace-nowrap">
              {index > 0 && (
                <span aria-hidden className="text-primary/50">
                  ·
                </span>
              )}
              <span className={index === 0 ? "font-semibold text-primary" : undefined}>{part}</span>
            </span>
          ))}
        </p>
        {detail && (
          <p className="ml-auto hidden truncate text-muted-foreground normal-case tracking-normal md:block">
            {detail}
            {" · "}
            <Link
              href="/events"
              className="underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
            >
              What&apos;s on
            </Link>
          </p>
        )}
      </div>
    </aside>
  )
}
