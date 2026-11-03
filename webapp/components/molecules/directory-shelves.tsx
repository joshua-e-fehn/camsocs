"use client"

import { ArrowRightIcon } from "lucide-react"
import Link from "next/link"
import { useState } from "react"
import { CATEGORY_ICONS } from "@/components/molecules/category-icon"
import { OrgMonogram, TONE_CLASSES } from "@/components/molecules/org-monogram"
import { CATEGORY_TONE } from "@/lib/category-tone"
import { crawlerTrapRel, linkProps } from "@/lib/crawl-traps"
import { monogram } from "@/lib/monogram"
import type { OrgCard, OrgRef } from "@/lib/public-api"
import { cn } from "@/lib/utils"
import { CATEGORIES, CATEGORY_LABELS, type Category } from "@/lib/vocab"

/**
 * The curated sections /societies shows before its full index when nothing is
 * filtered: who is busy this week, the categories and the colleges. Each
 * carries a one-line note on how it is put together. Links into the
 * directory go through `onNavigate` (the URL is the state, updated in place),
 * so a plain click filters without a page load and a modified click still
 * opens a new tab. Without `onNavigate` a shelf links elsewhere (the hubs,
 * owner decision G13) through next/link: a client navigation, not a full
 * document load, and no viewport prefetch of every tile (as nav-main).
 */

export type Navigate = (href: string, event: React.MouseEvent<HTMLAnchorElement>) => void

/** A tile's link: in place through `onNavigate`, else a next/link; a
 * filtered directory view is rel=nofollow (lib/crawl-traps.ts). */
function ShelfLink({
  href,
  onNavigate,
  className,
  children,
}: {
  href: string
  onNavigate?: Navigate
  className: string
  children: React.ReactNode
}) {
  if (onNavigate) {
    return (
      <a
        href={href}
        rel={crawlerTrapRel(href)}
        onClick={(event) => onNavigate(href, event)}
        className={className}
      >
        {children}
      </a>
    )
  }
  return (
    <Link {...linkProps(href)} prefetch={false} className={className}>
      {children}
    </Link>
  )
}

function ShelfHeader({
  id,
  title,
  note,
  action,
}: {
  id: string
  title: React.ReactNode
  note: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex items-end justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <h2 id={id} className="font-serif text-2xl font-medium tracking-tight">
          {title}
        </h2>
        <p className="text-sm text-muted-foreground">{note}</p>
      </div>
      {action}
    </div>
  )
}

/** "MT26 Wk 4" → "Michaelmas · Week 4". */
export function termWeekWords(label: string | undefined): string | undefined {
  const match = label?.match(/^(MT|LT|ET)\d{2} Wk (\d+)$/)
  if (!match) return undefined
  const term = { MT: "Michaelmas", LT: "Lent", ET: "Easter" }[match[1] as "MT" | "LT" | "ET"]
  return `${term} · Week ${match[2]}`
}

