"use client"

import { SearchIcon } from "lucide-react"
import { useId, useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

export type FacetOption = { value: string; label: string; count?: number }

/**
 * A multi-select filter group: checkboxes with the number of results each
 * would give (OR within the group). Options with no results are hidden unless
 * selected, so the list only offers choices that lead somewhere — or, with
 * `showEmpty`, shown greyed; long lists fold after `collapseAfter` (8).
 * `searchable` adds a filter box over the options (the 31 colleges). Rows are
 * 44 px tall below `lg` (the filter sheet on a phone), 28 px beside the
 * desktop grid.
 */
export function FacetList({
  legend,
  options,
  selected,
  onToggle,
  collapseAfter = 8,
  searchable = false,
  showEmpty = false,
  className,
}: {
  legend: string
  options: FacetOption[]
  selected: readonly string[]
  onToggle: (value: string, checked: boolean) => void
  collapseAfter?: number
  searchable?: boolean
  showEmpty?: boolean
  className?: string
}) {
  const id = useId()
  const [expanded, setExpanded] = useState(false)
  const [filter, setFilter] = useState("")
  const words = filter.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const visible = options.filter(
    (option) =>
      (showEmpty ||
        option.count === undefined ||
        option.count > 0 ||
        selected.includes(option.value)) &&
      words.every((word) => option.label.toLowerCase().includes(word)),
  )
  // Selected options first in a long list, so a choice never hides behind the fold.
  const ordered = searchable
    ? [
        ...visible.filter((option) => selected.includes(option.value)),
        ...visible.filter((option) => !selected.includes(option.value)),
      ]
    : visible
  const shown = expanded || words.length > 0 ? ordered : ordered.slice(0, collapseAfter)

  return (
    <fieldset className={cn("flex flex-col gap-2", className)}>
      <legend className="mb-1 text-xs font-medium tracking-wider text-muted-foreground uppercase">
        {legend}
      </legend>
      {searchable && (
        <InputGroup className="mb-1 h-11 lg:h-8">
          <InputGroupAddon>
            <SearchIcon aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            aria-label={`Filter ${legend.toLowerCase()}`}
            placeholder={`Find a ${legend.toLowerCase()}`}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </InputGroup>
      )}
      {visible.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {words.length > 0 ? "No match" : "No values yet"}
        </p>
      )}
      {shown.map((option) => {
        const inputId = `${id}-${option.value}`
        const checked = selected.includes(option.value)
        const empty = option.count === 0 && !checked
        return (
          <div
            key={option.value}
            className={cn(
              "flex min-h-11 items-center gap-2.5 lg:min-h-7",
              empty && "text-muted-foreground",
            )}
          >
            <Checkbox
              id={inputId}
              checked={checked}
              disabled={empty}
              onCheckedChange={(value) => onToggle(option.value, value === true)}
            />
            <Label
              htmlFor={inputId}
              className={cn(
                "flex-1 cursor-pointer text-sm font-normal",
                empty && "cursor-not-allowed",
              )}
            >
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
      {visible.length > collapseAfter && words.length === 0 && (
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
