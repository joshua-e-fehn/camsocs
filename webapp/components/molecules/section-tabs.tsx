"use client"

import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"

export type SectionTab = { id: string; label: string; count?: number }

/**
 * A sticky row of pill tabs under a long page's header (phones and tablets
 * only) that jumps to its sections on the same page and marks the one in
 * view. Plain in-page links: they work without JavaScript, keep deep links
 * and need no ARIA tab pattern.
 */
export function SectionTabs({ tabs, className }: { tabs: SectionTab[]; className?: string }) {
  const [active, setActive] = useState(tabs[0]?.id)

  useEffect(() => {
    const sections = tabs
      .map((tab) => document.getElementById(tab.id))
      .filter((el): el is HTMLElement => el !== null)
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (visible[0]) setActive(visible[0].target.id)
      },
      { rootMargin: "-30% 0px -60% 0px" },
    )
    for (const section of sections) observer.observe(section)
    return () => observer.disconnect()
  }, [tabs])

  return (
    <nav
      aria-label="On this page"
      className={cn(
        "sticky top-[var(--site-header-height,4rem)] z-30 -mx-4 border-b bg-background/95 px-4 py-2 backdrop-blur supports-backdrop-filter:bg-background/80 sm:-mx-6 sm:px-6 lg:hidden",
        className,
      )}
    >
      <ul className="flex gap-1.5 overflow-x-auto [scrollbar-width:none]">
        {tabs.map((tab) => (
          <li key={tab.id}>
            <a
              href={`#${tab.id}`}
              aria-current={active === tab.id ? "location" : undefined}
              onClick={() => setActive(tab.id)}
              className={cn(
                "inline-flex h-11 items-center gap-1.5 rounded-full px-3.5 text-sm font-medium whitespace-nowrap transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                active === tab.id
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
              {tab.count !== undefined && (
                <span className="font-mono text-xs tabular-nums opacity-75">{tab.count}</span>
              )}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}
