"use client"

import { CheckIcon } from "lucide-react"
import type { FacetOption } from "@/components/molecules/facet-list"
import { cn } from "@/lib/utils"

/**
 * A small closed filter group as a wrap of toggle chips, each with the number
 * of results it would give (OR within the group): denser than checkboxes yet
 * a full tap target in the phone sheet. An option with no results stays in
 * view, greyed and inert, so a student can see that it exists here but
 * nothing matches now; a selected one can always be turned off.
 */
export function FacetChips({
  legend,
  options,
  selected,
  onToggle,
  className,
}: {
  legend: string
  options: FacetOption[]
  selected: readonly string[]
  onToggle: (value: string, checked: boolean) => void
  className?: string
}) {
  return (
    <fieldset className={cn("flex flex-col gap-2", className)}>
      <legend className="mb-2 text-xs font-medium tracking-wider text-muted-foreground uppercase">
        {legend}
      </legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => {
          const checked = selected.includes(option.value)
          const empty = option.count === 0 && !checked
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={checked}
              disabled={empty}
              onClick={() => onToggle(option.value, !checked)}
              className={cn(
                "inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-left text-sm transition-colors duration-150 lg:min-h-8 lg:px-2.5 lg:text-[13px]",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                checked
                  ? "border-foreground bg-foreground text-background"
                  : "bg-card hover:border-foreground/40",
                empty && "cursor-not-allowed border-dashed bg-transparent text-muted-foreground/70",
              )}
            >
              {checked && <CheckIcon aria-hidden className="size-3.5 shrink-0" />}
              <span>{option.label}</span>
              {option.count !== undefined && (
                <span
                  className={cn(
                    "font-mono text-xs tabular-nums",
                    checked ? "text-background/75" : "text-muted-foreground",
                  )}
                >
                  {option.count}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </fieldset>
  )
}
