"use client"

import { CalendarPlusIcon, ChevronDownIcon, DownloadIcon } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { track } from "@/lib/analytics"
import { cn } from "@/lib/utils"

export type CalendarLinks = {
  /** Google Calendar's template link. */
  google: string
  /** An `.ics` file of the one item (Apple Calendar, desktop Outlook). */
  ics: string
  /** Outlook on the web, personal accounts (outlook.live.com). */
  outlook: string
  /** Outlook on the web, work and University accounts (outlook.office.com). */
  office365?: string
}

/**
 * "Add to calendar ▾": one talk or event into the viewer's own calendar — Google,
 * Apple or desktop Outlook (an `.ics` download), or Outlook on the web
 * (personal, or a University Microsoft 365 account). Nothing is stored and
 * nobody signs in here: each choice is a plain link. Choosing one sends
 * `calendar_subscribe_clicked` with the item's key (only with analytics
 * consent, lib/analytics.ts).
 */
export function AddToCalendar({
  links,
  primary = true,
  className,
  label = "Add to calendar",
  accent = "talks",
  noun = "talk",
  item,
}: {
  links: CalendarLinks
  primary?: boolean
  className?: string
  label?: string
  /** The pillar colour of the primary button: Talks indigo or Events brick. */
  accent?: "talks" | "events"
  /** What is being added, for the menu's heading ("Add this event to…"). */
  noun?: string
  /** The talk or event, for `calendar_subscribe_clicked` (its key only). */
  item?: { feed: "event" | "talk"; key: string }
}) {
  const external = { target: "_blank", rel: "noopener noreferrer nofollow" } as const
  const onChoose = () => {
    if (item) track("calendar_subscribe_clicked", item)
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-11 items-center justify-center gap-2 rounded-full border px-4 text-sm font-medium whitespace-nowrap transition-colors duration-150 sm:h-10",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            primary
              ? accent === "events"
                ? "border-events bg-events text-events-foreground hover:bg-events/90"
                : "border-talks bg-talks text-talks-foreground hover:bg-talks/90"
              : "bg-card hover:border-foreground/40",
            className,
          )}
        >
          <CalendarPlusIcon aria-hidden className="size-4" />
          {label}
          <ChevronDownIcon aria-hidden className="size-3.5 opacity-75" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-60">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Add this {noun} to…
        </DropdownMenuLabel>
        <DropdownMenuItem asChild className="min-h-11 sm:min-h-10">
          <a href={links.google} {...external} onClick={onChoose}>
            Google Calendar
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild className="min-h-11 sm:min-h-10">
          <a href={links.ics} download onClick={onChoose}>
            <DownloadIcon aria-hidden />
            Apple Calendar or Outlook (.ics)
          </a>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild className="min-h-11 sm:min-h-10">
          <a href={links.outlook} {...external} onClick={onChoose}>
            Outlook.com
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </DropdownMenuItem>
        {links.office365 && (
          <DropdownMenuItem asChild className="min-h-11 sm:min-h-10">
            <a href={links.office365} {...external} onClick={onChoose}>
              Microsoft 365 (University account)
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