export function BusyShelf({
  label,
  orgs,
  collegeNames,
}: {
  label?: string
  orgs: { card: Omit<OrgCard, "activity">; count: number }[]
  collegeNames: Record<string, string>
}) {
  if (orgs.length === 0) return null
  const week = termWeekWords(label)
  return (
    <section aria-labelledby="shelf-busy" className="flex flex-col gap-4">
      <ShelfHeader
        id="shelf-busy"
        title={
          <>
            Busy this week
            {week && (
              <span className="ml-2 align-middle font-mono text-xs font-normal tracking-wider text-muted-foreground uppercase">
                {week}
              </span>
            )}
          </>
        }
        note="Ranked by the public events each society runs this week, from the sources we read."
      />
      <ol className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-2 [scrollbar-width:thin] sm:mx-0 sm:px-0">
        {orgs.map(({ card, count }) => (
          <li key={card.key} className="w-56 shrink-0 snap-start">
            <Link
              href={`/societies/${card.slug}`}
              className="group flex h-full flex-col gap-3 rounded-xl border bg-card p-4 transition-colors duration-150 hover:border-primary/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <div className="flex items-start justify-between gap-2">
                <OrgMonogram
                  name={card.name}
                  shortName={card.shortName}
                  url={card.logoUrl}
                  categories={card.categories}
                  college={card.collegeKeys.length > 0}
                  size={44}
                />
                <span className="rounded-full bg-events-tint px-2 py-0.5 font-mono text-xs text-events tabular-nums">
                  {count} {count === 1 ? "event" : "events"}
                </span>
              </div>
              <div className="flex min-w-0 flex-col gap-0.5">
                <h3 className="line-clamp-2 leading-snug font-semibold tracking-tight group-hover:underline group-hover:underline-offset-4">
                  {card.name}
                </h3>
                <p className="truncate text-xs text-muted-foreground">
                  {[
                    card.categories[0] && CATEGORY_LABELS[card.categories[0]],
                    card.collegeKeys.map((key) => collegeNames[key]).filter(Boolean)[0],
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  )
}

export function CategoryTiles({
  counts,
  hrefFor,
  onNavigate,
}: {
  counts: Record<string, number>
  hrefFor: (category: Category) => string
  onNavigate?: Navigate
}) {
  const categories = CATEGORIES.filter((category) => (counts[category] ?? 0) > 0)
  return (
    <section aria-labelledby="shelf-categories" className="flex flex-col gap-4">
      <ShelfHeader
        id="shelf-categories"
        title="By category"
        note="Our sixteen categories; a society can sit in more than one."
      />
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {categories.map((category) => {
          const Icon = CATEGORY_ICONS[category]
          const href = hrefFor(category)
          return (
            <li key={category}>
              <ShelfLink
                href={href}
                onNavigate={onNavigate}
                className="group grid h-full min-h-14 grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 rounded-xl border bg-card p-3 transition-colors duration-150 hover:border-primary/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:grid-cols-[auto_1fr_auto] sm:p-2.5 sm:pr-3"
              >
                <span
                  aria-hidden
                  className={cn(
                    "flex size-9 shrink-0 items-center justify-center rounded-lg",
                    TONE_CLASSES[CATEGORY_TONE[category]],
                  )}
                >
                  <Icon className="size-4.5" strokeWidth={1.75} />
                </span>
                <span className="justify-self-end font-mono text-xs text-muted-foreground tabular-nums sm:order-last">
                  {counts[category]}
                </span>
                <span className="col-span-2 min-w-0 text-sm leading-tight font-medium text-pretty sm:col-span-1">
                  {CATEGORY_LABELS[category]}
                </span>
              </ShelfLink>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** "Gonville & Caius College" → "Gonville & Caius". */
export function collegeShortName(name: string): string {
  return name.replace(/\s+College$/, "").replace(/^The\s+/, "") || name
}

const COLLEGES_FOLDED = 8

export function CollegeGrid({
  colleges,
  counts,
  hrefFor,
  onNavigate,
}: {
  colleges: OrgRef[]
  counts: Record<string, number>
  hrefFor: (collegeKey: string) => string
  onNavigate?: Navigate
}) {
  const [expanded, setExpanded] = useState(false)
  const listed = colleges.filter((college) => (counts[college.key] ?? 0) > 0)
  if (listed.length === 0) return null
  return (
    <section aria-labelledby="shelf-colleges" className="flex flex-col gap-4">
      <ShelfHeader
        id="shelf-colleges"
        title="By college"
        note="JCR and MCR societies, boat clubs and other college groups, by college."
      />
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {listed.map((college, index) => {
          const href = hrefFor(college.key)
          const short = collegeShortName(college.name)
          return (
            <li
              key={college.key}
              className={cn(!expanded && index >= COLLEGES_FOLDED && "hidden sm:block")}
            >
              <ShelfLink
                href={href}
                onNavigate={onNavigate}
                className="group flex h-full min-h-14 items-center gap-3 rounded-xl border bg-card p-2.5 pr-3 transition-colors duration-150 hover:border-primary/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <span
                  aria-hidden
                  className="relative flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted font-serif text-[15px] font-medium"
                >
                  {monogram(short)}
                  <span className="absolute inset-x-0 bottom-0 h-[3px] bg-gilt" />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{short}</span>
                <span className="font-mono text-xs text-muted-foreground tabular-nums">
                  {counts[college.key]}
                </span>
              </ShelfLink>
            </li>
          )
        })}
      </ul>
      {listed.length > COLLEGES_FOLDED && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="inline-flex min-h-11 items-center gap-1 self-start text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring sm:hidden"
        >
          {expanded ? "Fewer colleges" : `All ${listed.length} colleges`}
          <ArrowRightIcon
            aria-hidden
            className={cn("size-3.5 transition-transform", expanded ? "-rotate-90" : "rotate-90")}
          />
        </button>
      )}
    </section>
  )
}
