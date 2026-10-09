"use client"

import { useId, useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

export type FacetOption = { value: string; label: string; count?: number }

/**
 * A multi-select filter group: checkboxes with the number of results each
 * would give (OR within the group). Options with no results are hidden unless
 * selected, so the list only offers choices that lead somewhere; long lists
 * fold after `collapseAfter` (8). Rows are 36 px tall below `lg` (the filter
 * sheet on a phone), 28 px beside the desktop grid.
 */
export function FacetList({
  legend,
  options,
  selected,
  onToggle,
  collapseAfter = 8,
  className,
}: {
  legend: string
  options: FacetOption[]
  selected: readonly string[]
  onToggle: (value: string, checked: boolean) => void
  collapseAfter?: number
  className?: string
}) {
  const id = useId()
  const [expanded, setExpanded] = useState(false)
  const visible = options.filter(
    (option) => option.count === undefined || option.count > 0 || selected.includes(option.value),
  )
  const shown = expanded ? visible : visible.slice(0, collapseAfter)

  return (
    <fieldset className={cn("flex flex-col gap-2", className)}>
      <legend className="mb-1 text-xs font-medium tracking-wider text-muted-foreground uppercase">
        {legend}
      </legend>
      {visible.length === 0 && <p className="text-sm text-muted-foreground">No values yet</p>}
      {shown.map((option) => {
        const inputId = `${id}-${option.value}`
        const checked = selected.includes(option.value)
        return (
          <div key={option.value} className="flex min-h-9 items-center gap-2.5 lg:min-h-7">
            <Checkbox
              id={inputId}
              checked={checked}
              onCheckedChange={(value) => onToggle(option.value, value === true)}
            />
            <Label htmlFor={inputId} className="flex-1 cursor-pointer text-sm font-normal">
              {option.label}
            </Label>
            {option.count !== undefined && (
              <span className="font-mono text-xs text-muted-foreground tabular-nums">
                {option.count}
              </span>
            )}
          </div>
        )
      })}
      {visible.length > collapseAfter && (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto self-start px-0"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          {expanded ? "Show fewer" : `Show all ${visible.length}`}
        </Button>
      )}
    </fieldset>
  )
}
