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
  accent = "primary",
}: {
  label: string
  options: FacetOption[]
  selected: readonly string[]
  onToggle: (value: string, checked: boolean) => void
  /** The pillar colour of a filter that is on: Societies sage, Events brick. */
  accent?: "primary" | "events"
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn(
            "h-9 font-normal",
            accent === "events" && "rounded-full bg-card",
            selected.length > 0 &&
              (accent === "events"
                ? "border-events bg-events-tint text-events"
                : "border-primary/40"),
          )}
        >
          {label}
          {selected.length > 0 && (
            <span
              className={cn(
                "rounded px-1 font-mono text-[11px] tabular-nums",
                accent === "events"
                  ? "bg-events text-events-foreground"
                  : "bg-primary text-primary-foreground",
              )}
            >
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
