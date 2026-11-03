"use client"

import { type Preloaded, usePreloadedQuery, useQuery } from "convex/react"
import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  CalendarDaysIcon,
  CalendarRangeIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ListIcon,
  LockIcon,
  SlidersHorizontalIcon,
  XIcon,
} from "lucide-react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { useEffect, useMemo, useRef, useState } from "react"
import { DatePresets } from "@/components/molecules/date-presets"
import { EventDetails, EventEyebrow } from "@/components/molecules/event-details"
import { EventMonthGrid, EventWeekGrid } from "@/components/molecules/event-grids"
import {
  EventChip,
  EventRow,
  EventRowSkeleton,
  EventTitle,
} from "@/components/molecules/event-item"
import { FacetChips } from "@/components/molecules/facet-chips"
import { FacetPopover } from "@/components/molecules/facet-popover"
import {
  type AppliedChip,
  FilterChipStrip,
  type QuickChip,
} from "@/components/molecules/filter-chip-strip"
import { FilterSheet } from "@/components/molecules/filter-sheet"
import { OrgPicker } from "@/components/molecules/org-picker"
import { SearchField } from "@/components/molecules/search-field"
import { WeekStrip } from "@/components/molecules/week-strip"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { api } from "@/convex/_generated/api"
import { useEvent, useSignInOptions, useVenues } from "@/hooks/convex"
import { useEventWindow, useRestrictedCount, useTalksSideEvents } from "@/hooks/convex/events"
import { useTrackSearch, useTrackView } from "@/hooks/use-analytics"
import {
  addDays,
  type CalendarView,
  formatDayShort,
  formatMonth,
  formatRange,
  londonIsoDate,
  shiftAnchor,
} from "@/lib/calendar"
import { crawlerTrapRel, linkProps } from "@/lib/crawl-traps"
import { availablePresets, currentTermEnd, type DatePreset } from "@/lib/date-presets"
import { eventsByDay, lastDayOf, splitOngoing } from "@/lib/event-runs"
import {
  dayCounts,
  matchesEventQuery,
  mergeByStart,
  nextDayWithEvents,
  spokenTitle,
  stripPages,
  stripRangeLabel,
} from "@/lib/events"
import type { EventListItem, OrgRef } from "@/lib/public-api"
import { camSignInHref, SITE_URL } from "@/lib/site"
import { dayHeading } from "@/lib/talks"
import { eventPath } from "@/lib/talks-boundary"
import type { TermDatesRow } from "@/lib/term-week"
import {
  activeEventFilterCount,
  defaultWeeks,
  type EventsState,
  eventListArgs,
  eventRestrictedArgs,
  eventsHref,
  eventsWindow,
  MAX_LIST_WEEKS,
  parseEventsParams,
  type SearchParams,
  type UniversityView,
} from "@/lib/url-state"
import { cn } from "@/lib/utils"
import { CATEGORIES, CATEGORY_LABELS, EVENT_TYPE_LABELS, EVENT_TYPES } from "@/lib/vocab"
import { termWeekTag } from "@/lib/week-strip"

const VIEWS: { value: CalendarView; label: string; icon: typeof ListIcon }[] = [
  { value: "list", label: "List", icon: ListIcon },
  { value: "week", label: "Week", icon: CalendarRangeIcon },
  { value: "month", label: "Month", icon: CalendarDaysIcon },
]
const LONG_WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
/** A preset in a sentence: "5 events this weekend". */
const PRESET_PHRASES: Record<DatePreset, string> = {
  today: "today",
  tomorrow: "tomorrow",
  week: "this week",
  weekend: "this weekend",
  term: "for the rest of term",
}
/** "Search the next N weeks" from an empty search. */
const SEARCH_WEEKS = 4
/** Whose events are listed (ENG-24): the switch's words, and the applied
 * chip's for a choice other than "All". */
const UNIVERSITY_OPTIONS: { value: UniversityView; label: string; chip: string }[] = [
  { value: "all", label: "All", chip: "All events" },
  { value: "hide", label: "Societies & clubs", chip: "Societies & clubs only" },
  { value: "only", label: "University", chip: "University only" },
]
/** Why the University view greys out the organiser filters. */
const NO_ORGANISER_FILTERS =
  "Category, college and society filters don’t apply to the University’s listings: they aren’t linked to a society here."

function searchParamsObject(params: URLSearchParams): SearchParams {
  const out: SearchParams = {}
  for (const key of new Set(params.keys())) {
    const all = params.getAll(key)
    out[key] = all.length > 1 ? all : all[0]
  }
  return out
}

/** A link's plain click handled in place (`run`); a modified click (new
 * tab, new window) follows the link as usual. */
