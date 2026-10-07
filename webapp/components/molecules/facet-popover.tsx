"use client"

import { ChevronDownIcon } from "lucide-react"
import { FacetList, type FacetOption } from "@/components/molecules/facet-list"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

/** A compact multi-select filter: a button naming the filter and how many
 * values are ticked, opening the checkbox list. */
export function FacetPopover({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string
  options: FacetOption[]
  selected: readonly string[]
  onToggle: (value: string, checked: boolean) => void
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn("h-9 font-normal", selected.length > 0 && "border-primary/40")}
        >
          {label}
          {selected.length > 0 && (
            <span className="rounded bg-primary px-1 font-mono text-[11px] text-primary-foreground tabular-nums">
              {selected.length}
            </span>
          )}
          <ChevronDownIcon data-icon="inline-end" className="opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-96 w-64 overflow-y-auto">
        <FacetList legend={label} options={options} selected={selected} onToggle={onToggle} />
      </PopoverContent>
    </Popover>
  )
}
