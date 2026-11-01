"use client"

import { ArrowUpDownIcon } from "lucide-react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ORG_SORT_LABELS, type OrgSort } from "@/lib/directory-sort"
import { cn } from "@/lib/utils"

/** The directory's order: a compact select that reads "A–Z" and offers the
 * orders that make sense now (`options`; "Best match" only with a query). */
export function SortSelect({
  value,
  options,
  onChange,
  className,
}: {
  value: OrgSort
  options: readonly OrgSort[]
  onChange: (sort: OrgSort) => void
  className?: string
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as OrgSort)}>
      <SelectTrigger
        aria-label="Sort societies"
        className={cn(
          "shrink-0 rounded-full bg-card pl-3 text-[13px] data-[size=default]:h-11 sm:data-[size=default]:h-8",
          className,
        )}
      >
        <ArrowUpDownIcon aria-hidden className="size-3.5 text-muted-foreground" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end" position="popper">
        {options.map((sort) => (
          <SelectItem key={sort} value={sort}>
            {ORG_SORT_LABELS[sort]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
