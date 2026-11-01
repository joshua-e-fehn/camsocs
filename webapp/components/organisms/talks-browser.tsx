"use client"

import { type Preloaded, usePreloadedQuery } from "convex/react"
import {
  ArrowRightIcon,
  CalendarSyncIcon,
  LibraryIcon,
  SlidersHorizontalIcon,
  VideoIcon,
  XIcon,
} from "lucide-react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { useEffect, useMemo, useRef, useState } from "react"
import { DatePresets } from "@/components/molecules/date-presets"
import { DepartmentCombobox } from "@/components/molecules/department-combobox"
import { FacetChips } from "@/components/molecules/facet-chips"
import {
  type AppliedChip,
  FilterChipStrip,
  type QuickChip,
} from "@/components/molecules/filter-chip-strip"
import { FilterSheet } from "@/components/molecules/filter-sheet"
import { SchoolRail } from "@/components/molecules/school-rail"
import { SearchField } from "@/components/molecules/search-field"
import { TalkDetails, TalkEyebrow } from "@/components/molecules/talk-details"
import { TalkRow, TalkRowSkeleton } from "@/components/molecules/talk-row"
import { TalksSubscribeDialog } from "@/components/molecules/talks-subscribe-dialog"
import { WeekStrip } from "@/components/molecules/week-strip"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
import type { api } from "@/convex/_generated/api"
import {
  type InitialTalkPage,
  useNextTalk,
  useTalk,
  useTalkAgenda,
  useTalkDayCounts,
  useTalkSearchResults,
} from "@/hooks/convex/talks"
import { addDays, DAY_MS, formatDayShort, londonIsoDate, startOfWeek } from "@/lib/calendar"
import { availablePresets, currentTermEnd } from "@/lib/date-presets"
import { SITE_NAME, SITE_URL } from "@/lib/site"
import {
  dayHeading,
  groupTalksByDay,
  SCHOOL_TONE,
  schoolCounts,
  TALK_KIND_PLURAL,
  TALK_SCHOOL_SHORT,
  type TalkListItem,
  type TalkOverview,
} from "@/lib/talks"
import {
  activeTalkFilterCount,
  matchesWindow,
  parseTalksParams,
  TALKS_SEARCH_LIMIT,
  type TalksState,
  talksCountArgs,
  talksDayCountArgs,
  talksHref,
  talksListArgs,
  talksSearchArgs,
  talksWindow,
} from "@/lib/talks-url-state"
import type { TermDatesRow } from "@/lib/term-week"
import type { SearchParams } from "@/lib/url-state"
import { cn } from "@/lib/utils"
import { TALK_KIND_LABELS, TALK_KINDS, TALK_SCHOOL_LABELS, type TalkKind } from "@/lib/vocab"
import {
  shiftWeek,
  stripAnchor,
  stripTermLabel,
  termWeekTag,
  weekDays,
  withCounts,
} from "@/lib/week-strip"

const LONG_WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
/** How far ahead the week strip pages (the list window is at most 186 days). */
const STRIP_WEEKS_AHEAD = 25
/** The empty state looks this far past the window for the next talk. */
const NEXT_TALK_DAYS = 120

function searchParamsObject(params: URLSearchParams): SearchParams {
  const out: SearchParams = {}
  for (const key of new Set(params.keys())) {
    const all = params.getAll(key)
    out[key] = all.length > 1 ? all : all[0]
  }
  return out
}