function inPlace(run: () => void) {
  return (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return
    }
    event.preventDefault()
    if (event.currentTarget.getAttribute("aria-disabled") === "true") return
    run()
  }
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`
}

/** A punt on the Cam, pole raised: the empty state's mark. */
function PuntMark() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 120 52"
      className="h-13 w-30 text-events"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 33h78l-6 6H26z" />
      <path d="M86 33V27h8" opacity=".6" />
      <path d="M72 6 52 44" />
      <path d="M63 27c0-3 2-5 5-5s5 2 5 5v6H63z" opacity=".7" />
      <path
        d="M4 45c10-4 18 4 28 0s18 4 28 0 18 4 28 0 18 4 28 0"
        stroke="var(--backs)"
        strokeWidth="2"
      />
    </svg>
  )
}

/** "All · Societies & clubs · University" (ENG-24): whose events the
 * calendar lists. The University's own listings are in by default. */
function UniversitySwitch({
  value,
  onChange,
  className,
}: {
  value: UniversityView
  onChange: (next: UniversityView) => void
  className?: string
}) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(next) => next && onChange(next as UniversityView)}
      aria-label="Whose events"
      className={cn("rounded-full border bg-card p-0.5", className)}
    >
      {UNIVERSITY_OPTIONS.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          className="h-11 rounded-full px-3.5 text-[13px] whitespace-nowrap data-[state=on]:bg-foreground data-[state=on]:text-background sm:h-8"
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

/** Events that began before the dates on screen and are still on (a film
 * listed for months, lib/event-runs.ts): one folded row, "N ongoing", above
 * the days. Opened, it lists them as chips, soonest to end first. */
function Ongoing({
  events,
  hrefFor,
  onSelect,
}: {
  events: EventListItem[]
  hrefFor: (event: EventListItem) => string
  onSelect: (event: EventListItem, target: HTMLElement) => void
}) {
  const [open, setOpen] = useState(false)
  if (events.length === 0) return null
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="rounded-xl border border-dashed bg-card/60"
    >
      <h2 className="text-sm">
        <CollapsibleTrigger className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 py-2 text-left transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring data-[state=open]:rounded-b-none">
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
              open && "rotate-90",
            )}
          />
          <span className="shrink-0 font-medium">
            <span className="font-mono tabular-nums">{events.length}</span> already on
            <span className="sr-only"> {events.length === 1 ? "event" : "events"}</span>
          </span>
          {!open && (
            <span aria-hidden className="min-w-0 truncate text-muted-foreground">
              {events.map((event) => spokenTitle(event.title)).join(" · ")}
            </span>
          )}
          <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
            {open ? "Hide" : "Show"}
          </span>
        </CollapsibleTrigger>
      </h2>
      <CollapsibleContent>
        <ul className="grid grid-cols-1 gap-1.5 border-t border-dashed p-2 sm:grid-cols-2">
          {events.map((event) => (
            <li key={event.key} className="min-w-0">
              <EventChip
                event={event}
                href={hrefFor(event)}
                onSelect={(target) => onSelect(event, target)}
                when={`until ${formatDayShort(lastDayOf(event))}`}
                className="px-2 py-3 text-sm sm:py-1.5"
              />
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * The /events calendar (talks-redesign-spec §6 "/events"). The URL is the
 * state (lib/url-state.ts): every change writes it with `history.pushState`,
 * which Next folds into `useSearchParams`, and the live `events.list` query
 * follows over the open socket — no server round trip, the previous events
 * staying on screen (with a thin brick progress line) until the next arrive.
 * The server page preloads the first view: one week, not four.
 *
 * Layout: serif header with a slim "Talks" cross-link → a sticky search bar
 * (desktop: facet popovers, society, "Include taking part"; phone: a
 * "Filters" bottom sheet and chips) → the list view's day-grouped agenda
 * under sticky day headers beside (desktop) or under (phone) the week strip
 * and date presets, loading a week at a time; or the week / month grids.
 * An event opens in a side sheet (`?event=`) and has its own page,
 * /events/[key].
 */
export function EventsCalendar({
  today,
  terms,
  org: serverOrg,
  preloadedEvents,
  preloadedColleges,
  preloadedRestricted,
}: {
  /** London's today, from the server, so both renders agree. */
  today: string
  terms: TermDatesRow[]
  /** The `?org=` society the server found, for its name. */
  org: OrgRef | null
  preloadedEvents: Preloaded<typeof api.events.list>
  preloadedColleges: Preloaded<typeof api.orgs.colleges>
  preloadedRestricted: Preloaded<typeof api.events.restrictedCount> | null
}) {
  const searchParams = useSearchParams()
  const state = useMemo(
    () => parseEventsParams(searchParamsObject(new URLSearchParams(searchParams.toString()))),
    [searchParams],
  )
  const base: EventsState = { ...state, event: undefined }
  const termEnd = useMemo(() => currentTermEnd(today, terms), [today, terms])
  const window_ = eventsWindow(state, today, termEnd)
  const colleges = usePreloadedQuery(preloadedColleges)

  // Societies picked in this visit, by slug, so a filter keeps its name.
  const [knownOrgs, setKnownOrgs] = useState<Record<string, OrgRef>>(() =>
    serverOrg ? { [serverOrg.slug]: serverOrg } : {},
  )
  const org: OrgRef | null = state.org
    ? (knownOrgs[state.org] ?? { key: `org-${state.org}`, slug: state.org, name: state.org })
    : null

  // --- navigation ------------------------------------------------------------------------
  const resultsTop = useRef<HTMLDivElement>(null)
  const apply = (next: EventsState, { replace = false, scroll = false } = {}) => {
    const href = eventsHref({ ...next, event: undefined })
    if (replace) window.history.replaceState(null, "", href)
    else window.history.pushState(null, "", href)
    if (scroll) {
      const top = resultsTop.current
      if (top && top.getBoundingClientRect().top < 0) top.scrollIntoView({ block: "start" })
    }
  }
  const openedHere = useRef(false)
  useEffect(() => {
    if (!state.event) openedHere.current = false
  }, [state.event])
  // The row that opened the sheet, to take focus back when it closes.
  const opener = useRef<HTMLElement | null>(null)
  const openEvent = (event: EventListItem, from?: HTMLElement) => {
    openedHere.current = true
    opener.current = from ?? null
    window.history.pushState(null, "", eventsHref({ ...base, event: event.key }))
  }
  const closeEvent = () => {
    if (openedHere.current) window.history.back()
    else window.history.replaceState(null, "", eventsHref(base))
  }
  const eventHref = (event: EventListItem) => eventPath(event)
  const dayHref = (day: string) =>
    eventsHref({
      ...base,
      view: "list",
      preset: undefined,
      weeks: 1,
      date: day === today ? undefined : day,
    })

  // --- data ------------------------------------------------------------------------------
  const args = eventListArgs(state, window_)
  const loaded = useEventWindow(args, preloadedEvents)
  const stale = loaded.stale
  // The University view never lists a Cambridge-only event (its listings are
  // all public), so signing in would add nothing there: no count, no prompt.
  const universityView = state.university === "only"
  const restricted = useRestrictedCount(
    preloadedRestricted && !universityView ? eventRestrictedArgs(args) : "skip",
    preloadedRestricted ?? undefined,
  )
  // Nor without the @cam.ac.uk sign-in link switched on: the prompt would
  // lead to a sign-in page with nothing to do (ENG-35).
  const camSignIn = useSignInOptions()?.camEmail === true
  const camOnly = universityView || !camSignIn ? undefined : restricted
  // Talks.cam-derived society events join after hydration (G1).
  const talksSide = useTalksSideEvents(args)
  const all = useMemo(
    () => mergeByStart(loaded.data ?? [], talksSide ?? []),
    [loaded.data, talksSide],
  )
  const matching = useMemo(
    () => all.filter((event) => matchesEventQuery(event, state.q)),
    [all, state.q],
  )
  const { ongoing, starting } = splitOngoing(matching, window_.from)
  const list = state.view === "list"
  // Every loaded day (the strip's counts) and the days the agenda shows.
  const loadedByDay = eventsByDay(starting, window_.days, !list)
  const shownDays = window_.days.filter(
    (day) => day >= window_.shown.first && day <= window_.shown.last,
  )
  const agenda = [...loadedByDay.entries()].filter(
    ([day]) => day >= window_.shown.first && day <= window_.shown.last,
  )
  const shownCount = agenda.reduce((sum, [, events]) => sum + events.length, 0)
  const loading = loaded.data === undefined
  useTrackSearch("events", state.q, loading || stale ? undefined : shownCount)

  // --- the week strip ----------------------------------------------------------------------
  const pages = stripPages(window_.days)
  const [stripPage, setStripPage] = useState(0)
  const [seenFirst, setSeenFirst] = useState(window_.days[0])
  if (seenFirst !== window_.days[0]) {
    setSeenFirst(window_.days[0])
    setStripPage(0)
  }
  const pageIndex = Math.min(stripPage, pages.length - 1)
  const stripDays = pages[pageIndex] ?? []
  const [focusDay, setFocusDay] = useState<string | undefined>(undefined)
  const pendingScroll = useRef<string | undefined>(undefined)

  const scrollToDay = (day: string) => {
    const target = nextDayWithEvents(
      day,
      agenda.map(([date]) => date),
    )
    const element = target
      ? document.getElementById(`day-${target}`)
      : document.getElementById("events-agenda-end")
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    element?.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" })
  }
  // A day picked outside a preset's range: the preset is dropped, then the
  // agenda scrolls to the day once it shows it.
  useEffect(() => {
    const day = pendingScroll.current
    if (day && day >= window_.shown.first && day <= window_.shown.last && !stale) {
      pendingScroll.current = undefined
      scrollToDay(day)
    }
  })
  const pickDay = (day: string) => {
    setFocusDay(day)
    if (day >= window_.shown.first && day <= window_.shown.last) {
      scrollToDay(day)
      return
    }
    pendingScroll.current = day
    apply({
      ...base,
      preset: undefined,
      date: window_.days[0] === today ? undefined : window_.days[0],
      weeks: Math.min(MAX_LIST_WEEKS, Math.ceil(window_.days.length / 7)),
    })
  }
  const extendWeek = () =>
    apply(
      {
        ...base,
        preset: undefined,
        date: state.preset ? undefined : state.date,
        weeks: state.weeks + 1,
      },
      { replace: true },
    )
  const stripPrev = () => {
    if (pageIndex > 0) return setStripPage(pageIndex - 1)
    const back = addDays(window_.days[0], -7)
    apply({ ...base, preset: undefined, date: back <= today ? undefined : back })
  }
  const stripNext = () => {
    if (pageIndex < pages.length - 1) return setStripPage(pageIndex + 1)
    if (state.preset) {
      apply({
        ...base,
        preset: undefined,
        date: window_.days[0] === today ? undefined : window_.days[0],
        weeks: Math.min(MAX_LIST_WEEKS, Math.ceil(window_.days.length / 7) + 1),
      })
    } else extendWeek()
    setStripPage(pageIndex + 1)
  }
  // The strip's last page of the longest list the URL allows. A preset's
  // window counts in loaded weeks: past MAX_LIST_WEEKS, "next" would load a
  // shorter window than the one on screen ("Rest of term" from Week 0 is nine).
  const loadedWeeks = state.preset ? Math.ceil(window_.days.length / 7) : state.weeks
  const atLastWeek = loadedWeeks >= MAX_LIST_WEEKS && pageIndex >= pages.length - 1

  // The sticky search bar's height, so day headers stick just under it.
  const bar = useRef<HTMLDivElement>(null)
  const [barHeight, setBarHeight] = useState(0)
  useEffect(() => {
    const element = bar.current
    if (!element) return
    const measure = () => setBarHeight(element.getBoundingClientRect().height)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // --- the open event --------------------------------------------------------------------
  const openKey = state.event
  const openData = useEvent(openKey)
  const venues = useVenues(Boolean(openData?.venueKey && !openData.venueText))
  const openVenue = venues?.find((venue) => venue.key === openData?.venueKey)?.name
  const openPlaceholder = all.find((event) => event.key === openKey)
  useTrackView(
    "event_viewed",
    openData
      ? {
          eventKey: openData.key,
          orgKeys: openData.organisers
            .filter((organiser) => organiser.role !== "sponsor")
            .map((organiser) => organiser.key),
          hosting: openData.hosting,
        }
      : null,
  )

  // --- filters ---------------------------------------------------------------------------
  const filterCount = activeEventFilterCount(state)
  const toggle = (
    from: EventsState,
    facet: "categories" | "eventTypes" | "collegeKeys",
    value: string,
    on: boolean,
  ): EventsState => {
    const current = from[facet] as string[]
    return {
      ...from,
      [facet]: on ? [...current, value] : current.filter((item) => item !== value),
    }
  }
  const collegeName = (key: string) => colleges.find((college) => college.key === key)?.name ?? key
  const applied: AppliedChip[] = [
    ...state.eventTypes.map((type) => ({
      key: `type-${type}`,
      label: EVENT_TYPE_LABELS[type],
      onRemove: () => apply(toggle(base, "eventTypes", type, false)),
    })),
    ...state.categories.map((category) => ({
      key: `cat-${category}`,
      label: CATEGORY_LABELS[category],
      onRemove: () => apply(toggle(base, "categories", category, false)),
    })),
    ...state.collegeKeys.map((key) => ({
      key: `college-${key}`,
      label: collegeName(key),
      onRemove: () => apply(toggle(base, "collegeKeys", key, false)),
    })),
    ...(org
      ? [{ key: "org", label: org.name, onRemove: () => apply({ ...base, org: undefined }) }]
      : []),
    ...(state.takingPart
      ? [
          {
            key: "external",
            label: "Incl. taking part",
            onRemove: () => apply({ ...base, takingPart: false }),
          },
        ]
      : []),
    ...(state.university !== "all"
      ? [
          {
            key: "university",
            label:
              UNIVERSITY_OPTIONS.find((option) => option.value === state.university)?.chip ??
              state.university,
            onRemove: () => apply({ ...base, university: "all" }),
          },
        ]
      : []),
  ]
  const quick: QuickChip[] = [
    ...(!state.takingPart
      ? [
          {
            key: "external",
            label: "Include taking part",
            onSelect: () => apply({ ...base, takingPart: true }),
          },
        ]
      : []),
    ...(["social", "performance", "match", "formal"] as const)
      .filter((type) => !state.eventTypes.includes(type))
      .map((type) => ({
        key: type,
        label: EVENT_TYPE_LABELS[type],
        onSelect: () => apply(toggle(base, "eventTypes", type, true)),
      })),
  ]
  const clearAll = () =>
    apply({
      view: state.view,
      date: state.date,
      preset: state.preset,
      weeks: state.weeks,
      categories: [],
      eventTypes: [],
      collegeKeys: [],
      takingPart: false,
      university: "all",
    })
  /** The University view lists no society's events: the organiser filters go. */
  const pickUniversity = (university: UniversityView) =>
    apply(
      university === "only"
        ? { ...base, university, categories: [], collegeKeys: [], org: undefined }
        : { ...base, university },
      { scroll: true },
    )
  const universityOnly = state.university === "only"
  const pickOrg = (next: OrgRef | null, from: EventsState) => {
    if (next) setKnownOrgs((known) => ({ ...known, [next.slug]: next }))
    // A society's calendar opens on its four weeks, the whole site's on one,
    // unless the reader has already loaded more.
    const weeks = from.weeks === defaultWeeks(from.org) ? defaultWeeks(next?.slug) : from.weeks
    return { ...from, org: next?.slug, weeks }
  }

  // The phone's filter sheet keeps a draft and applies it on "Show N events".
  const [sheetOpen, setSheetOpen] = useState(false)
  const [draft, setDraft] = useState<EventsState>(base)
  const draftRows = useQuery(
    api.events.list,
    // Browser only, so it may count talks.cam-derived events too (G1).
    sheetOpen
      ? { ...eventListArgs(draft, eventsWindow(draft, today, termEnd)), talksCam: "include" }
      : "skip",
  )
  const draftCount = draftRows
    ? (() => {
        // The count the page will show after "Show N": the list counts the
        // events starting on its days (not the folded "already on" ones);
        // the week and month grids count every event they load.
        const span = eventsWindow(draft, today, termEnd)
        return draftRows.filter(
          (event) =>
            matchesEventQuery(event, draft.q) &&
            (draft.view === "list"
              ? event.startsAt >= span.from && londonIsoDate(event.startsAt) <= span.shown.last
              : true),
        ).length
      })()
    : undefined
  const draftOrg = draft.org
    ? (knownOrgs[draft.org] ?? { key: `org-${draft.org}`, slug: draft.org, name: draft.org })
    : null

  const sheet = (
    <FilterSheet
      open={sheetOpen}
      onOpenChange={(open) => {
        if (open) setDraft(base)
        setSheetOpen(open)
      }}
      trigger={
        <button
          type="button"
          className={cn(
            "inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium sm:h-8 lg:hidden",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            filterCount > 0 ? "border-events bg-events-tint text-events" : "bg-card",
          )}
        >
          <SlidersHorizontalIcon aria-hidden className="size-3.5" />
          Filters
          {filterCount > 0 && <span className="font-mono tabular-nums">· {filterCount}</span>}
        </button>
      }
      count={draftCount}
      noun={["event", "events"]}
      accent="events"
      onApply={() => {
        apply(draft, { scroll: true })
        setSheetOpen(false)
      }}
      onClear={() =>
        setDraft({
          ...draft,
          categories: [],
          eventTypes: [],
          collegeKeys: [],
          org: undefined,
          takingPart: false,
          university: "all",
        })
      }
      clearDisabled={activeEventFilterCount(draft) === 0}
    >
      <div className="flex flex-col gap-7">
        <FacetChips
          legend="Type"
          options={EVENT_TYPES.map((value) => ({ value, label: EVENT_TYPE_LABELS[value] }))}
          selected={draft.eventTypes}
          onToggle={(value, on) => setDraft(toggle(draft, "eventTypes", value, on))}
        />
        <FacetChips
          legend="Whose events"
          options={UNIVERSITY_OPTIONS.map(({ value, label }) => ({ value, label }))}
          selected={[draft.university]}
          onToggle={(value, on) => {
            const university = (on ? value : "all") as UniversityView
            setDraft(
              university === "only"
                ? { ...draft, university, categories: [], collegeKeys: [], org: undefined }
                : { ...draft, university },
            )
          }}
        />
        {/* The reason sits outside the dimmed fieldset: only the controls fade. */}
        {draft.university === "only" && (
          <p id="no-organiser-filters" className="-mb-4 text-sm text-muted-foreground">
            {NO_ORGANISER_FILTERS}
          </p>
        )}
        <fieldset
          disabled={draft.university === "only"}
          aria-describedby={draft.university === "only" ? "no-organiser-filters" : undefined}
          className="flex flex-col gap-7 disabled:opacity-60"
        >
          <FacetChips
            legend="Society category"
            options={CATEGORIES.map((value) => ({ value, label: CATEGORY_LABELS[value] }))}
            selected={draft.categories}
            onToggle={(value, on) => setDraft(toggle(draft, "categories", value, on))}
          />
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-xs font-medium tracking-wider text-muted-foreground uppercase">
              Society
            </legend>
            <OrgPicker
              value={draftOrg}
              label="Society"
              placeholder="Any society"
              onChange={(next) => setDraft(pickOrg(next, draft))}
            />
          </fieldset>
        </fieldset>
        <FacetChips
          legend="Someone else’s events"
          options={[{ value: "show", label: "Include events societies take part in" }]}
          selected={draft.takingPart ? ["show"] : []}
          onToggle={(_, on) => setDraft({ ...draft, takingPart: on })}
        />
        <fieldset
          disabled={draft.university === "only"}
          aria-describedby={draft.university === "only" ? "no-organiser-filters" : undefined}
          className="disabled:opacity-60"
        >
          <FacetChips
            legend="College"
            options={colleges.map((college) => ({ value: college.key, label: college.name }))}
            selected={draft.collegeKeys}
            onToggle={(value, on) => setDraft(toggle(draft, "collegeKeys", value, on))}
          />
        </fieldset>
      </div>
    </FilterSheet>
  )

  // --- the header ------------------------------------------------------------------------
  // The header sums up what is on (before the search box narrows it).
  const onShown = all.filter((event) => {
    const day = londonIsoDate(event.startsAt)
    return day >= window_.shown.first && day <= window_.shown.last
  })
  // Societies are counted from the student groups credited; the University's
  // own listings (no organiser) are counted apart (ENG-24).
  const societies = new Set(
    onShown.filter((event) => !event.fromUniversity).flatMap((e) => e.organisers.map((o) => o.key)),
  ).size
  const fromUniversity = onShown.filter((event) => event.fromUniversity).length
  // "from 12 societies and clubs · 4 from the University" (ENG-24).
  const whose = universityOnly
    ? " in the University’s public events programme"
    : societies > 0
      ? ` from ${plural(societies, "society", "societies")} and clubs${fromUniversity > 0 ? ` · ${fromUniversity} from the University` : ""}`
      : fromUniversity > 0
        ? `, ${fromUniversity} from the University`
        : ""
  const spanText =
    window_.shown.first === window_.shown.last
      ? formatDayShort(window_.shown.first)
      : `${formatDayShort(window_.shown.first)} – ${formatDayShort(window_.shown.last)}`
  const when = window_.preset
    ? PRESET_PHRASES[window_.preset]
    : state.date && state.date !== today
      ? `from ${formatDayShort(state.date)}`
      : state.weeks > 1
        ? `in the next ${state.weeks} weeks`
        : "in the next seven days"
  // While a new window loads (stale), the last window's count would read as
  // the new one's ("61 events for the rest of term" was one week's).
  const headline =
    loading || stale
      ? universityOnly
        ? "What the University of Cambridge lists in its public events programme: talks, exhibitions, tours and more."
        : "What Cambridge societies and clubs have published: socials, shows, matches, formals and more."
      : list
        ? `${plural(onShown.length, "event", "events")} ${when}${whose}.`
        : universityOnly
          ? "The University of Cambridge’s public events, a week or a month at a glance."
          : "Socials, shows, matches and formals from Cambridge societies and clubs, a week or a month at a glance."
  const anchor = state.date ?? today
  const nextWeekFirst = addDays(window_.shown.last, 1)
  // "Show next week" and "From <day>": real links for readers, robots.txt
  // traps for crawlers (lib/crawl-traps.ts).
  const nextWeekHref = eventsHref({
    ...base,
    preset: undefined,
    date: state.preset ? undefined : state.date,
    weeks: state.weeks + 1,
  })
  const fromNextWeekHref = eventsHref({ ...base, date: nextWeekFirst, weeks: 1 })
  const showsTalks = state.eventTypes.includes("talk")

  const viewSwitch = (
    <ToggleGroup
      type="single"
      value={state.view}
      onValueChange={(value) =>
        value &&
        apply(
          { ...base, view: value as CalendarView, preset: undefined, weeks: 1 },
          { scroll: true },
        )
      }
      aria-label="Calendar view"
      className="shrink-0 rounded-full border bg-card p-0.5"
    >
      {VIEWS.map(({ value, label, icon: Icon }) => (
        <ToggleGroupItem
          key={value}
          value={value}
          aria-label={`${label} view`}
          className="h-11 min-w-11 rounded-full px-3 text-[13px] data-[state=on]:bg-foreground data-[state=on]:text-background sm:h-8 sm:min-w-0"
        >
          <Icon aria-hidden />
          <span className="hidden sm:inline">{label}</span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )

  const stickyTop = `calc(var(--site-header-height, 4rem) + ${barHeight}px)`

  return (
    <div style={{ "--events-bar": `${barHeight}px` } as React.CSSProperties}>
      <header className="border-b bg-card/40">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 pt-8 pb-5 sm:px-6 sm:pt-12">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="flex max-w-3xl flex-col gap-2.5">
              <p className="flex items-center gap-2 font-mono text-[0.6875rem] font-medium tracking-[0.14em] text-events uppercase">
                <span aria-hidden className="h-px w-6 bg-events" />
                What’s on
                <span aria-hidden className="opacity-50">
                  ·
                </span>
                <span>{termWeekTag(today, terms) ?? formatDayShort(today)}</span>
              </p>
              <h1
                className={cn(
                  "font-serif leading-[1.02] font-normal tracking-[-0.025em] text-balance",
                  org ? "text-[clamp(2.3rem,5.8vw,4rem)]" : "text-[clamp(2.6rem,7.2vw,4.75rem)]",
                )}
              >
                {org ? (
                  <>
                    Events from <span className="text-events">{org.name}</span>
                  </>
                ) : universityOnly ? (
                  <>
                    Events from <span className="text-events">the University</span>
                  </>
                ) : (
                  <>
                    Cambridge student events<span className="text-events">.</span>
                  </>
                )}
              </h1>
              <p
                className="max-w-2xl text-pretty text-muted-foreground sm:text-lg"
                aria-live="polite"
              >
                {headline}
              </p>
              <UniversitySwitch
                value={state.university}
                onChange={pickUniversity}
                className="mt-1 self-start"
              />
            </div>
            <Link
              href="/talks"
              className="group flex max-w-sm items-center gap-3 self-start rounded-full border border-talks/40 bg-talks-tint/60 py-1.5 pr-4 pl-1.5 text-sm transition-colors duration-150 hover:border-talks focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:rounded-2xl sm:py-3 sm:pl-4 lg:self-end"
            >
              <span
                aria-hidden
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-talks font-serif text-base text-talks-foreground sm:size-9 sm:text-lg"
              >
                T
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="hidden font-mono text-[0.625rem] font-medium tracking-[0.14em] text-talks uppercase sm:block">
                  New · the lecture list
                </span>
                <span className="font-medium">
                  Academic talks now have their own page
                  <ArrowRightIcon
                    aria-hidden
                    className="ml-1 inline size-3.5 align-[-2px] transition-transform group-hover:translate-x-0.5"
                  />
                </span>
              </span>
            </Link>
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-7xl px-4 sm:px-6">
        <div
          ref={(element) => {
            bar.current = element
            resultsTop.current = element
          }}
          className="sticky top-[var(--site-header-height,4rem)] z-30 -mx-4 flex scroll-mt-[var(--site-header-height,4rem)] flex-col gap-2.5 border-b bg-background/95 px-4 pt-3 pb-2.5 backdrop-blur supports-backdrop-filter:bg-background/80 sm:-mx-6 sm:px-6"
        >
          <div className="flex items-center gap-2">
            <SearchField
              size="lg"
              className="min-w-0 flex-1"
              value={state.q ?? ""}
              label="Search events"
              placeholder="Search events, societies or venues"
              onSearch={(q) =>
                apply({ ...base, q: q || undefined }, { replace: Boolean(state.q && q) })
              }
            />
            <div className="hidden items-center gap-1.5 lg:flex">
              <FacetPopover
                label="Type"
                accent="events"
                options={EVENT_TYPES.map((value) => ({ value, label: EVENT_TYPE_LABELS[value] }))}
                selected={state.eventTypes}
                onToggle={(value, on) => apply(toggle(base, "eventTypes", value, on))}
              />
              {/* The University view has no organiser cards to filter by. */}
              <fieldset
                disabled={universityOnly}
                title={universityOnly ? NO_ORGANISER_FILTERS : undefined}
                className="flex items-center gap-1.5 disabled:opacity-50"
              >
                <legend className="sr-only">Society filters</legend>
                <FacetPopover
                  label="Category"
                  accent="events"
                  options={CATEGORIES.map((value) => ({ value, label: CATEGORY_LABELS[value] }))}
                  selected={state.categories}
                  onToggle={(value, on) => apply(toggle(base, "categories", value, on))}
                />
                <FacetPopover
                  label="College"
                  accent="events"
                  options={colleges.map((college) => ({ value: college.key, label: college.name }))}
                  selected={state.collegeKeys}
                  onToggle={(value, on) => apply(toggle(base, "collegeKeys", value, on))}
                />
                <OrgPicker
                  className="w-44 [&_button]:rounded-full [&_button]:bg-card"
                  value={org}
                  label="Society"
                  placeholder="Any society"
                  onChange={(next) => apply(pickOrg(next, base))}
                />
              </fieldset>
              <button
                type="button"
                aria-pressed={state.takingPart}
                onClick={() => apply({ ...base, takingPart: !state.takingPart })}
                title="Someone else’s events (a CTF, a fair, a conference) a society lists because it takes part"
                className={cn(
                  "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-dashed px-3 text-[13px] whitespace-nowrap transition-colors duration-150",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                  state.takingPart
                    ? "border-events bg-events-tint font-medium text-events"
                    : "border-foreground/30 bg-card hover:border-foreground/60",
                )}
              >
                <ArrowUpRightIcon aria-hidden className="size-3.5" />
                Include taking part
              </button>
            </div>
          </div>
          <FilterChipStrip
            className="lg:hidden"
            leading={sheet}
            applied={applied}
            quick={quick}
            onClear={applied.length > 0 || state.q ? clearAll : undefined}
          />
          {universityOnly && (
            <p className="hidden text-xs text-muted-foreground lg:block">{NO_ORGANISER_FILTERS}</p>
          )}
          {applied.length > 0 && (
            <FilterChipStrip
              className="hidden lg:flex"
              applied={applied}
              quick={[]}
              onClear={clearAll}
            />
          )}
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-x-0 -bottom-px h-0.5 origin-left bg-events transition-[opacity,transform] duration-500",
              stale ? "scale-x-75 opacity-100" : "scale-x-0 opacity-0 duration-150",
            )}
          />
        </div>

        <div
          className={cn(
            "grid grid-cols-[minmax(0,1fr)] gap-x-12 pt-5 pb-14",
            list && "lg:grid-cols-[minmax(0,1fr)_20rem]",
          )}
        >
          {list && (
            <aside
              aria-label="Dates"
              className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-[calc(var(--site-header-height,4rem)+var(--events-bar)+1.25rem)] lg:order-2 lg:self-start"
            >
              <div className="rounded-2xl border bg-card p-3 sm:p-4">
                <WeekStrip
                  days={dayCounts(stripDays, loadedByDay)}
                  selected={focusDay && stripDays.includes(focusDay) ? focusDay : undefined}
                  range={window_.preset ? window_.shown : undefined}
                  onSelect={pickDay}
                  today={today}
                  minDate={today}
                  termLabel={stripRangeLabel(stripDays, terms)}
                  onPrev={stripPrev}
                  onNext={stripNext}
                  prevDisabled={pageIndex === 0 && window_.days[0] <= today}
                  nextDisabled={atLastWeek}
                  noun={["event", "events"]}
                  accent="events"
                />
              </div>
              <DatePresets
                value={window_.preset}
                available={availablePresets(today, termEnd, window_.preset)}
                onChange={(preset) =>
                  apply({ ...base, preset, date: undefined, weeks: 1 }, { scroll: true })
                }
                accent="events"
              />
              {camOnly !== undefined && camOnly > 0 && (
                <p className="flex gap-2.5 rounded-2xl border border-dashed p-4 text-sm text-muted-foreground">
                  <LockIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-foreground" />
                  <span>
                    <span className="font-mono text-foreground tabular-nums">{camOnly}</span>{" "}
                    Cambridge-only {camOnly === 1 ? "event is" : "events are"} listed around these
                    dates.{" "}
                    <Link
                      {...linkProps(camSignInHref(eventsHref(base)))}
                      className="font-medium text-foreground underline underline-offset-4"
                    >
                      Sign in with your @cam.ac.uk email
                    </Link>{" "}
                    to see {camOnly === 1 ? "it" : "them"}.
                  </span>
                </p>
              )}
            </aside>
          )}

          <div className="flex min-w-0 flex-col" aria-busy={stale || loading}>
            <div className="flex flex-wrap items-center justify-between gap-3 pt-5 pb-1 lg:pt-0">
              {list ? (
                // While a new window loads, say so rather than pair the last
                // window's count with the new range (as talks-browser does).
                <p className="text-sm text-muted-foreground" aria-live="polite">
                  {stale || loading ? (
                    "Counting…"
                  ) : (
                    <>
                      <span className="font-mono text-foreground tabular-nums">{shownCount}</span>{" "}
                      {shownCount === 1 ? "event" : "events"}
                      {state.q && (
                        <>
                          {" "}
                          matching <span className="text-foreground">“{state.q}”</span>
                        </>
                      )}{" "}
                      · {spanText}
                    </>
                  )}
                </p>
              ) : (
                <div className="flex items-center gap-1">
                  <Link
                    {...linkProps(
                      eventsHref({ ...base, date: shiftAnchor(state.view, anchor, -1) }),
                    )}
                    scroll={false}
                    aria-label={state.view === "week" ? "Previous week" : "Previous month"}
                    className="inline-flex size-11 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring sm:size-9"
                  >
                    <ChevronLeftIcon aria-hidden className="size-4" />
                  </Link>
                  <Link
                    {...linkProps(eventsHref({ ...base, date: undefined }))}
                    scroll={false}
                    className="inline-flex h-11 items-center rounded-full border bg-card px-3.5 text-[13px] font-medium hover:border-foreground/40 focus-visible:outline-2 focus-visible:outline-ring sm:h-8"
                  >
                    Today
                  </Link>
                  <Link
                    {...linkProps(
                      eventsHref({ ...base, date: shiftAnchor(state.view, anchor, 1) }),
                    )}
                    scroll={false}
                    aria-label={state.view === "week" ? "Next week" : "Next month"}
                    className="inline-flex size-11 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring sm:size-9"
                  >
                    <ChevronRightIcon aria-hidden className="size-4" />
                  </Link>
                  <h2
                    className="ml-2 font-serif text-xl leading-tight sm:text-2xl"
                    aria-live="polite"
                  >
                    {state.view === "month"
                      ? formatMonth(anchor)
                      : formatRange("week", window_, anchor)}
                  </h2>
                  <span className="ml-3 hidden font-mono text-[0.6875rem] tracking-wide text-muted-foreground uppercase sm:inline">
                    {plural(matching.length, "event", "events")}
                  </span>
                </div>
              )}
              {viewSwitch}
            </div>

            {showsTalks && (
              <p className="mt-3 flex gap-3 rounded-2xl border border-talks/40 bg-talks-tint/50 px-4 py-3 text-sm">
                <span aria-hidden className="mt-1 size-2 shrink-0 rounded-full bg-talks" />
                <span>
                  These are talks societies run and talks in the University’s public events
                  programme. For department seminars and lectures across Cambridge, by School and
                  department, see{" "}
                  <Link
                    href="/talks"
                    className="font-medium text-talks underline underline-offset-4"
                  >
                    Talks
                  </Link>
                  .
                </span>
              </p>
            )}

            {!list && camOnly !== undefined && camOnly > 0 && (
              <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
                <LockIcon aria-hidden className="size-4 shrink-0" />
                <span>
                  {plural(camOnly, "Cambridge-only event", "Cambridge-only events")} around these
                  dates —{" "}
                  <Link
                    {...linkProps(camSignInHref(eventsHref(base)))}
                    className="font-medium text-foreground underline underline-offset-4"
                  >
                    sign in with your @cam.ac.uk email
                  </Link>
                  .
                </span>
              </p>
            )}

            {ongoing.length > 0 && (
              <div className="mt-4">
                <Ongoing events={ongoing} hrefFor={eventHref} onSelect={openEvent} />
              </div>
            )}

            {loading ? (
              <div className="flex flex-col">
                <Skeleton className="mt-4 mb-1 h-7 w-48" />
                {Array.from({ length: 6 }, (_, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: placeholders
                  <EventRowSkeleton key={index} />
                ))}
              </div>
            ) : !list ? (
              <div className={cn("mt-4 transition-opacity", stale && "opacity-80")}>
                {state.view === "week" ? (
                  <EventWeekGrid
                    days={window_.days}
                    byDay={loadedByDay}
                    today={today}
                    eventHref={eventHref}
                    onSelect={openEvent}
                    dayHref={dayHref}
                  />
                ) : (
                  <EventMonthGrid
                    days={window_.days}
                    byDay={loadedByDay}
                    today={today}
                    month={anchor.slice(0, 7)}
                    terms={terms}
                    eventHref={eventHref}
                    onSelect={openEvent}
                    dayHref={dayHref}
                  />
                )}
              </div>
            ) : agenda.length === 0 ? (
              <EmptyEvents
                q={state.q}
                chips={applied}
                weeks={state.weeks}
                termTag={termWeekTag(window_.shown.first, terms)}
                hasPreset={Boolean(window_.preset)}
                onSearchWider={() =>
                  apply({ ...base, preset: undefined, weeks: SEARCH_WEEKS }, { replace: true })
                }
                onDropQuery={() => apply({ ...base, q: undefined })}
                onClear={clearAll}
                onNextWeek={extendWeek}
                canExtend={state.weeks < MAX_LIST_WEEKS}
                universityOnly={universityOnly}
              />
            ) : (
              <div className="flex flex-col">
                {agenda.map(([day, dayEvents]) => {
                  const heading = dayHeading(day, today)
                  const tag = termWeekTag(day, terms)
                  const weekday = LONG_WEEKDAYS[(new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7]
                  return (
                    <section
                      key={day}
                      id={`day-${day}`}
                      aria-labelledby={`day-${day}-heading`}
                      style={{ scrollMarginTop: stickyTop }}
                      className="flex flex-col"
                    >
                      <h2
                        id={`day-${day}-heading`}
                        style={{ top: stickyTop }}
                        className="sticky z-20 -mx-4 flex items-baseline justify-between gap-3 border-b bg-background/95 px-4 pt-4 pb-2 backdrop-blur supports-backdrop-filter:bg-background/85 sm:-mx-6 sm:px-6 lg:mx-0 lg:px-0"
                      >
                        <span className="flex min-w-0 items-baseline gap-2">
                          <span
                            className={cn(
                              "font-serif text-xl leading-tight sm:text-2xl",
                              day === today && "text-events",
                            )}
                          >
                            {heading.relative ?? weekday}
                          </span>
                          <span className="truncate text-sm text-muted-foreground">
                            {heading.relative
                              ? `· ${heading.date}`
                              : heading.date.replace(/^\w+ /, "")}
                          </span>
                        </span>
                        <span className="flex shrink-0 items-baseline gap-3 font-mono text-[0.6875rem] tracking-wide text-muted-foreground uppercase">
                          {tag && <span className="hidden sm:inline">{tag}</span>}
                          <span>{plural(dayEvents.length, "event", "events")}</span>
                        </span>
                      </h2>
                      <ul className="flex flex-col divide-y divide-dashed">
                        {dayEvents.map((event) => (
                          <li key={event.key}>
                            <EventRow
                              event={event}
                              href={eventHref(event)}
                              onSelect={(target) => openEvent(event, target)}
                            />
                          </li>
                        ))}
                      </ul>
                    </section>
                  )
                })}

                <div
                  id="events-agenda-end"
                  style={{ scrollMarginTop: stickyTop }}
                  className="flex flex-col items-center gap-3 border-t pt-8"
                >
                  <p className="text-center text-sm text-muted-foreground">
                    {window_.preset
                      ? `That is everything listed ${PRESET_PHRASES[window_.preset]}.`
                      : `That is everything listed until ${formatDayShort(window_.shown.last)}.`}
                  </p>
                  {window_.preset ? (
                    <Button
                      variant="outline"
                      className="h-11 rounded-full px-6"
                      onClick={() =>
                        apply(
                          {
                            ...base,
                            preset: undefined,
                            date: window_.shown.first === today ? undefined : window_.shown.first,
                            weeks: Math.min(MAX_LIST_WEEKS, Math.ceil(shownDays.length / 7) + 1),
                          },
                          { replace: true },
                        )
                      }
                    >
                      Keep going: the week after
                      <ArrowRightIcon data-icon="inline-end" />
                    </Button>
                  ) : state.weeks < MAX_LIST_WEEKS ? (
                    // A real link for readers, handled in place on a click;
                    // rel=nofollow and robots-disallowed for crawlers, a trap
                    // (bot policy 2026-11-03: event pages are found through
                    // the sitemap and the society profiles instead).
                    <Button
                      asChild
                      variant="outline"
                      className="h-11 rounded-full border-events/50 px-6 hover:border-events hover:bg-events-tint/60 aria-disabled:pointer-events-none aria-disabled:opacity-50"
                    >
                      <a
                        href={nextWeekHref}
                        rel={crawlerTrapRel(nextWeekHref)}
                        aria-disabled={stale || undefined}
                        onClick={inPlace(extendWeek)}
                      >
                        {stale && <Spinner data-icon="inline-start" />}
                        Show next week
                        <span className="font-mono text-xs text-muted-foreground tabular-nums">
                          {formatDayShort(nextWeekFirst)} –{" "}
                          {formatDayShort(addDays(nextWeekFirst, 6))}
                        </span>
                      </a>
                    </Button>
                  ) : (
                    <Button asChild variant="outline" className="h-11 rounded-full px-6">
                      <a
                        href={fromNextWeekHref}
                        rel={crawlerTrapRel(fromNextWeekHref)}
                        onClick={inPlace(() =>
                          apply({ ...base, date: nextWeekFirst, weeks: 1 }, { scroll: true }),
                        )}
                      >
                        From {formatDayShort(nextWeekFirst)}
                        <ArrowRightIcon data-icon="inline-end" />
                      </a>
                    </Button>
                  )}
                </div>
              </div>
            )}

            <p className="mt-10 flex flex-wrap gap-x-1 text-xs text-muted-foreground">
              <span>
                Times are UK time. Events come from societies’ own calendars, listings and mailing
                lists, and from the University of Cambridge’s public events programme; each shows
                its source.
              </span>
              {state.takingPart ? (
                <span>
                  Dashed events, marked “Taking part”, are someone else’s that a society lists
                  because it takes part.{" "}
                  <button
                    type="button"
                    onClick={() => apply({ ...base, takingPart: false })}
                    className="inline-flex min-h-11 items-center font-medium text-foreground underline underline-offset-4 sm:min-h-0"
                  >
                    Hide them
                  </button>
                </span>
              ) : (
                <span>
                  Someone else’s events a society only takes part in (a CTF, a fair, a conference)
                  are left out.{" "}
                  <button
                    type="button"
                    onClick={() => apply({ ...base, takingPart: true })}
                    className="inline-flex min-h-11 items-center font-medium text-foreground underline underline-offset-4 sm:min-h-0"
                  >
                    Include them
                  </button>
                </span>
              )}
            </p>
          </div>
        </div>
      </div>

      <Sheet open={openKey !== undefined} onOpenChange={(open) => !open && closeEvent()}>
        <SheetContent
          showCloseButton={false}
          onCloseAutoFocus={(event) => {
            const row = opener.current
            opener.current = null
            if (row?.isConnected) {
              event.preventDefault()
              row.focus({ preventScroll: true })
            }
          }}
          className="w-full overflow-y-auto data-[side=right]:w-full sm:max-w-lg data-[side=right]:sm:max-w-lg"
        >
          <SheetClose className="absolute top-2 right-2 z-10 inline-flex size-11 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            <XIcon aria-hidden className="size-4" />
            <span className="sr-only">Close</span>
          </SheetClose>
          {openData ? (
            <>
              <SheetHeader className="gap-2 px-5 pt-6 pr-14 sm:px-7 sm:pr-16">
                <EventEyebrow event={openData} />
                <SheetTitle
                  className={cn(
                    "font-serif text-[1.75rem] leading-[1.12] font-normal tracking-[-0.015em] text-balance",
                    openData.cancelled && "text-muted-foreground line-through",
                  )}
                >
                  <EventTitle title={openData.title} />
                </SheetTitle>
                <SheetDescription className="sr-only">Event details</SheetDescription>
              </SheetHeader>
              <div className="px-5 pb-10 sm:px-7">
                <EventDetails
                  event={openData}
                  venueName={openVenue}
                  pageUrl={`${SITE_URL}${eventPath(openData)}`}
                  termWeek={termWeekTag(londonIsoDate(openData.startsAt), terms)}
                />
                <Link
                  href={eventPath(openData)}
                  className="mt-6 inline-flex min-h-11 items-center gap-1 text-sm font-medium text-events underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                >
                  Open the event’s own page
                  <ArrowRightIcon aria-hidden className="size-3.5" />
                </Link>
              </div>
            </>
          ) : openData === null ? (
            <SheetHeader className="px-5 pt-6 pr-14 sm:px-7 sm:pr-16">
              <SheetTitle className="font-serif text-2xl font-normal">
                This event is not available
              </SheetTitle>
              <SheetDescription>
                {camSignIn ? (
                  <>
                    It may have been taken down, or it is a Cambridge-only event:{" "}
                    <Link
                      {...linkProps(camSignInHref(eventsHref({ ...base, event: openKey })))}
                      className="underline underline-offset-4"
                    >
                      sign in with your @cam.ac.uk email
                    </Link>{" "}
                    to see those.
                  </>
                ) : (
                  "It may have been taken down, or it is a Cambridge-only event, which stays hidden until Cambridge sign-in opens."
                )}
              </SheetDescription>
            </SheetHeader>
          ) : (
            <div className="flex flex-col gap-4 px-5 pt-6 sm:px-7" aria-busy>
              <SheetHeader className="p-0 pr-14">
                <SheetTitle
                  className={cn(
                    "font-serif text-[1.75rem] leading-[1.12] font-normal",
                    !openPlaceholder && "sr-only",
                  )}
                >
                  {openPlaceholder ? (
                    <EventTitle title={openPlaceholder.title} />
                  ) : (
                    "Loading the event"
                  )}
                </SheetTitle>
                <SheetDescription className="sr-only">Loading the details</SheetDescription>
              </SheetHeader>
              {!openPlaceholder && <Skeleton className="h-8 w-3/4" />}
              <Skeleton className="h-16 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-32 w-full" />
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}

function EmptyEvents({
  q,
  chips,
  weeks,
  termTag,
  hasPreset,
  onSearchWider,
  onDropQuery,
  onClear,
  onNextWeek,
  canExtend,
  universityOnly,
}: {
  q?: string
  chips: AppliedChip[]
  weeks: number
  termTag?: string
  hasPreset: boolean
  onSearchWider: () => void
  onDropQuery: () => void
  onClear: () => void
  onNextWeek: () => void
  canExtend: boolean
  universityOnly: boolean
}) {
  const filtered = chips.length > 0 || Boolean(q)
  // The University view alone is a scope, not a filter that came up empty.
  const justUniversity = universityOnly && chips.length === 1 && !q
  return (
    <div className="mt-4 flex flex-col items-center gap-5 rounded-2xl border border-dashed px-6 py-12 text-center">
      <PuntMark />
      <div className="flex max-w-md flex-col gap-1.5">
        <h2 className="font-serif text-2xl font-normal">
          {filtered && !justUniversity
            ? "Nothing on with those"
            : `Nothing on${termTag ? ` — unusual for ${termTag.replace(" · ", " ")}` : ""}`}
        </h2>
        <p className="text-sm text-muted-foreground">
          {q
            ? `No event on these days has “${q}” in its title, organiser or venue.`
            : justUniversity
              ? "The University’s public events programme lists nothing for these days."
              : filtered
                ? "No event on these days matches all of these. Drop a filter, or look further ahead."
                : "No society has listed anything for these days yet. Calendars are added as their feeds are found."}
        </p>
      </div>
      <div className="flex max-w-xl flex-wrap justify-center gap-2">
        {q && weeks < SEARCH_WEEKS && (
          <Button variant="outline" size="sm" className="h-11 sm:h-9" onClick={onSearchWider}>
            Search the next four weeks
          </Button>
        )}
        {!q && !hasPreset && canExtend && (
          <Button variant="outline" size="sm" className="h-11 sm:h-9" onClick={onNextWeek}>
            Show next week
          </Button>
        )}
        {q && (
          <Button variant="outline" size="sm" className="h-11 sm:h-9" onClick={onDropQuery}>
            Drop the search “{q}”
          </Button>
        )}
        {chips.map((chip) => (
          <Button
            key={chip.key}
            variant="outline"
            size="sm"
            className="h-11 sm:h-9"
            onClick={chip.onRemove}
          >
            Drop “{chip.label}”
          </Button>
        ))}
        {filtered && (
          <Button variant="ghost" size="sm" className="h-11 sm:h-9" onClick={onClear}>
            Clear all
          </Button>
        )}
      </div>
    </div>
  )
}
