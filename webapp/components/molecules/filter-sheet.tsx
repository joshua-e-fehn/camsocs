"use client"

import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

/**
 * The phone's filter panel: a bottom sheet with a grab handle, the live
 * number of matches, the filter groups (`children`) and a sticky footer —
 * "Clear all" and "Show 37 societies". The caller keeps a draft while it is
 * open and applies it on "Show", so the page re-queries once, not per tap.
 */
export function FilterSheet({
  open,
  onOpenChange,
  trigger,
  count,
  noun,
  onApply,
  onClear,
  clearDisabled,
  selected,
  accent = "primary",
  rule = "any value within a group, all groups together",
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  trigger: React.ReactNode
  /** Matches for the draft; undefined while it is being counted. */
  count: number | undefined
  /** [singular, plural]: ["society", "societies"]. */
  noun: [string, string]
  onApply: () => void
  onClear: () => void
  clearDisabled: boolean
  /** The draft's chips, under the title. */
  selected?: React.ReactNode
  /** The pillar colour of "Show N": Societies sage, Events brick, Talks indigo. */
  accent?: "primary" | "events" | "talks"
  /** How the groups combine, after the count; the default suits multi-select
   * groups (societies, events). */
  rule?: string
  children: React.ReactNode
}) {
  const word = count === 1 ? noun[0] : noun[1]
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      <SheetContent
        side="bottom"
        className="max-h-[92svh] gap-0 rounded-t-2xl border-x-0 bg-background"
      >
        <div aria-hidden className="mx-auto mt-2.5 h-1 w-10 rounded-full bg-muted-foreground/30" />
        <SheetHeader className="gap-1 border-b pt-2 pb-3">
          <SheetTitle className="font-serif text-xl">Filters</SheetTitle>
          <SheetDescription aria-live="polite">
            {count === undefined ? (
              "Counting…"
            ) : (
              <>
                <span className="font-mono text-foreground tabular-nums">{count}</span> {word} match
                {count === 1 ? "es" : ""} · {rule}
              </>
            )}
          </SheetDescription>
          {selected}
        </SheetHeader>
        <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-5">{children}</div>
        <SheetFooter className="flex-row items-center gap-2 border-t bg-background pb-[max(1rem,env(safe-area-inset-bottom))]">
          <Button variant="ghost" className="h-11" disabled={clearDisabled} onClick={onClear}>
            Clear all
          </Button>
          <Button
            className={cn(
              "h-11 flex-1",
              accent === "events" && "bg-events text-events-foreground hover:bg-events/90",
              accent === "talks" && "bg-talks text-talks-foreground hover:bg-talks/90",
            )}
            onClick={onApply}
            disabled={count === 0}
          >
            {count === undefined ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <>
                Show <span className="font-mono tabular-nums">{count}</span> {word}
              </>
            )}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
