import { barWidth } from "@/lib/college-wealth"
import { cn } from "@/lib/utils"

/**
 * One row's bar on /colleges/wealth: its width is the value over the table's
 * scale (lib/college-wealth.ts `barScale`). A bar past the scale is drawn
 * full with a break in it and says so to screen readers; a negative value
 * (a fall over the year) is grey, and its number beside it carries the sign,
 * so colour is never the only cue. Decorative otherwise: the number is the
 * fact.
 */
export function CollegeWealthBar({ value, scale }: { value: number; scale: number }) {
  const { fraction, cut } = barWidth(value, scale)
  return (
    <span className="relative block h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-0 rounded-full",
          value < 0 ? "bg-muted-foreground/45" : "bg-brand",
        )}
        style={{ width: `${(fraction * 100).toFixed(1)}%` }}
      />
      {cut && (
        <>
          <span
            aria-hidden
            className="absolute inset-y-[-2px] right-5 w-1 -skew-x-[30deg] bg-background"
          />
          <span
            aria-hidden
            className="absolute inset-y-[-2px] right-3.5 w-1 -skew-x-[30deg] bg-background"
          />
          <span className="sr-only">(bar cut off; see the note under the table)</span>
        </>
      )}
    </span>
  )
}
