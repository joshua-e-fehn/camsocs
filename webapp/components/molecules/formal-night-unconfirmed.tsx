"use client"

import { InfoIcon } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

/**
 * The "not confirmed" marker on a formal night no page states night by night
 * (`confidence: "inferred"`, lib/colleges.ts): a small button whose popover
 * gives the reason, so it opens on a tap as well as a click (a tooltip would
 * not on a phone). The word is always shown; colour is never the only signal.
 */
export function FormalNightUnconfirmed({ college, reason }: { college: string; reason: string }) {
  return (
    <Popover>
      <PopoverTrigger
        className="inline-flex min-h-11 items-center gap-1 rounded-sm font-mono text-xs text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring sm:min-h-6"
        aria-label={`${college}: not confirmed. Why?`}
      >
        <InfoIcon aria-hidden className="size-3.5" />
        not confirmed
      </PopoverTrigger>
      <PopoverContent align="start" className="text-sm">
        <p className="font-medium">Not confirmed night by night</p>
        <p className="text-muted-foreground">{reason}</p>
      </PopoverContent>
    </Popover>
  )
}
