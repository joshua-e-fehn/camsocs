"use client"

import { InfoIcon, TriangleAlertIcon } from "lucide-react"
import { SourceLine } from "@/components/molecules/source-line"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { hasValue, type PublicFieldMeta } from "@/lib/source-line"
import { cn } from "@/lib/utils"

export type SourcedFact = { label: string; meta: PublicFieldMeta | undefined }

/**
 * Provenance, compact: one quiet "Sourced" chip per section that opens a
 * popover listing each of the section's facts with its full SourceLine —
 * status, source, date read, confidence and any disagreeing readings. Every
 * fact keeps its source; it is just one tap away instead of under every
 * line. A section whose sources disagree says so on the chip itself.
 * Renders nothing when no fact in the section has a value.
 */
export function SourcedChip({
  section,
  facts,
  className,
}: {
  /** The section's name, for the button's label ("Sources for About"). */
  section: string
  facts: SourcedFact[]
  className?: string
}) {
  const known = facts.filter((fact) => hasValue(fact.meta))
  if (known.length === 0) return null
  const conflicting = known.some((fact) => fact.meta?.status === "conflicting")
  const Icon = conflicting ? TriangleAlertIcon : InfoIcon
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Sources for ${section}`}
          className={cn(
            "relative inline-flex h-7 shrink-0 items-center gap-1 rounded-full border px-2.5 text-xs after:absolute after:inset-x-0 after:-inset-y-2 text-muted-foreground transition-colors duration-150 hover:border-foreground/30 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            conflicting && "border-warning-foreground/40 text-foreground",
            className,
          )}
        >
          <Icon aria-hidden className="size-3.5" />
          {conflicting ? "Sources disagree" : "Sourced"}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(24rem,calc(100vw-2rem))] p-0">
        <div className="border-b px-4 py-3">
          <p className="text-sm font-medium">Where {section.toLowerCase()} comes from</p>
          <p className="text-xs text-muted-foreground">
            Read from public sources; confidence is computed by rule.
          </p>
        </div>
        <dl className="flex max-h-80 flex-col divide-y overflow-y-auto">
          {known.map((fact) => (
            <div key={fact.label} className="flex flex-col gap-1 px-4 py-2.5">
              <dt className="text-xs font-medium">{fact.label}</dt>
              <dd>
                <SourceLine meta={fact.meta} />
              </dd>
            </div>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  )
}
