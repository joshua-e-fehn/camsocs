import { SCHOOL_TONE, TALK_SCHOOL_SHORT } from "@/lib/talks"
import { cn } from "@/lib/utils"
import { TALK_SCHOOL_LABELS, TALK_SCHOOLS, type TalkSchool } from "@/lib/vocab"

/**
 * The seven Schools as one rail of pills (talks-redesign-spec §6): "All" and
 * then each School with its colour mark and its count of upcoming talks.
 * One tap narrows a few hundred talks to the few dozen that matter; the
 * department picker follows the School chosen here. It scrolls sideways
 * edge to edge on a phone, with a fade at the right edge.
 */
export function SchoolRail({
  value,
  onChange,
  counts,
  total,
  className,
}: {
  value?: TalkSchool
  onChange: (school: TalkSchool | undefined) => void
  /** Upcoming talks per School (the next four weeks). */
  counts?: Partial<Record<TalkSchool, number>>
  total?: number
  className?: string
}) {
  const pill =
    "inline-flex h-11 shrink-0 snap-start items-center gap-2 rounded-full border px-3.5 text-[13px] whitespace-nowrap transition-colors duration-150 sm:h-9 lg:px-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
  return (
    <div className={cn("relative", className)}>
      <fieldset className="-mx-4 flex min-w-0 snap-x scroll-px-4 items-center gap-1.5 overflow-x-auto px-4 py-1 [scrollbar-width:none] sm:-mx-6 sm:scroll-px-6 sm:px-6 lg:mx-0 lg:flex-wrap lg:px-0 [&::-webkit-scrollbar]:hidden">
        <legend className="sr-only">School</legend>
        <button
          type="button"
          aria-pressed={value === undefined}
          onClick={() => onChange(undefined)}
          className={cn(
            pill,
            value === undefined
              ? "border-foreground bg-foreground font-medium text-background"
              : "bg-card hover:border-foreground/40",
          )}
        >
          All Schools
          {total !== undefined && (
            <span className="font-mono text-[0.6875rem] tabular-nums opacity-75">{total}</span>
          )}
        </button>
        {TALK_SCHOOLS.map((school) => {
          const tone = SCHOOL_TONE[school]
          const selected = value === school
          const count = counts?.[school]
          return (
            <button
              key={school}
              type="button"
              aria-pressed={selected}
              title={TALK_SCHOOL_LABELS[school]}
              onClick={() => onChange(selected ? undefined : school)}
              className={cn(
                pill,
                selected
                  ? cn(tone.chip, tone.border, "font-medium")
                  : "bg-card hover:border-foreground/40",
              )}
            >
              <span aria-hidden className={cn("size-2 shrink-0 rounded-full", tone.dot)} />
              {TALK_SCHOOL_SHORT[school]}
              {count !== undefined && (
                <span
                  className={cn(
                    "font-mono text-[0.6875rem] tabular-nums",
                    // Full ink when selected: faded on the School tint it fell
                    // below 4.5:1 (axe, light mode).
                    !selected && "text-muted-foreground",
                  )}
                >
                  {count}
                </span>
              )}
            </button>
          )
        })}
      </fieldset>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 -right-4 w-10 bg-linear-to-l from-background to-transparent sm:-right-6 lg:hidden"
      />
    </div>
  )
}
