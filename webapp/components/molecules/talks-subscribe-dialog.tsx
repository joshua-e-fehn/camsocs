"use client"

import { CalendarSyncIcon, CheckIcon, CopyIcon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { SITE_URL } from "@/lib/site"
import { feedSentence } from "@/lib/talks"
import { type TalksState, talksFeedQuery } from "@/lib/talks-url-state"
import { cn } from "@/lib/utils"

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  const id = `copy-${label.replace(/\W+/g, "-").toLowerCase()}`
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <div className="flex items-center gap-1.5">
        <input
          id={id}
          readOnly
          value={value}
          onFocus={(event) => event.currentTarget.select()}
          className="h-11 min-w-0 flex-1 rounded-lg border bg-muted/50 px-3 font-mono text-base sm:h-10 sm:text-xs"
        />
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value)
              setCopied(true)
              toast.success("Link copied")
              setTimeout(() => setCopied(false), 2000)
            } catch {
              toast.error("Could not copy: select the link and copy it")
            }
          }}
          className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-lg border bg-card px-3 text-sm font-medium transition-colors hover:border-foreground/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:h-10"
        >
          {copied ? (
            <CheckIcon aria-hidden className="size-4" />
          ) : (
            <CopyIcon aria-hidden className="size-4" />
          )}
          {copied ? "Copied" : "Copy"}
          <span className="sr-only"> the {label.toLowerCase()}</span>
        </button>
      </div>
    </div>
  )
}

const STEPS: Record<"google" | "apple" | "outlook", { name: string; steps: React.ReactNode[] }> = {
  google: {
    name: "Google",
    steps: [
      "Copy the https link above.",
      <>
        In Google Calendar on a computer, open <b>Other calendars</b> → <b>+</b> → <b>From URL</b>.
      </>,
      "Paste the link and choose Add calendar. It appears on your phone too.",
    ],
  },
  apple: {
    name: "Apple",
    steps: [
      "On an iPhone or Mac, tap Open in Calendar above (the webcal link).",
      "Confirm Subscribe; pick how often it refreshes and whether alerts stay on.",
      <>
        Or in Calendar on a Mac: <b>File</b> → <b>New Calendar Subscription</b>, and paste the link.
      </>,
    ],
  },
  outlook: {
    name: "Outlook",
    steps: [
      "Copy the https link above.",
      <>
        In Outlook on the web (your University Microsoft 365 or Outlook.com), choose{" "}
        <b>Add calendar</b> → <b>Subscribe from web</b>.
      </>,
      "Paste the link, give it a name such as “Talks”, and Import.",
    ],
  },
}

/**
 * "Subscribe": the current /talks filters as a live calendar feed
 * (`/talks.ics`, the next 60 days, refreshed by the calendar app). A
 * sentence says what the feed holds ("All talks in Computer Science"), then
 * an Open in Calendar button (`webcal://`), the https link with Copy, and
 * three short provider guides. The feed carries the filters, not the dates.
 */
export function TalksSubscribeDialog({
  state,
  departmentName,
  trigger,
}: {
  state: TalksState
  /** The chosen department's short name, for the sentence. */
  departmentName?: string
  trigger: React.ReactNode
}) {
  // The canonical origin, as the talk pages use it, not the address this tab
  // happens to be on: a feed subscribed from an old host would rely on every
  // calendar following the redirect on each refresh.
  const query = talksFeedQuery(state)
  const https = `${SITE_URL}/talks.ics${query}`
  const webcal = `webcal://${new URL(SITE_URL).host}/talks.ics${query}`
  const sentence = feedSentence(state, departmentName)

  return (
    <Dialog>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[92svh] gap-5 overflow-y-auto sm:max-w-lg">
        <DialogHeader className="gap-2 text-left">
          <p className="font-mono text-[0.6875rem] tracking-[0.14em] text-talks uppercase">
            Calendar feed
          </p>
          <DialogTitle className="font-serif text-2xl leading-tight font-normal">
            Get these talks in your calendar
          </DialogTitle>
          <DialogDescription className="text-[0.9375rem] leading-relaxed text-foreground">
            {sentence.map((part, index) =>
              part.strong ? (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: a fixed sentence, in order
                  key={index}
                  className="rounded-sm bg-talks-tint px-1 py-px font-medium text-talks"
                >
                  {part.text}
                </span>
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: a fixed sentence, in order
                <span key={index}>{part.text}</span>
              ),
            )}
            <span>, for the next 60 days, kept up to date as talks are added or cancelled.</span>
          </DialogDescription>
        </DialogHeader>

        <a
          href={webcal}
          className={cn(
            "inline-flex h-11 items-center justify-center gap-2 rounded-full bg-talks px-5 text-sm font-medium text-talks-foreground transition-colors hover:bg-talks/90",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          )}
        >
          <CalendarSyncIcon aria-hidden className="size-4" />
          Open in Calendar
        </a>

        <div className="flex flex-col gap-3">
          <CopyField label="Feed link" value={https} />
          <CopyField label="Subscription link (webcal)" value={webcal} />
        </div>

        <Tabs defaultValue="google" className="gap-3">
          <TabsList className="w-full group-data-horizontal/tabs:h-auto">
            {(Object.keys(STEPS) as (keyof typeof STEPS)[]).map((provider) => (
              <TabsTrigger
                key={provider}
                value={provider}
                className="min-h-11 text-muted-foreground sm:min-h-9"
              >
                {STEPS[provider].name}
              </TabsTrigger>
            ))}
          </TabsList>
          {(Object.keys(STEPS) as (keyof typeof STEPS)[]).map((provider) => (
            <TabsContent key={provider} value={provider}>
              <ol className="flex flex-col gap-2 text-sm">
                {STEPS[provider].steps.map((step, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: fixed steps, in order
                  <li key={index} className="grid grid-cols-[1.5rem_1fr] gap-2">
                    <span className="font-serif text-base leading-5 text-talks">{index + 1}.</span>
                    <span className="leading-5 text-pretty">{step}</span>
                  </li>
                ))}
              </ol>
            </TabsContent>
          ))}
        </Tabs>

        <p className="text-xs text-muted-foreground">
          Calendar apps refresh feeds on their own schedule — Google can take a day; Apple and
          Outlook let you choose. Nothing about you is stored: the link holds only these filters.
        </p>
      </DialogContent>
    </Dialog>
  )
}
