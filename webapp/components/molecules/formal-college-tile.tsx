"use client"

import { CheckIcon, PencilLineIcon } from "lucide-react"
import { CollegeCrest } from "@/components/molecules/college-crest"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import type { CollegeRef } from "@/lib/colleges"
import { cn } from "@/lib/utils"

/**
 * One college in the tracker's crest grid: press the crest to tick or untick
 * it, "Details" for the date, count and notes. The state is an icon and a
 * word, never the colour alone.
 */
export function FormalCollegeTile({
  college,
  ticked,
  visits,
  pending,
  onToggle,
  onOpen,
}: {
  college: CollegeRef
  ticked: boolean
  visits: number
  pending: boolean
  onToggle: () => void
  onOpen: () => void
}) {
  return (
    <li
      className={cn(
        "flex flex-col items-center gap-1 rounded-xl border p-2 text-center transition-colors duration-150",
        ticked ? "border-brand bg-muted" : "hover:border-foreground/20",
      )}
    >
      <button
        type="button"
        aria-pressed={ticked}
        aria-label={`${college.name}${ticked && visits > 1 ? `, ${visits} formals` : ""}`}
        aria-busy={pending}
        disabled={pending}
        onClick={onToggle}
        className="flex min-h-11 w-full flex-col items-center gap-2 rounded-lg px-1 pt-2 pb-1 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-70"
      >
        <CollegeCrest
          crest={college.crest}
          size={48}
          decorative
          className={cn(
            "transition-[filter,opacity] duration-200",
            !ticked && "opacity-55 grayscale",
          )}
        />
        <span className="text-sm leading-tight font-medium text-balance">{college.shortName}</span>
        <span
          className={cn(
            "inline-flex items-center gap-1 font-mono text-xs tabular-nums",
            ticked ? "text-brand-text" : "text-muted-foreground",
          )}
        >
          {pending ? (
            <Spinner className="size-3" />
          ) : ticked ? (
            <CheckIcon aria-hidden className="size-3" />
          ) : null}
          {ticked ? (visits > 1 ? `Been ×${visits}` : "Been") : "Not yet"}
        </span>
      </button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="min-h-11 sm:min-h-0"
        onClick={onOpen}
        aria-label={`Details for ${college.name}`}
      >
        <PencilLineIcon data-icon="inline-start" aria-hidden />
        Details
      </Button>
    </li>
  )
}
