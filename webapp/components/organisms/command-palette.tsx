"use client"

import { Command as CommandPrimitive } from "cmdk"
import {
  ArrowRightIcon,
  CalendarDaysIcon,
  ClockIcon,
  CornerDownLeftIcon,
  FileTextIcon,
  LandmarkIcon,
  PresentationIcon,
  SearchIcon,
  UsersIcon,
  XIcon,
} from "lucide-react"
import { useRouter } from "next/navigation"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { CATEGORY_ICONS } from "@/components/molecules/category-icon"
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { useColleges, useEventSearch, useOrgSearch, useTalkSearch } from "@/hooks/convex"
import { useTrackSearch } from "@/hooks/use-analytics"
import { formatEventTime, londonIsoDate, monthShort } from "@/lib/calendar"
import { monogram } from "@/lib/monogram"
import {
  firstPaletteValue,
  forgetRecent,
  isForgetKey,
  isTypingTarget,
  matchesWords,
  PALETTE_EVENT,
  type PaletteRequest,
  type PaletteScope,
  readRecent,
  recentOf,
  recentValue,
  rememberRecent,
} from "@/lib/palette"
import { talkHref, talkPaletteLine } from "@/lib/talk-display"
import { cn } from "@/lib/utils"
import { CATEGORIES, CATEGORY_LABELS, type Category } from "@/lib/vocab"

/**
 * The site-wide search palette (spec §6 "⌘K palette"): one box over
 * societies, events, talks, colleges, categories and pages, opened with ⌘K /
 * Ctrl+K, with `/` when no text field has focus, from the header's search
 * pill, or by `openPalette()` (lib/palette.ts). Full screen on phones.
 *
 * Societies come from `orgs.list` (search relevance), events from
 * `events.list` (title words, next four weeks), talks from `talks.search`
 * (upcoming, best match first); colleges, categories and pages are matched
 * locally. cmdk's own filtering is off: the server ranks.
 *
 * The listbox holds options only (axe `nested-interactive`): the "Try" words
 * and "Clear" sit above it, and a highlighted recent search is forgotten with
 * Delete or Shift+Backspace rather than by a button inside its row.
 */

/** Long enough to skip a query per keystroke, short enough to feel live. */
const DEBOUNCE_MS = 140
const SOCIETY_ROWS = 6
const EVENT_ROWS = 5
/** Talks under "All" (there are many a week), and in the Talks scope. */
const TALK_ROWS = 3
const TALK_ROWS_SCOPED = 6
const LOCAL_ROWS = 4

const PAGES = [
  { href: "/societies", label: "Societies and clubs", hint: "The directory" },
  { href: "/events", label: "Events", hint: "This term's calendar" },
  { href: "/talks", label: "Talks", hint: "Seminars and lectures" },
  { href: "/about", label: "About camsocs", hint: "Sources and method" },
  { href: "/request?kind=add", label: "Add a missing society", hint: "Request" },
  { href: "/request?kind=claim", label: "Claim or correct a listing", hint: "Request" },
  { href: "/privacy", label: "Privacy notice", hint: "Your data" },
] as const

const SUGGESTIONS = ["Rowing", "Chess", "Jazz", "Debating", "Climbing", "Film"] as const

const SCOPE_LABELS: Record<PaletteScope, string> = {
  all: "All",
  societies: "Societies",
  events: "Events",
  talks: "Talks",
  colleges: "Colleges",
}

const SCOPES = Object.keys(SCOPE_LABELS) as PaletteScope[]

