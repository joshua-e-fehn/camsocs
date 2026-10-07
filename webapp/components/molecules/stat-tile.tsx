import { cn } from "@/lib/utils"

/**
 * One metric: a label, a large monospaced value and an optional hint, on a
 * card with a left accent stripe (DESIGN.md "Cards": data cards).
 */
export function StatTile({
  label,
  value,
  hint,
  emphasis = false,
  className,
}: {
  label: string
  value: React.ReactNode
  hint?: React.ReactNode
  /** The one highlighted metric of a row. */
  emphasis?: boolean
  className?: string
}) {
  return (
    <div
      className={cn(
        "relative flex flex-col gap-1 overflow-hidden rounded-xl border bg-card p-4 pl-5 text-card-foreground shadow-sm transition-colors duration-200 hover:border-primary/20",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn("absolute inset-y-0 left-0 w-1", emphasis ? "bg-primary" : "bg-border")}
      />
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </span>
      <span className="font-mono text-2xl font-semibold tabular-nums">{value}</span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  )
}