/** A plain left click is handled in place; a modified one opens as usual. */
function isPlainClick(event: React.MouseEvent) {
  return !(event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`
}

/** The page title for a state: "Talks", "Computer Science talks", "Lectures
 * · Technology talks". */
function talksTitle(state: TalksState, departmentName?: string): string {
  const scope = departmentName ?? (state.school ? TALK_SCHOOL_SHORT[state.school] : undefined)
  const kind = state.kind ? TALK_KIND_LABELS[state.kind] : undefined
  if (!scope && !kind) return "Talks"
  return [kind && `${kind}s`, scope && `${scope} talks`].filter(Boolean).join(" · ") || "Talks"
}

/** A small line drawing of a lecture theatre's tiered benches and lectern
 * over the river: the empty state's mark. */
function TheatreMark() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 120 52"
      className="h-13 w-30 text-talks"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <path d="M14 34c10-14 28-22 46-22s36 8 46 22" />
      <path d="M26 34c8-9 20-14 34-14s26 5 34 14" opacity=".7" />
      <path d="M38 34c6-5 13-7 22-7s16 2 22 7" opacity=".45" />
      <path d="M56 34v-6h8v6M60 28v-3" />
      <path d="M8 34h104" />
      <path
        d="M4 44c10-4 18 4 28 0s18 4 28 0 18 4 28 0 18 4 28 0"
        stroke="var(--backs)"
        strokeWidth="2"
      />
    </svg>
  )
}

/**
 * The /talks browser (talks-redesign-spec §6). The URL is the state
 * (lib/talks-url-state.ts): every change writes it with `history.pushState`,
 * which Next folds into `useSearchParams`, and the live Convex queries
 * follow over the open socket — no server round trip, and the previous
 * results stay on screen (with a thin indigo progress line) until the next
 * arrive. The server page preloads the first view.
 *
 * Layout: serif header with the pillar's numbers → School rail → a sticky
 * search bar (desktop: department, kind and online beside it; phone: a
 * "Filters" bottom sheet and chips) → the agenda, day by day under sticky
 * day headers, beside (desktop) or under (phone) the week strip and date
 * presets. A talk opens in a side sheet (`?talk=`, so back closes it) and
 * has its own page at /talks/[key].
 */
export function TalksBrowser({
  today,
  terms,
  overview,
  preloadedDepartments,
  initialPage,
  preloadedSearch,
  preloadedWeek,
  preloadedTotal,
  preloadedTalk,
}: {
  /** London's today, from the server, so both renders agree. */
  today: string
  terms: TermDatesRow[]
  overview: TalkOverview | null
  preloadedDepartments: Preloaded<typeof api.talks.departments>
  initialPage?: InitialTalkPage
  preloadedSearch?: Preloaded<typeof api.talks.search>
  preloadedWeek?: Preloaded<typeof api.talks.dayCounts>
  preloadedTotal?: Preloaded<typeof api.talks.dayCounts>
  preloadedTalk?: Preloaded<typeof api.talks.get>
}) {
  const searchParams = useSearchParams()
  const state = useMemo(
    () => parseTalksParams(searchParamsObject(new URLSearchParams(searchParams.toString()))),
    [searchParams],
  )
  const base: TalksState = { ...state, talk: undefined }
  const termEnd = useMemo(() => currentTermEnd(today, terms), [today, terms])
  const span = talksWindow(state, today, termEnd)
  const departments = usePreloadedQuery(preloadedDepartments)
  const department = departments.find((item) => item.slug === state.dept)
  const railSchool = state.school ?? department?.school
  const perSchool = useMemo(() => schoolCounts(departments), [departments])
  const totalUpcoming = useMemo(
    () => departments.reduce((sum, item) => sum + item.upcomingCount, 0),
    [departments],
  )

  // --- navigation ------------------------------------------------------------------------
  const resultsTop = useRef<HTMLDivElement>(null)
  const apply = (next: TalksState, { replace = false, scroll = false } = {}) => {
    const href = talksHref({ ...next, talk: undefined })
    if (replace) window.history.replaceState(null, "", href)
    else window.history.pushState(null, "", href)
    if (scroll) {
      const top = resultsTop.current
      if (top && top.getBoundingClientRect().top < 0) top.scrollIntoView({ block: "start" })
    }
  }
  const openedHere = useRef(false)
  useEffect(() => {
    if (!state.talk) openedHere.current = false
  }, [state.talk])
  // The row that opened the sheet, to take focus back when it closes (the
  // sheet has no Radix trigger, and closing is a history change).
  const opener = useRef<HTMLElement | null>(null)
  const openTalk = (key: string, from?: HTMLElement) => {
    openedHere.current = true
    opener.current = from ?? null
    window.history.pushState(null, "", talksHref({ ...base, talk: key }))
  }
  const closeTalk = () => {
    if (openedHere.current) window.history.back()
    else window.history.replaceState(null, "", talksHref(base))
  }

  const pageTitle = talksTitle(state, department?.shortName)
  useEffect(() => {
    document.title = `${pageTitle} · ${SITE_NAME}`
  }, [pageTitle])

  // --- data ------------------------------------------------------------------------------
  const agenda = useTalkAgenda(state.q ? "skip" : talksListArgs(state, span), initialPage)
  const search = useTalkSearchResults(
    state.q ? talksSearchArgs(state, span) : "skip",
    preloadedSearch,
  )
  const talks: TalkListItem[] = state.q
    ? (search.data ?? []).filter((talk) => matchesWindow(talk, state, span))
    : agenda.talks
  const loading = state.q ? search.data === undefined : agenda.status === "LoadingFirstPage"
  const stale = state.q ? search.stale : agenda.stale

  const count = talksCountArgs(state, span)
  const totals = useTalkDayCounts(state.q ? "skip" : count.args, preloadedTotal)
  // While the filters change, say so rather than show the last view's total.
  const total = state.q
    ? search.stale
      ? undefined
      : talks.length
    : totals.stale
      ? undefined
      : totals.data?.reduce((sum, day) => sum + day.count, 0)

  const anchorMonday = stripAnchor(span.first, span.last, today)
  const [stripMonday, setStripMonday] = useState(anchorMonday)
  const [seenAnchor, setSeenAnchor] = useState(anchorMonday)
  if (seenAnchor !== anchorMonday) {
    setSeenAnchor(anchorMonday)
    setStripMonday(anchorMonday)
  }
  const week = useTalkDayCounts(talksDayCountArgs(state, stripMonday), preloadedWeek)
  const stripDays = withCounts(weekDays(stripMonday), week.data)

  const exhausted = state.q ? true : agenda.status === "Exhausted"
  const nextTalk = useNextTalk(
    !loading && talks.length === 0 && exhausted && !state.q
      ? talksListArgs(state, {
          ...span,
          first: addDays(span.last, 1),
          from: span.to,
          to: span.to + NEXT_TALK_DAYS * DAY_MS,
        })
      : "skip",
  )
  const nextSearchHit = state.q
    ? (search.data ?? []).find(
        (talk) =>
          talk.startsAt >= span.to &&
          matchesWindow(talk, state, { ...span, to: Number.POSITIVE_INFINITY }),
      )
    : undefined
  const next = state.q ? nextSearchHit : nextTalk

  // A clock for "Now" / "in 25 min", only after mount (no hydration drift).
  const [now, setNow] = useState<number | undefined>(undefined)
  useEffect(() => {
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])

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

  // --- the open talk ---------------------------------------------------------------------
  const openKey = state.talk
  const openTalkData = useTalk(openKey, preloadedTalk)
  const openPlaceholder = talks.find((talk) => talk.key === openKey)

  // --- filters ---------------------------------------------------------------------------
  const setSchool = (school: TalksState["school"]) =>
    apply(
      {
        ...base,
        school,
        dept: school && department?.school === school ? state.dept : undefined,
      },
      { scroll: true },
    )
  const setDept = (slug: string | undefined, from: TalksState = base) => {
    const chosen = departments.find((item) => item.slug === slug)
    return {
      ...from,
      dept: slug,
      school: from.school && chosen && chosen.school !== from.school ? undefined : from.school,
    }
  }
  const filterCount = activeTalkFilterCount(state)
  const presets = availablePresets(today, termEnd, span.preset)

  const applied: AppliedChip[] = []
  if (state.school && !state.dept) {
    applied.push({
      key: "school",
      label: TALK_SCHOOL_SHORT[state.school],
      onRemove: () => apply({ ...base, school: undefined }),
    })
  }
  if (state.dept) {
    // An unknown slug (a stale link) selects nothing; name it so it can be dropped.
    applied.push({
      key: "dept",
      label: department?.shortName ?? "Unknown department",
      onRemove: () => apply({ ...base, dept: undefined }),
    })
  }
  if (state.kind) {
    applied.push({
      key: "kind",
      label: `${TALK_KIND_LABELS[state.kind]}s`,
      onRemove: () => apply({ ...base, kind: undefined }),
    })
  }
  if (state.online !== undefined) {
    applied.push({
      key: "online",
      label: state.online ? "Online or hybrid" : "In person",
      onRemove: () => apply({ ...base, online: undefined }),
    })
  }
  const quick: QuickChip[] = [
    ...(state.online === undefined
      ? [
          {
            key: "online",
            label: "Online or hybrid",
            onSelect: () => apply({ ...base, online: true }),
          },
        ]
      : []),
    ...(state.kind === undefined
      ? (["lecture", "workshop"] as const).map((kind) => ({
          key: kind,
          label: `${TALK_KIND_LABELS[kind]}s`,
          onSelect: () => apply({ ...base, kind }),
        }))
      : []),
  ]
  const clearAll = () => apply({ preset: state.preset, from: state.from })

  // The phone's filter sheet keeps a draft and applies it on "Show N talks".
  const [sheetOpen, setSheetOpen] = useState(false)
  const [draft, setDraft] = useState<TalksState>(base)
  const draftSpan = talksWindow(draft, today, termEnd)
  const draftTotals = useTalkDayCounts(
    sheetOpen && !draft.q ? talksCountArgs(draft, draftSpan).args : "skip",
  )
  const draftSearch = useTalkSearchResults(
    sheetOpen && draft.q ? talksSearchArgs(draft, draftSpan) : "skip",
  )
  const draftCount = draft.q
    ? draftSearch.data?.filter((talk) => matchesWindow(talk, draft, draftSpan)).length
    : draftTotals.data?.reduce((sum, day) => sum + day.count, 0)

  const kindOptions = TALK_KINDS.filter((kind) => kind !== "other").map((kind) => ({
    value: kind,
    label: `${TALK_KIND_LABELS[kind]}s`,
  }))
  const sheetGroups = (
    <div className="flex flex-col gap-7">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-xs font-medium tracking-wider text-muted-foreground uppercase">
          Department
          {draft.school && (
            <span className="normal-case tracking-normal">
              {" "}
              · in {TALK_SCHOOL_LABELS[draft.school]}
            </span>
          )}
        </legend>
        <DepartmentCombobox
          inline
          departments={departments}
          value={draft.dept}
          school={draft.school}
          onChange={(slug) => setDraft(setDept(slug, draft))}
        />
      </fieldset>
      <FacetChips
        legend="Kind"
        options={kindOptions}
        selected={draft.kind ? [draft.kind] : []}
        onToggle={(value, checked) =>
          setDraft({ ...draft, kind: checked ? (value as TalkKind) : undefined })
        }
      />
      <FacetChips
        legend="Format"
        options={[
          { value: "yes", label: "Online or hybrid" },
          { value: "no", label: "In person only" },
        ]}
        selected={draft.online === undefined ? [] : [draft.online ? "yes" : "no"]}
        onToggle={(value, checked) =>
          setDraft({ ...draft, online: checked ? value === "yes" : undefined })
        }
      />
    </div>
  )

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
            filterCount > 0 ? "border-talks bg-talks-tint text-talks" : "bg-card",
          )}
        >
          <SlidersHorizontalIcon aria-hidden className="size-3.5" />
          Filters
          {filterCount > 0 && <span className="font-mono tabular-nums">· {filterCount}</span>}
        </button>
      }
      count={draftCount}
      noun={["talk", "talks"]}
      accent="talks"
      rule="one choice per filter, all filters together"
      onApply={() => {
        apply(draft, { scroll: true })
        setSheetOpen(false)
      }}
      onClear={() => setDraft({ q: draft.q, preset: draft.preset, from: draft.from })}
      clearDisabled={activeTalkFilterCount(draft) === 0}
    >
      {sheetGroups}
    </FilterSheet>
  )

  const subscribe = (className?: string) => (
    <TalksSubscribeDialog
      state={base}
      departmentName={department?.shortName}
      trigger={
        <button
          type="button"
          className={cn(
            "inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-full border border-talks px-4 text-sm font-medium text-talks transition-colors duration-150 hover:bg-talks-tint sm:h-10",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            className,
          )}
        >
          <CalendarSyncIcon aria-hidden className="size-4" />
          Subscribe
        </button>
      }
    />
  )

  // --- the header's sentence --------------------------------------------------------------
  const headline = (() => {
    if (department) {
      const n = department.upcomingCount
      return `${plural(n, "talk", "talks")} in the next four weeks${department.virtual ? " from series we could not place in a department" : ""}.`
    }
    if (state.school) {
      const n = perSchool[state.school]
      const depts = departments.filter(
        (item) => item.school === state.school && item.upcomingCount > 0,
      ).length
      return `${plural(n, "talk", "talks")} in the next four weeks across ${plural(depts, "department", "departments")}.`
    }
    if (overview && overview.next28Days > 0) {
      return `${plural(overview.next28Days, "talk", "talks")} in the next four weeks across ${plural(overview.departments, "department", "departments")}.`
    }
    return "Public seminars, lectures and workshops across Cambridge departments, in one agenda."
  })()

  const days = groupTalksByDay(talks)
  const stickyTop = `calc(var(--site-header-height, 4rem) + ${barHeight}px)`
  const nextWindowFirst = addDays(span.last, 1)

  return (
    <div style={{ "--talks-bar": `${barHeight}px` } as React.CSSProperties}>
      <header className="border-b bg-card/40">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 pt-8 pb-5 sm:px-6 sm:pt-12">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="flex max-w-3xl flex-col gap-2.5">
              <p className="flex items-center gap-2 font-mono text-[0.6875rem] font-medium tracking-[0.14em] text-talks uppercase">
                <span aria-hidden className="h-px w-6 bg-talks" />
                The lecture list
              </p>
              <h1
                className={cn(
                  "font-serif leading-[1.02] font-normal tracking-[-0.025em] text-balance",
                  department || state.school
                    ? "text-[clamp(2.3rem,5.8vw,4rem)]"
                    : "text-[clamp(2.6rem,7.2vw,4.75rem)]",
                )}
              >
                {department ? (
                  <>
                    Talks in{" "}
                    <span className={cn("italic", SCHOOL_TONE[department.school].ink)}>
                      {department.shortName}
                    </span>
                  </>
                ) : state.school ? (
                  <>
                    Talks in{" "}
                    <span className={cn("italic", SCHOOL_TONE[state.school].ink)}>
                      {TALK_SCHOOL_SHORT[state.school]}
                    </span>
                  </>
                ) : (
                  <>
                    Talks<span className="text-talks">.</span>
                  </>
                )}
              </h1>
              <p className="max-w-2xl text-pretty text-muted-foreground sm:text-lg">{headline}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {subscribe()}
              <Link
                href="/talks/departments"
                className="inline-flex h-11 items-center gap-2 rounded-full border bg-card px-4 text-sm font-medium transition-colors duration-150 hover:border-foreground/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:h-10"
              >
                <LibraryIcon aria-hidden className="size-4" />
                Departments A–Z
              </Link>
            </div>
          </div>
          <SchoolRail
            value={railSchool}
            onChange={setSchool}
            counts={perSchool}
            total={totalUpcoming}
          />
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
              label="Search talks"
              placeholder="Search talks, speakers, series or venues"
              onSearch={(q) =>
                apply({ ...base, q: q || undefined }, { replace: Boolean(state.q && q) })
              }
            />
            <div className="hidden items-center gap-2 lg:flex">
              <DepartmentCombobox
                departments={departments}
                value={state.dept}
                school={state.school}
                onChange={(slug) => apply(setDept(slug), { scroll: true })}
              />
              <Select
                value={state.kind ?? "any"}
                onValueChange={(value) =>
                  apply({ ...base, kind: value === "any" ? undefined : (value as TalkKind) })
                }
              >
                <SelectTrigger
                  aria-label="Kind of talk"
                  className={cn(
                    "shrink-0 rounded-full pl-3.5 text-[13px] data-[size=default]:h-9",
                    state.kind ? "border-talks bg-talks-tint font-medium text-talks" : "bg-card",
                  )}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" align="end">
                  <SelectItem value="any">Any kind</SelectItem>
                  {TALK_KINDS.filter((kind) => kind !== "other").map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {TALK_KIND_LABELS[kind]}s
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <button
                type="button"
                aria-pressed={state.online === true}
                onClick={() => apply({ ...base, online: state.online === true ? undefined : true })}
                className={cn(
                  "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-[13px] whitespace-nowrap transition-colors duration-150",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                  state.online === true
                    ? "border-talks bg-talks-tint font-medium text-talks"
                    : "bg-card hover:border-foreground/40",
                )}
              >
                <VideoIcon aria-hidden className="size-3.5" />
                Online or hybrid
              </button>
              {(filterCount > 0 || state.q) && (
                <button
                  type="button"
                  onClick={clearAll}
                  className="inline-flex h-9 shrink-0 items-center px-1.5 text-[13px] whitespace-nowrap text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                >
                  Clear all
                </button>
              )}
            </div>
          </div>
          <FilterChipStrip
            className="lg:hidden"
            leading={sheet}
            applied={applied}
            quick={quick}
            onClear={applied.length > 0 || state.q ? clearAll : undefined}
          />
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-x-0 -bottom-px h-0.5 origin-left bg-talks transition-[opacity,transform] duration-500",
              stale ? "scale-x-75 opacity-100" : "scale-x-0 opacity-0 duration-150",
            )}
          />
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)] gap-x-12 pt-5 pb-14 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <aside
            aria-label="Dates"
            className="flex min-w-0 flex-col gap-4 lg:order-2 lg:sticky lg:top-[calc(var(--site-header-height,4rem)+var(--talks-bar)+1.25rem)] lg:self-start"
          >
            <div className="rounded-2xl border bg-card p-3 sm:p-4">
              <WeekStrip
                days={stripDays}
                selected={span.preset ? undefined : span.first}
                range={span.preset ? { first: span.first, last: span.last } : undefined}
                onSelect={(day) =>
                  apply(
                    { ...base, preset: undefined, from: day === today ? undefined : day },
                    { scroll: true },
                  )
                }
                today={today}
                minDate={today}
                termLabel={stripTermLabel(weekDays(stripMonday), terms)}
                onPrev={() => setStripMonday(shiftWeek(stripMonday, -1))}
                onNext={() => setStripMonday(shiftWeek(stripMonday, 1))}
                prevDisabled={stripMonday <= startOfWeek(today)}
                nextDisabled={stripMonday >= shiftWeek(today, STRIP_WEEKS_AHEAD)}
                noun={["talk", "talks"]}
                accent="talks"
              />
            </div>
            <DatePresets
              value={span.preset}
              available={presets}
              onChange={(preset) => apply({ ...base, preset, from: undefined }, { scroll: true })}
              accent="talks"
            />
            <div className="hidden flex-col gap-3 rounded-2xl border border-dashed p-4 lg:flex">
              <p className="font-serif text-lg leading-snug">
                Follow a department, not a web page.
              </p>
              <p className="text-sm text-muted-foreground">
                Subscribe once and these talks — with these filters — stay in your own calendar,
                updated as organisers add or cancel them.
              </p>
              {subscribe("self-start")}
            </div>
          </aside>

          <div className="flex min-w-0 flex-col" aria-busy={stale || loading}>
            <div className="flex items-baseline justify-between gap-3 pt-5 pb-1 lg:pt-0">
              <p className="text-sm text-muted-foreground" aria-live="polite">
                {total === undefined ? (
                  "Counting…"
                ) : (
                  <>
                    <span className="font-mono text-foreground tabular-nums">{total}</span>{" "}
                    {state.kind ? TALK_KIND_PLURAL[state.kind] : total === 1 ? "talk" : "talks"}
                    {state.q && total >= TALKS_SEARCH_LIMIT && " (best matches)"}
                    <span className="text-muted-foreground">
                      {" "}
                      ·{" "}
                      {span.first === span.last
                        ? formatDayShort(span.first)
                        : `${formatDayShort(span.first)} – ${formatDayShort(span.last)}`}
                    </span>
                    {count.capped && !state.q && <span> · counted over the first 62 days</span>}
                  </>
                )}
              </p>
            </div>

            {loading && talks.length === 0 ? (
              <div className="flex flex-col">
                <Skeleton className="mt-4 mb-1 h-7 w-48" />
                {Array.from({ length: 6 }, (_, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: placeholders
                  <TalkRowSkeleton key={index} />
                ))}
              </div>
            ) : talks.length === 0 ? (
              <EmptyTalks
                q={state.q}
                chips={applied}
                next={next ?? undefined}
                onJump={(talk) =>
                  apply(
                    { ...base, preset: undefined, from: londonIsoDate(talk.startsAt) },
                    { scroll: true },
                  )
                }
                onDropQuery={() => apply({ ...base, q: undefined })}
                onClear={clearAll}
                hasDates={Boolean(state.preset || state.from)}
                onDropDates={() => apply({ ...base, preset: undefined, from: undefined })}
              />
            ) : (
              <div className="flex flex-col">
                {days.map(({ day, talks: dayTalks }) => {
                  const heading = dayHeading(day, today)
                  const tag = termWeekTag(day, terms)
                  const weekday = LONG_WEEKDAYS[(new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7]
                  return (
                    <section key={day} aria-labelledby={`day-${day}`} className="flex flex-col">
                      <h2
                        id={`day-${day}`}
                        style={{ top: stickyTop }}
                        className="sticky z-20 -mx-4 flex items-baseline justify-between gap-3 border-b bg-background/95 px-4 pt-4 pb-2 backdrop-blur supports-backdrop-filter:bg-background/85 sm:-mx-6 sm:px-6 lg:mx-0 lg:px-0"
                      >
                        <span className="flex min-w-0 items-baseline gap-2">
                          <span className="font-serif text-xl leading-tight italic sm:text-2xl">
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
                          <span>{plural(dayTalks.length, "talk", "talks")}</span>
                        </span>
                      </h2>
                      <ul className="flex flex-col divide-y divide-dashed">
                        {dayTalks.map((talk) => (
                          <li key={talk.key}>
                            <TalkRow
                              talk={talk}
                              href={`/talks/${talk.key}`}
                              now={now}
                              onOpen={(event) => {
                                if (!isPlainClick(event)) return
                                event.preventDefault()
                                openTalk(talk.key, event.currentTarget)
                              }}
                            />
                          </li>
                        ))}
                      </ul>
                    </section>
                  )
                })}

                <div className="flex flex-col items-center gap-3 pt-8">
                  {!state.q &&
                  (agenda.status === "CanLoadMore" || agenda.status === "LoadingMore") ? (
                    <Button
                      variant="outline"
                      className="h-11 rounded-full px-6"
                      disabled={agenda.status === "LoadingMore"}
                      onClick={agenda.loadMore}
                    >
                      {agenda.status === "LoadingMore" && <Spinner data-icon="inline-start" />}
                      Load more talks
                    </Button>
                  ) : (
                    <>
                      <p className="text-center text-sm text-muted-foreground">
                        {state.q
                          ? talks.length >= TALKS_SEARCH_LIMIT
                            ? "These are the best matches; a narrower search finds the rest."
                            : `That is every match until ${formatDayShort(span.last)}.`
                          : `That is everything listed until ${formatDayShort(span.last)}.`}
                      </p>
                      {!state.q && (
                        <Button
                          variant="outline"
                          className="h-11 rounded-full px-6"
                          onClick={() =>
                            apply(
                              { ...base, preset: undefined, from: nextWindowFirst },
                              { scroll: true },
                            )
                          }
                        >
                          From {formatDayShort(nextWindowFirst)}
                          <ArrowRightIcon data-icon="inline-end" />
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <Sheet open={openKey !== undefined} onOpenChange={(open) => !open && closeTalk()}>
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
          {openTalkData ? (
            <>
              <SheetHeader className="gap-2 px-5 pt-6 pr-14 sm:px-7 sm:pr-16">
                <TalkEyebrow talk={openTalkData} />
                <SheetTitle
                  className={cn(
                    "font-serif text-[1.75rem] leading-[1.12] font-normal tracking-[-0.015em] text-balance",
                    openTalkData.cancelled && "text-muted-foreground line-through",
                  )}
                >
                  {openTalkData.title}
                </SheetTitle>
                <SheetDescription className="sr-only">Talk details</SheetDescription>
              </SheetHeader>
              <div className="px-5 pb-10 sm:px-7">
                <TalkDetails
                  talk={openTalkData}
                  pageUrl={`${SITE_URL}/talks/${openTalkData.key}`}
                  termWeek={termWeekTag(londonIsoDate(openTalkData.startsAt), terms)}
                />
                <Link
                  href={`/talks/${openTalkData.key}`}
                  className="mt-6 inline-flex min-h-11 items-center gap-1 text-sm font-medium text-talks underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                >
                  Open the talk’s own page
                  <ArrowRightIcon aria-hidden className="size-3.5" />
                </Link>
              </div>
            </>
          ) : openTalkData === null ? (
            <SheetHeader className="px-5 pt-6 pr-14 sm:px-7 sm:pr-16">
              <SheetTitle className="font-serif text-2xl font-normal">
                This talk is no longer listed
              </SheetTitle>
              <SheetDescription>
                Its organisers may have taken it down, or it has passed. The agenda shows what is on
                now.
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
                  {openPlaceholder?.title ?? "Loading the talk"}
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

function EmptyTalks({
  q,
  chips,
  next,
  onJump,
  onDropQuery,
  onClear,
  hasDates,
  onDropDates,
}: {
  q?: string
  chips: AppliedChip[]
  next?: TalkListItem
  onJump: (talk: TalkListItem) => void
  onDropQuery: () => void
  onClear: () => void
  hasDates: boolean
  onDropDates: () => void
}) {
  return (
    <div className="mt-4 flex flex-col items-center gap-5 rounded-2xl border border-dashed px-6 py-12 text-center">
      <TheatreMark />
      <div className="flex max-w-md flex-col gap-1.5">
        <h2 className="font-serif text-2xl font-normal">Nothing on these benches</h2>
        <p className="text-sm text-muted-foreground">
          {chips.length > 0 || q
            ? "No talk matches all of these on these days. Widen the dates, or drop a filter."
            : "No talks are listed for these days yet. Departments add them through the week."}
        </p>
      </div>
      {next && (
        <button
          type="button"
          onClick={() => onJump(next)}
          className="group flex max-w-md flex-col items-center gap-1 rounded-xl border bg-card px-5 py-3 text-sm transition-colors hover:border-talks focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <span className="font-mono text-[0.6875rem] tracking-[0.14em] text-talks uppercase">
            Next talk · {formatDayShort(londonIsoDate(next.startsAt))}
          </span>
          <span className="font-serif text-base leading-snug text-balance group-hover:underline">
            {next.title}
          </span>
        </button>
      )}
      <div className="flex max-w-xl flex-wrap justify-center gap-2">
        {hasDates && (
          <Button variant="outline" size="sm" className="h-11 sm:h-9" onClick={onDropDates}>
            The next four weeks
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
        {(chips.length > 0 || q) && (
          <Button variant="ghost" size="sm" className="h-11 sm:h-9" onClick={onClear}>
            Clear all
          </Button>
        )}
      </div>
    </div>
  )
}