export function CommandPalette() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState("")
  const [scope, setScope] = useState<PaletteScope>("all")
  const [recent, setRecent] = useState<string[]>([])
  const query = useDebounced(input.trim(), DEBOUNCE_MS)

  const show = (group: PaletteScope) => scope === "all" || scope === group

  const orgs = useOrgSearch(open && show("societies") ? query : "")
  const events = useEventSearch(open && show("events") ? query : "")
  const talks = useTalkSearch(open && show("talks") ? query : "")
  const colleges = useColleges(open)

  const collegeNames = useMemo(
    () => new Map((colleges ?? []).map((college) => [college.key, college.name])),
    [colleges],
  )

  // Where focus was when the palette opened: it has no Radix trigger (it
  // opens from a custom event or a shortcut), so Radix would drop focus on
  // <body> when it closes. Not used after a navigation.
  const returnFocus = useRef<HTMLElement | null>(null)
  const navigating = useRef(false)
  const openWith = useCallback((request: PaletteRequest = {}) => {
    const active = document.activeElement
    returnFocus.current = active instanceof HTMLElement && active !== document.body ? active : null
    navigating.current = false
    setInput(request.query ?? "")
    setScope(request.scope ?? "all")
    setRecent(readRecent())
    setOpen(true)
  }, [])

  // ⌘K / Ctrl+K toggles; `/` opens when the reader is not typing somewhere.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing) return
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault()
        if (open) setOpen(false)
        else openWith()
        return
      }
      if (
        event.key === "/" &&
        !open &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !isTypingTarget(event.target)
      ) {
        event.preventDefault()
        openWith()
      }
    }
    function onRequest(event: Event) {
      openWith((event as CustomEvent<PaletteRequest>).detail)
    }
    window.addEventListener("keydown", onKeyDown)
    window.addEventListener(PALETTE_EVENT, onRequest)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      window.removeEventListener(PALETTE_EVENT, onRequest)
    }
  }, [open, openWith])

  const go = useCallback(
    (href: string) => {
      if (query) setRecent(rememberRecent(query))
      navigating.current = true
      setOpen(false)
      router.push(href)
    },
    [query, router],
  )

  const localColleges = query
    ? (colleges ?? []).filter((college) => matchesWords(college.name, query)).slice(0, LOCAL_ROWS)
    : []
  const localCategories: Category[] = query
    ? CATEGORIES.filter((category) => matchesWords(CATEGORY_LABELS[category], query)).slice(
        0,
        LOCAL_ROWS,
      )
    : []
  const localPages = query
    ? PAGES.filter((page) => matchesWords(`${page.label} ${page.hint}`, query))
    : PAGES

  const encoded = encodeURIComponent(query)

  const orgRows = (orgs?.page ?? []).slice(0, SOCIETY_ROWS)
  const eventRows = (events ?? []).slice(0, EVENT_ROWS)
  const talkRows = (talks ?? []).slice(0, scope === "talks" ? TALK_ROWS_SCOPED : TALK_ROWS)

  // Settled once every shown group that queries has answered; the count is
  // the rows shown, not the "see all" links. Only queries of two or more
  // characters count (events and talks skip a shorter one, so a scoped
  // palette would report a search that never ran as finding nothing). Only
  // the length of the query is sent.
  const searchable = query.length >= 2
  const settled =
    open &&
    (!show("societies") || orgs !== undefined) &&
    (!show("events") || !searchable || events !== undefined) &&
    (!show("talks") || !searchable || talks !== undefined) &&
    (!show("colleges") || colleges !== undefined)
  const shownRows =
    (show("societies") ? orgRows.length : 0) +
    (show("events") ? eventRows.length : 0) +
    (show("talks") ? talkRows.length : 0) +
    (show("colleges") ? localColleges.length : 0) +
    (scope === "all" ? localCategories.length + localPages.length : 0)
  useTrackSearch("palette", open && searchable ? query : undefined, settled ? shownRows : undefined)

  // Each shown group's row values in render order; the first one is
  // highlighted whenever it changes (lib/palette.ts `firstPaletteValue`).
  const firstValue = firstPaletteValue(
    !query
      ? [recent.map(recentValue), scope === "all" ? PAGES.map((page) => page.href) : []]
      : [
          show("societies")
            ? [...orgRows.map((org) => `/societies/${org.slug}`), `/societies?q=${encoded}`]
            : [],
          show("events")
            ? [
                ...eventRows.map((event) => `/events?event=${event.key}`),
                `/events?weeks=4&q=${encoded}`,
              ]
            : [],
          show("talks")
            ? [...talkRows.map((talk) => talkHref(talk.key)), `/talks?q=${encoded}`]
            : [],
          show("colleges")
            ? localColleges.map((college) => `/societies?college=${college.key}`)
            : [],
          scope === "all" ? localCategories.map((category) => `/societies?cat=${category}`) : [],
          scope === "all" ? localPages.map((page) => page.href) : [],
        ],
  )
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // The highlight is cmdk's own (uncontrolled): a controlled `value` moves the
  // highlight but not cmdk's aria-activedescendant, which then names a row
  // that is gone (cmdk 1.1.1 syncs it only on its own selection path, and
  // not at all when it picks a first row itself). So the first row is chosen
  // with cmdk's own End then Home keys — Home alone is a no-op when the row is
  // already highlighted. The first row in DOM order is the one `firstValue`
  // names; both keys run in one frame, before paint.
  const highlightFirst = useCallback(() => {
    return requestAnimationFrame(() => {
      for (const key of ["End", "Home"]) {
        rootRef.current?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }))
      }
    })
  }, [])
  useEffect(() => {
    if (!open || !firstValue) return
    const frame = highlightFirst()
    return () => cancelAnimationFrame(frame)
  }, [firstValue, open, highlightFirst])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          const target = returnFocus.current
          returnFocus.current = null
          if (!navigating.current && target?.isConnected) target.focus()
        }}
        className={cn(
          "gap-0 overflow-hidden p-0 sm:top-[12vh] sm:max-w-xl sm:translate-y-0",
          // Phones: the whole screen, like a native search.
          "max-sm:top-0 max-sm:left-0 max-sm:h-dvh max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none max-sm:ring-0",
        )}
      >
        <DialogTitle className="sr-only">Search camsocs</DialogTitle>
        <DialogDescription className="sr-only">
          Societies, events, talks, colleges, categories and pages. Use the arrow keys to move and
          Enter to open; Delete forgets a highlighted recent search.
        </DialogDescription>
        <Command
          ref={rootRef}
          shouldFilter={false}
          onKeyDown={(event) => {
            // Delete / Shift+Backspace on a highlighted recent search forgets
            // it; cmdk then highlights the first row.
            // `input`, not the debounced `query`: a key pressed within the
            // debounce of typing edits the text, it does not forget a row.
            if (input.trim() || query || !isForgetKey(event)) return
            const highlighted = event.currentTarget
              .querySelector('[cmdk-item][aria-selected="true"]')
              ?.getAttribute("data-value")
            const item = highlighted ? recentOf(highlighted) : undefined
            if (item === undefined) return
            event.preventDefault()
            setRecent(forgetRecent(item))
            highlightFirst()
          }}
          loop
          className="rounded-none! bg-transparent p-0 max-sm:h-full"
          label="Search camsocs"
        >
          <div className="flex items-center gap-2 border-b px-4">
            <SearchIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
            <CommandPrimitive.Input
              ref={inputRef}
              value={input}
              onValueChange={setInput}
              placeholder="Societies, events, talks…"
              maxLength={200}
              className="h-14 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
            />
            {input && (
              <button
                type="button"
                onClick={() => setInput("")}
                className="flex size-9 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              >
                <XIcon aria-hidden className="size-4" />
                <span className="sr-only">Clear the search</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="flex min-h-11 items-center rounded-md px-2 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring sm:hidden"
            >
              Cancel
            </button>
            <kbd className="hidden rounded border bg-muted px-1.5 py-0.5 font-mono text-[0.6875rem] text-muted-foreground sm:inline">
              esc
            </kbd>
          </div>

          {/* Scope chips: what the box searches. */}
          <fieldset
            aria-label="Search in"
            className="no-scrollbar min-w-0 flex gap-1.5 overflow-x-auto border-b px-3 py-2"
          >
            {SCOPES.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={scope === value}
                onClick={() => {
                  setScope(value)
                  // Back to the box, so the next key types.
                  inputRef.current?.focus()
                }}
                className="min-h-9 shrink-0 rounded-full border px-3 text-[0.8125rem] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring aria-pressed:border-foreground aria-pressed:bg-foreground aria-pressed:text-background max-sm:min-h-11"
              >
                {SCOPE_LABELS[value]}
              </button>
            ))}
          </fieldset>

          {!query && (
            <div className="flex flex-wrap items-center gap-1.5 border-b px-3 py-2">
              <span className="mr-1 font-mono text-[0.6875rem] tracking-[0.12em] text-muted-foreground uppercase">
                Try
              </span>
              {SUGGESTIONS.map((word) => (
                <button
                  key={word}
                  type="button"
                  onClick={() => {
                    setInput(word)
                    inputRef.current?.focus()
                  }}
                  className="min-h-8 rounded-full bg-muted px-3 text-[0.8125rem] transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring max-sm:min-h-11"
                >
                  {word}
                </button>
              ))}
              {recent.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    for (const item of recent) forgetRecent(item)
                    setRecent([])
                    // The button goes with the list: keep focus in the box.
                    inputRef.current?.focus()
                  }}
                  className="ml-auto inline-flex min-h-8 items-center gap-1 rounded-md px-2 text-[0.8125rem] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring max-sm:min-h-11"
                >
                  <XIcon aria-hidden className="size-3.5" />
                  Clear recent searches
                </button>
              )}
            </div>
          )}

          {/* Outside the listbox, which may hold options only (axe
              aria-required-children); an empty listbox is fine. */}
          {query && scope === "colleges" && localColleges.length === 0 && colleges && (
            <p role="status" className="px-4 py-8 text-center text-sm text-muted-foreground">
              No college by that name.
            </p>
          )}
          <CommandList className="max-h-[min(62vh,30rem)] scroll-py-2 p-1.5 max-sm:max-h-none max-sm:flex-1">
            {!query && recent.length > 0 && (
              <CommandGroup heading="Recent" className={HEADING}>
                {recent.map((item) => (
                  <PaletteItem
                    key={recentValue(item)}
                    value={recentValue(item)}
                    onSelect={() => setInput(item)}
                  >
                    <ClockIcon aria-hidden className="text-muted-foreground" />
                    <span className="truncate">{item}</span>
                    <kbd
                      aria-hidden
                      className="ml-auto hidden shrink-0 rounded border bg-card px-1 font-mono text-[0.625rem] text-muted-foreground sm:group-data-selected/command-item:inline"
                    >
                      del to forget
                    </kbd>
                  </PaletteItem>
                ))}
              </CommandGroup>
            )}

            {query && show("societies") && (
              <CommandGroup
                heading={<GroupHeading label="Societies" loading={orgs === undefined} />}
                className={HEADING}
              >
                {orgRows.map((org) => {
                  const college = org.collegeKeys.map((key) => collegeNames.get(key)).find(Boolean)
                  const category = org.categories[0]
                  return (
                    <PaletteItem
                      key={org.key}
                      value={`/societies/${org.slug}`}
                      onSelect={() => go(`/societies/${org.slug}`)}
                    >
                      <span
                        aria-hidden
                        className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent font-serif group-data-selected/command-item:bg-card text-[0.8125rem] font-medium text-accent-foreground"
                      >
                        {monogram(org.name, org.shortName)}
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate font-medium">{org.name}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          {[category && CATEGORY_LABELS[category], college]
                            .filter(Boolean)
                            .join(" · ") || "Society"}
                        </span>
                      </span>
                    </PaletteItem>
                  )
                })}
                <PaletteItem
                  value={`/societies?q=${encoded}`}
                  onSelect={() => go(`/societies?q=${encoded}`)}
                >
                  <UsersIcon aria-hidden className="text-primary" />
                  <span className="truncate">
                    All societies matching <q className="font-medium">{query}</q>
                  </span>
                  <ArrowRightIcon aria-hidden className="ml-auto text-muted-foreground" />
                </PaletteItem>
              </CommandGroup>
            )}

            {query && show("events") && (
              <CommandGroup
                heading={
                  <GroupHeading
                    label="Events"
                    loading={query.length >= 2 && events === undefined}
                  />
                }
                className={HEADING}
              >
                {eventRows.map((event) => {
                  const day = londonIsoDate(event.startsAt)
                  return (
                    <PaletteItem
                      key={event.key}
                      value={`/events?event=${event.key}`}
                      onSelect={() => go(`/events?event=${event.key}`)}
                    >
                      <span
                        aria-hidden
                        className="flex size-8 shrink-0 flex-col items-center justify-center rounded-md bg-events-tint leading-none text-events"
                      >
                        <span className="font-serif text-sm font-semibold tabular-nums">
                          {Number(day.slice(8))}
                        </span>
                        <span className="text-[0.5625rem] tracking-wide uppercase">
                          {monthShort(day)}
                        </span>
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <span
                          className={cn("truncate font-medium", event.cancelled && "line-through")}
                        >
                          {event.title}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {[formatEventTime(event), event.organisers[0]?.name]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </span>
                    </PaletteItem>
                  )
                })}
                <PaletteItem
                  value={`/events?weeks=4&q=${encoded}`}
                  onSelect={() => go(`/events?weeks=4&q=${encoded}`)}
                >
                  <CalendarDaysIcon aria-hidden className="text-events" />
                  <span className="truncate">
                    Events titled <q className="font-medium">{query}</q>
                  </span>
                  <ArrowRightIcon aria-hidden className="ml-auto text-muted-foreground" />
                </PaletteItem>
              </CommandGroup>
            )}

            {query && show("talks") && (
              <CommandGroup
                heading={
                  <GroupHeading label="Talks" loading={query.length >= 2 && talks === undefined} />
                }
                className={HEADING}
              >
                {talkRows.map((talk) => {
                  const day = londonIsoDate(talk.startsAt)
                  return (
                    <PaletteItem
                      key={talk.key}
                      value={talkHref(talk.key)}
                      onSelect={() => go(talkHref(talk.key))}
                    >
                      <span
                        aria-hidden
                        className="flex size-8 shrink-0 flex-col items-center justify-center rounded-md bg-talks-tint leading-none text-talks"
                      >
                        <span className="font-serif text-sm font-semibold tabular-nums">
                          {Number(day.slice(8))}
                        </span>
                        <span className="text-[0.5625rem] tracking-wide uppercase">
                          {monthShort(day)}
                        </span>
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <span
                          className={cn("truncate font-medium", talk.cancelled && "line-through")}
                        >
                          {talk.title}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {talk.cancelled ? "Cancelled · " : ""}
                          {talkPaletteLine(talk)}
                        </span>
                      </span>
                    </PaletteItem>
                  )
                })}
                <PaletteItem
                  value={`/talks?q=${encoded}`}
                  onSelect={() => go(`/talks?q=${encoded}`)}
                >
                  <PresentationIcon aria-hidden className="text-talks" />
                  <span className="truncate">
                    Talks matching <q className="font-medium">{query}</q>
                  </span>
                  <ArrowRightIcon aria-hidden className="ml-auto text-muted-foreground" />
                </PaletteItem>
              </CommandGroup>
            )}

            {query && show("colleges") && localColleges.length > 0 && (
              <CommandGroup heading="Colleges" className={HEADING}>
                {localColleges.map((college) => (
                  <PaletteItem
                    key={college.key}
                    value={`/societies?college=${college.key}`}
                    onSelect={() => go(`/societies?college=${college.key}`)}
                  >
                    <LandmarkIcon aria-hidden className="text-muted-foreground" />
                    <span className="truncate">{college.name}</span>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      Its societies
                    </span>
                  </PaletteItem>
                ))}
              </CommandGroup>
            )}

            {scope === "all" && localCategories.length > 0 && (
              <CommandGroup heading="Categories" className={HEADING}>
                {localCategories.map((category) => {
                  const Icon = CATEGORY_ICONS[category]
                  return (
                    <PaletteItem
                      key={category}
                      value={`/societies?cat=${category}`}
                      onSelect={() => go(`/societies?cat=${category}`)}
                    >
                      <Icon aria-hidden className="text-muted-foreground" />
                      <span className="truncate">{CATEGORY_LABELS[category]}</span>
                    </PaletteItem>
                  )
                })}
              </CommandGroup>
            )}

            {scope === "all" && localPages.length > 0 && (
              <>
                {query && <CommandSeparator className="my-1" />}
                <CommandGroup heading={query ? "Pages" : "Jump to"} className={HEADING}>
                  {localPages.map((page) => (
                    <PaletteItem key={page.href} value={page.href} onSelect={() => go(page.href)}>
                      <FileTextIcon aria-hidden className="text-muted-foreground" />
                      <span className="truncate">{page.label}</span>
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                        {page.hint}
                      </span>
                    </PaletteItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>

          <div className="hidden items-center gap-4 border-t bg-muted/40 px-4 py-2 font-mono text-[0.6875rem] text-muted-foreground sm:flex">
            <span>↑↓ move</span>
            <span className="inline-flex items-center gap-1">
              <CornerDownLeftIcon aria-hidden className="size-3" /> open
            </span>
            <span>esc close</span>
            <span className="ml-auto">⌘K anywhere · / when not typing</span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  )
}

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}

/** Serif small caps headings (cmdk renders the heading itself). */
const HEADING =
  "**:[[cmdk-group-heading]]:flex **:[[cmdk-group-heading]]:items-center **:[[cmdk-group-heading]]:gap-2 **:[[cmdk-group-heading]]:px-2.5 **:[[cmdk-group-heading]]:pt-2.5 **:[[cmdk-group-heading]]:font-serif **:[[cmdk-group-heading]]:text-[0.8125rem] **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:tracking-[0.06em] **:[[cmdk-group-heading]]:text-muted-foreground **:[[cmdk-group-heading]]:[font-variant-caps:all-small-caps]"

function GroupHeading({ label, loading }: { label: string; loading: boolean }) {
  return (
    <>
      {label}
      {loading && <Spinner className="size-3" />}
    </>
  )
}

/** One palette row: 44 px tall on phones, a sage edge when active. Exported
 * for the wave-2 Talks group. (The atom's trailing check mark is hidden: the
 * palette selects, it does not tick.) */
export function PaletteItem({ className, ...props }: React.ComponentProps<typeof CommandItem>) {
  return (
    <CommandItem
      className={cn(
        "min-h-11 gap-3 rounded-md! px-2.5 py-1.5 data-selected:bg-accent data-selected:shadow-[inset_2px_0_0_var(--primary)] sm:min-h-10 [&>svg:last-child]:hidden",
        className,
      )}
      {...props}
    />
  )
}
