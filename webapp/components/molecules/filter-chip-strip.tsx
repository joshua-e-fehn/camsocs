import { XIcon } from "lucide-react"
import { cn } from "@/lib/utils"

export type AppliedChip = { key: string; label: string; onRemove: () => void }
export type QuickChip = { key: string; label: string; onSelect: () => void }

/**
 * One sideways-scrolling row of filter chips under the search: the filters
 * that are on first, as dark chips with × that each drop one value, then a
 * few quick filters as outline chips, then "Clear". It never wraps on a
 * phone; `leading` holds the "Filters · n" button that opens the full panel.
 */
export function FilterChipStrip({
  applied,
  quick,
  leading,
  onClear,
  className,
}: {
  applied: AppliedChip[]
  quick: QuickChip[]
  leading?: React.ReactNode
  onClear?: () => void
  className?: string
}) {
  const chip =
    "inline-flex h-11 shrink-0 items-center gap-1 rounded-full border px-3 text-[13px] whitespace-nowrap transition-colors sm:h-8 duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
  return (
    <div
      className={cn(
        "-mx-4 flex items-center gap-1.5 overflow-x-auto px-4 py-0.5 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden",
        className,
      )}
    >
      {leading}
      {applied.map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={item.onRemove}
          aria-label={`Remove filter: ${item.label}`}
          className={cn(chip, "border-foreground bg-foreground pr-2 text-background")}
        >
          {item.label}
          <XIcon aria-hidden className="size-3.5 opacity-80" />
        </button>
      ))}
      {quick.map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={item.onSelect}
          className={cn(chip, "bg-card hover:border-foreground/40")}
        >
          {item.label}
        </button>
      ))}
      {onClear && (
        <button
          type="button"
          onClick={onClear}
          className="inline-flex h-11 shrink-0 items-center px-2 text-[13px] sm:h-8 whitespace-nowrap text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        >
          Clear all
        </button>
      )}
    </div>
  )
}
