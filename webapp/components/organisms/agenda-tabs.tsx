"use client"

import { ArrowRightIcon } from "lucide-react"
import Link from "next/link"
import { Tabs as TabsPrimitive } from "radix-ui"
import { useState } from "react"
import { cn } from "@/lib/utils"

/**
 * The home page's "This week" switch between pillars (spec §6 "Home": Events
 * | Talks). Each tab's content is rendered on the server and passed in, so
 * the first tab is complete HTML without JavaScript. With a single tab (the
 * talks module unreadable) there is no tab bar, just a pillar label, so
 * nothing pretends to switch.
 *
 * `heading` is the section's own heading block; beside it sits the open
 * tab's `link` ("The full calendar" for Events, "All talks" for Talks), so
 * the header link follows the tab. Without JavaScript it is the first tab's.
 */

export type AgendaTab = {
  id: string
  label: string
  /** The pillar colour of the tab's mark. */
  accent: "events" | "talks"
  /** Shown beside the label, e.g. this week's total. */
  count?: number
  /** The pillar page, shown beside the heading while this tab is open. */
  link?: { href: string; label: string }
  content: React.ReactNode
}

const MARK = { events: "bg-events", talks: "bg-talks" } as const
const INK = { events: "text-events", talks: "text-talks" } as const

function Header({ heading, tab }: { heading?: React.ReactNode; tab: AgendaTab }) {
  if (!heading && !tab.link) return null
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      {heading}
      {tab.link && (
        <Link
          href={tab.link.href}
          className={cn(
            "inline-flex min-h-11 items-center gap-1 text-sm font-medium transition-colors hover:underline hover:underline-offset-4",
            INK[tab.accent],
          )}
        >
          {tab.link.label}
          <ArrowRightIcon aria-hidden className="size-4" />
        </Link>
      )}
    </div>
  )
}

function Label({ tab }: { tab: AgendaTab }) {
  return (
    <>
      <span aria-hidden className={cn("size-2 rounded-full", MARK[tab.accent])} />
      {tab.label}
      {tab.count !== undefined && (
        <span className="font-mono text-xs text-muted-foreground tabular-nums">{tab.count}</span>
      )}
    </>
  )
}

export function AgendaTabs({ tabs, heading }: { tabs: AgendaTab[]; heading?: React.ReactNode }) {
  const [first] = tabs
  const [value, setValue] = useState(first?.id)
  if (!first) return null
  const active = tabs.find((tab) => tab.id === value) ?? first
  if (tabs.length === 1) {
    return (
      <div className="flex flex-col gap-6">
        <Header heading={heading} tab={first} />
        <p className="inline-flex items-center gap-2 self-start rounded-full border bg-card px-3.5 py-1.5 text-sm font-medium">
          <Label tab={first} />
        </p>
        {first.content}
      </div>
    )
  }
  return (
    <TabsPrimitive.Root value={active.id} onValueChange={setValue} className="flex flex-col gap-6">
      <Header heading={heading} tab={active} />
      <TabsPrimitive.List
        aria-label="Show"
        className="inline-flex gap-1 self-start rounded-full border bg-card p-1"
      >
        {tabs.map((tab) => (
          <TabsPrimitive.Trigger
            key={tab.id}
            value={tab.id}
            className="inline-flex min-h-11 items-center gap-2 rounded-full px-3.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring data-[state=active]:bg-muted data-[state=active]:text-foreground"
          >
            <Label tab={tab} />
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
      {tabs.map((tab) => (
        <TabsPrimitive.Content key={tab.id} value={tab.id} className="outline-none">
          {tab.content}
        </TabsPrimitive.Content>
      ))}
    </TabsPrimitive.Root>
  )
}
