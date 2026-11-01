"use client"

import { type Preloaded, usePreloadedQuery } from "convex/react"
import { ChevronLeftIcon, ChevronRightIcon, SlidersHorizontalIcon } from "lucide-react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { useEffect, useMemo, useRef, useState } from "react"
import {
  BusyShelf,
  CategoryTiles,
  CollegeGrid,
  type Navigate,
} from "@/components/molecules/directory-shelves"
import { FacetChips } from "@/components/molecules/facet-chips"
import { FacetList, type FacetOption } from "@/components/molecules/facet-list"
import {
  type AppliedChip,
  FilterChipStrip,
  type QuickChip,
} from "@/components/molecules/filter-chip-strip"
import { FilterSheet } from "@/components/molecules/filter-sheet"
import { OrgCard } from "@/components/molecules/org-card"
import { SearchField } from "@/components/molecules/search-field"
import { SortSelect } from "@/components/molecules/sort-select"
import { Button } from "@/components/ui/button"
import { api } from "@/convex/_generated/api"
import { useStickyQuery } from "@/hooks/convex/use-sticky-query"
import { ORG_SORT_LABELS, type OrgSort } from "@/lib/directory-sort"
import { directoryTitle } from "@/lib/directory-title"
import { pageNumbers } from "@/lib/pagination"
import type { OrgBusy, OrgFacets } from "@/lib/public-api"
import { SITE_NAME } from "@/lib/site"
import {
  activeDirectoryFilterCount,
  DIRECTORY_PAGE_SIZE,
  type DirectoryState,
  directoryFilters,
  directoryListArgs,
  EMPTY_DIRECTORY,
  effectiveDirectorySort,
  parseDirectoryParams,
  type SearchParams,
  serializeDirectoryState,
} from "@/lib/url-state"
import { cn } from "@/lib/utils"
import {
  ACTIVITY_TYPE_LABELS,
  ACTIVITY_TYPES,
  AUDIENCE_LABELS,
  AUDIENCES,
  BLUE_STATUS_LABELS,
  BLUE_STATUSES,
  type BlueStatus,
  CATEGORIES,
  CATEGORY_LABELS,
  GENDER_CATEGORIES,
  GENDER_CATEGORY_LABELS,
  ORG_LEVEL_LABELS,
  ORG_LEVELS,
  ORG_STATUS_LABELS,
  ORG_STATUSES,
} from "@/lib/vocab"

type DirectoryFacet =
  | "categories"
  | "levels"
  | "collegeKeys"
  | "activityTypes"
  | "audiences"
  | "statuses"
  | "blueStatus"
  | "gender"

type Group = {
  facet: DirectoryFacet
  legend: string
  options: FacetOption[]
  /** A searchable checkbox list rather than chips (the colleges). */
  list?: boolean
}

function options(
  values: readonly string[],
  labels: Record<string, string>,
  counts: Record<string, number>,
): FacetOption[] {
  return values.map((value) => ({
    value,
    label: labels[value] ?? value,
    count: counts[value] ?? 0,
  }))
}

function groupsFor(facets: OrgFacets, colleges: { key: string; name: string }[]): Group[] {
  return [
    {
      facet: "categories",
      legend: "Category",
      options: options(CATEGORIES, CATEGORY_LABELS, facets.categories),
    },
    {
      facet: "collegeKeys",
      legend: "College",
      list: true,
      options: colleges.map((college) => ({
        value: college.key,
        label: college.name,
        count: facets.collegeKeys[college.key] ?? 0,
      })),
    },
    {
      facet: "levels",
      legend: "Level",
      options: options(ORG_LEVELS, ORG_LEVEL_LABELS, facets.levels),
    },
    {
      facet: "audiences",
      legend: "Who it is for",
      options: options(AUDIENCES, AUDIENCE_LABELS, facets.audiences),
    },
    {
      facet: "activityTypes",
      legend: "Activities",
      options: options(ACTIVITY_TYPES, ACTIVITY_TYPE_LABELS, facets.activityTypes),
    },
    {
      facet: "blueStatus",
      legend: "Sport: Blues",
      options: options(BLUE_STATUSES, BLUE_STATUS_LABELS, facets.blueStatus),
    },
    {
      facet: "gender",
      legend: "Sport: teams for",
      options: options(GENDER_CATEGORIES, GENDER_CATEGORY_LABELS, facets.gender),
    },
    {
      facet: "statuses",
      legend: "Activity status",
      options: options(ORG_STATUSES, ORG_STATUS_LABELS, facets.statuses),
    },
  ]
}

/** Full and Half Blues: the "Blues sports" quick filter. */
const BLUES: BlueStatus[] = ["full", "full_some", "discretionary_full", "half"]

type Quick = {
  key: string
  label: string
  isOn: (state: DirectoryState) => boolean
  apply: (state: DirectoryState) => DirectoryState
}

const QUICK: Quick[] = [
  {
    key: "university",
    label: "University-wide",
    isOn: (s) => s.levels.includes("university"),
    apply: (s) => ({ ...s, levels: [...s.levels, "university"] }),
  },
  {
    key: "sport",
    label: "Sports clubs",
    isOn: (s) => s.categories.includes("sport"),
    apply: (s) => ({ ...s, categories: [...s.categories, "sport"] }),
  },
  {
    key: "blues",
    label: "Blues sports",
    isOn: (s) => BLUES.every((blue) => s.blueStatus.includes(blue)),
    apply: (s) => ({ ...s, blueStatus: [...new Set([...s.blueStatus, ...BLUES])] }),
  },
  {
    key: "beginner",
    label: "Beginner-friendly",
    isOn: (s) => s.beginnerFriendly === true,
    apply: (s) => ({ ...s, beginnerFriendly: true }),
  },
  {
    key: "active",
    label: "Active groups",
    isOn: (s) => s.statuses.includes("active"),
    apply: (s) => ({ ...s, statuses: [...s.statuses, "active"] }),
  },
]

/** A facet with more values than this on shows as one chip ("Sport: Blues · 4"). */
const CHIPS_PER_FACET = 2

/** The applied filters as removable chips, in group order. */
function appliedChips(
  state: DirectoryState,
  groups: Group[],
  apply: (next: DirectoryState) => void,
): AppliedChip[] {
  const chips: AppliedChip[] = []
  for (const group of groups) {
    const values = state[group.facet] as string[]
    if (values.length > CHIPS_PER_FACET) {
      chips.push({
        key: group.facet,
        label: `${group.legend} · ${values.length}`,
        onRemove: () => apply({ ...state, [group.facet]: [], page: 1 }),
      })
      continue
    }
    for (const value of values) {
      chips.push({
        key: `${group.facet}:${value}`,
        label: group.options.find((option) => option.value === value)?.label ?? value,
        onRemove: () =>
          apply({ ...state, [group.facet]: values.filter((item) => item !== value), page: 1 }),
      })
    }
  }
  if (state.beginnerFriendly !== undefined) {
    chips.push({
      key: "beginner",
      label: state.beginnerFriendly ? "Beginner-friendly" : "Not beginner-friendly",
      onRemove: () => apply({ ...state, beginnerFriendly: undefined, page: 1 }),
    })
  }
  return chips
}

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

/**
 * The /societies browser. The URL is the state (lib/url-state.ts): every
 * change writes it with `history.pushState`, which Next folds into
 * `useSearchParams`, and the live Convex queries follow the new arguments
 * over the open socket — no server round trip, and the previous results stay
 * on screen (with a thin progress line) until the next arrive. The server
 * page preloads the first view, so the first paint has data.
 *
 * Layout: a sticky search and chip strip; on desktop a facet rail (chips with
 * counts, a searchable college list); on a phone a bottom sheet that applies
 * its draft on "Show N societies". With nothing filtered, curated shelves
 * come before the full index.
 */
export function OrgDirectory({
  preloadedList,
  preloadedFacets,
  preloadedColleges,
  busy,
}: {
  preloadedList: Preloaded<typeof api.orgs.list>
  preloadedFacets: Preloaded<typeof api.orgs.facets>
  preloadedColleges: Preloaded<typeof api.orgs.colleges>
  /** The "Busy this week" shelf; null when it could not be read. */
  busy: OrgBusy | null
}) {
  const searchParams = useSearchParams()
  const state = useMemo(
    () => parseDirectoryParams(searchParamsObject(new URLSearchParams(searchParams.toString()))),
    [searchParams],
  )
  const colleges = usePreloadedQuery(preloadedColleges)
  const list = useStickyQuery(api.orgs.list, directoryListArgs(state), preloadedList)
  const facets = useStickyQuery(api.orgs.facets, directoryFilters(state), preloadedFacets)
  const stale = list.stale || facets.stale
  const results = list.data
  const counts = facets.data

  const [sheetOpen, setSheetOpen] = useState(false)
  const [draft, setDraft] = useState<DirectoryState>(state)
  const draftFacets = useStickyQuery(api.orgs.facets, sheetOpen ? directoryFilters(draft) : "skip")

  const resultsTop = useRef<HTMLDivElement>(null)
  const collegeNames = useMemo(
    () => Object.fromEntries(colleges.map((college) => [college.key, college.name])),
    [colleges],
  )

  useEffect(() => {
    document.title = `${directoryTitle(state)} · ${SITE_NAME}`
  }, [state])

  const hrefFor = (next: DirectoryState) => `/societies${serializeDirectoryState(next)}`
  const apply = (next: DirectoryState, { replace = false, scroll = false } = {}) => {
    const href = hrefFor(next)
    if (replace) window.history.replaceState(null, "", href)
    else window.history.pushState(null, "", href)
    if (scroll) {
      const top = resultsTop.current
      if (top && top.getBoundingClientRect().top < 0) top.scrollIntoView({ block: "start" })
    }
  }
  const follow: Navigate = (href, event) => {
    if (!isPlainClick(event)) return
    event.preventDefault()
    window.history.pushState(null, "", href)
    resultsTop.current?.scrollIntoView({ block: "start" })
  }
  const toggle = (base: DirectoryState, facet: DirectoryFacet, value: string, checked: boolean) => {
    const current = base[facet] as string[]
    const values = checked ? [...current, value] : current.filter((item) => item !== value)
    return { ...base, [facet]: values, page: 1 }
  }

  if (!results || !counts) return null

  const groups = groupsFor(counts, colleges)
  const filterCount = activeDirectoryFilterCount(state)
  const chips = appliedChips(state, groups, (next) => apply(next))
  const quick: QuickChip[] = QUICK.filter((item) => !item.isOn(state)).map((item) => ({
    key: item.key,
    label: item.label,
    onSelect: () => apply({ ...item.apply(state), page: 1 }),
  }))
  const sort = effectiveDirectorySort(state)
  const sortOptions: OrgSort[] = state.q ? ["relevance", "name", "active"] : ["name", "active"]
  const setSort = (next: OrgSort) =>
    apply({
      ...state,
      sort: next === "relevance" || (next === "name" && !state.q) ? undefined : next,
      page: 1,
    })

  const total = counts.total
  const pages = Math.max(1, Math.ceil(total / DIRECTORY_PAGE_SIZE))
  const curated = filterCount === 0 && !state.q && state.page === 1 && !state.sort
  const noun = (n: number) => (n === 1 ? "society" : "societies")

  const filterGroups = (
    selection: DirectoryState,
    groupsShown: Group[],
    onChange: (next: DirectoryState) => void,
    beginnerCount: number,
  ) => (
    <div className="flex flex-col gap-7">
      {groupsShown.map((group) =>
        group.list ? (
          <FacetList
            key={group.facet}
            legend={group.legend}
            options={group.options}
            selected={selection[group.facet] as string[]}
            onToggle={(value, checked) => onChange(toggle(selection, group.facet, value, checked))}
            searchable
            showEmpty
          />
        ) : (
          <FacetChips
            key={group.facet}
            legend={group.legend}
            options={group.options}
            selected={selection[group.facet] as string[]}
            onToggle={(value, checked) => onChange(toggle(selection, group.facet, value, checked))}
          />
        ),
      )}
      <FacetChips
        legend="For beginners"
        options={[{ value: "yes", label: "Beginner-friendly", count: beginnerCount }]}
        selected={selection.beginnerFriendly === true ? ["yes"] : []}
        onToggle={(_, checked) =>
          onChange({ ...selection, beginnerFriendly: checked ? true : undefined, page: 1 })
        }
      />
    </div>
  )

  const draftCounts = draftFacets.data
  const sheet = (
    <FilterSheet
      open={sheetOpen}
      onOpenChange={(open) => {
        if (open) setDraft(state)
        setSheetOpen(open)
      }}
      trigger={
        <button
          type="button"
          className={cn(
            "inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium sm:h-8 lg:hidden",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            filterCount > 0 ? "border-primary bg-accent text-primary" : "bg-card",
          )}
        >
          <SlidersHorizontalIcon aria-hidden className="size-3.5" />
          Filters
          {filterCount > 0 && <span className="font-mono tabular-nums">· {filterCount}</span>}
        </button>
      }
      count={draftCounts?.total}
      noun={["society", "societies"]}
      onApply={() => {
        apply(draft, { scroll: true })
        setSheetOpen(false)
      }}
      onClear={() => setDraft({ ...EMPTY_DIRECTORY, q: state.q, sort: state.sort })}
      clearDisabled={activeDirectoryFilterCount(draft) === 0}
    >
      {filterGroups(
        draft,
        groupsFor(draftCounts ?? counts, colleges),
        setDraft,
        (draftCounts ?? counts).beginnerFriendly.true ?? 0,
      )}
    </FilterSheet>
  )

  return (
    <div className="mx-auto grid w-full max-w-7xl gap-x-10 px-4 sm:px-6 lg:grid-cols-[15.5rem_1fr]">
      <aside aria-label="Filters" className="hidden lg:block">
        <div className="sticky top-[calc(var(--site-header-height,4rem)+1rem)] flex max-h-[calc(100svh-var(--site-header-height,4rem)-2rem)] flex-col gap-4 overflow-y-auto py-6 pr-2 [scrollbar-width:thin]">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="font-serif text-xl font-medium">Filters</h2>
            {filterCount > 0 && (
              <button
                type="button"
                onClick={() => apply({ ...EMPTY_DIRECTORY, q: state.q, sort: state.sort })}
                className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
              >
                Reset
              </button>
            )}
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">
            Any value within a group, all groups together.
          </p>
          {filterGroups(state, groups, (next) => apply(next), counts.beginnerFriendly.true ?? 0)}
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
        <div
          ref={resultsTop}
          className="sticky top-[var(--site-header-height,4rem)] z-30 -mx-4 flex scroll-mt-[var(--site-header-height,4rem)] flex-col gap-2.5 border-b bg-background/95 px-4 pt-3 pb-2.5 backdrop-blur supports-backdrop-filter:bg-background/80 sm:mx-0 sm:px-0 lg:pt-6"
        >
          <SearchField
            size="lg"
            value={state.q ?? ""}
            label="Search societies and clubs"
            placeholder="Try “rowing” or “Trinity Hall”"
            onSearch={(q) =>
              apply({ ...state, q: q || undefined, page: 1 }, { replace: Boolean(state.q && q) })
            }
          />
          <div className="flex items-center gap-2">
            <FilterChipStrip
              className="min-w-0 flex-1"
              leading={sheet}
              applied={chips}
              quick={quick}
              onClear={chips.length > 0 || state.q ? () => apply(EMPTY_DIRECTORY) : undefined}
            />
            <SortSelect
              value={sort}
              options={sortOptions}
              onChange={setSort}
              className="hidden sm:flex"
            />
          </div>
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-x-0 -bottom-px h-0.5 origin-left bg-primary transition-[opacity,transform] duration-500",
              stale ? "scale-x-75 opacity-100" : "scale-x-0 opacity-0 duration-150",
            )}
          />
        </div>

        <div className="flex items-center justify-between gap-3 pt-4 pb-2">
          <p className="text-sm text-muted-foreground" aria-live="polite">
            <span className="font-mono text-foreground tabular-nums">{total}</span> {noun(total)}
            <span className="hidden sm:inline"> · {ORG_SORT_LABELS[sort]}</span>
            {counts.truncated && <span> · best matches only; try a narrower search</span>}
          </p>
          <SortSelect value={sort} options={sortOptions} onChange={setSort} className="sm:hidden" />
        </div>

        <div aria-busy={stale} className="flex flex-col gap-12 pb-12">
          {curated && (
            <div className="flex flex-col gap-12 pt-4">
              {busy && (
                <BusyShelf label={busy.label} orgs={busy.orgs} collegeNames={collegeNames} />
              )}
              <CategoryTiles
                counts={counts.categories}
                hrefFor={(category) => hrefFor({ ...EMPTY_DIRECTORY, categories: [category] })}
                onNavigate={follow}
              />
              <CollegeGrid
                colleges={colleges}
                counts={counts.collegeKeys}
                hrefFor={(key) => hrefFor({ ...EMPTY_DIRECTORY, collegeKeys: [key] })}
                onNavigate={follow}
              />
            </div>
          )}

          <section aria-labelledby="results-heading" className="flex flex-col gap-3">
            {/* Cards are h3s: this keeps the outline h1 → h2 → h3. */}
            <h2
              id="results-heading"
              className={cn(curated ? "font-serif text-2xl font-medium tracking-tight" : "sr-only")}
            >
              {curated ? "Every society, A–Z" : "Results"}
            </h2>
            {results.page.length > 0 ? (
              <ul className="grid divide-y sm:grid-cols-2 sm:gap-3 sm:divide-y-0">
                {results.page.map((card) => (
                  <li key={card.key} className="min-w-0">
                    <OrgCard card={card} collegeNames={collegeNames} />
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyResults
                q={state.q}
                chips={chips}
                onDropQuery={() => apply({ ...state, q: undefined, page: 1 })}
                onClear={() => apply(EMPTY_DIRECTORY)}
              />
            )}
          </section>

          {pages > 1 && (
            <nav aria-label="Pages" className="flex items-center justify-between gap-2">
              <PageLink
                state={state}
                page={state.page - 1}
                disabled={state.page <= 1}
                hrefFor={hrefFor}
                onNavigate={follow}
              >
                <ChevronLeftIcon data-icon="inline-start" />
                Previous
              </PageLink>
              <ol className="hidden items-center gap-1 sm:flex">
                {pageNumbers(state.page, pages).map((page, index) =>
                  page === "gap" ? (
                    <li
                      // biome-ignore lint/suspicious/noArrayIndexKey: at most two gaps, in place
                      key={`gap-${index}`}
                      aria-hidden
                      className="px-1 font-mono text-sm text-muted-foreground"
                    >
                      …
                    </li>
                  ) : (
                    <li key={page}>
                      <Button
                        variant={page === state.page ? "secondary" : "ghost"}
                        size="sm"
                        className="min-w-8 font-mono tabular-nums"
                        asChild
                      >
                        <a
                          href={hrefFor({ ...state, page })}
                          onClick={(event) => follow(hrefFor({ ...state, page }), event)}
                          aria-current={page === state.page ? "page" : undefined}
                          aria-label={`Page ${page}`}
                        >
                          {page}
                        </a>
                      </Button>
                    </li>
                  ),
                )}
              </ol>
              <span className="font-mono text-sm text-muted-foreground tabular-nums sm:hidden">
                {state.page} / {pages}
              </span>
              <PageLink
                state={state}
                page={state.page + 1}
                disabled={state.page >= pages}
                hrefFor={hrefFor}
                onNavigate={follow}
              >
                Next
                <ChevronRightIcon data-icon="inline-end" />
              </PageLink>
            </nav>
          )}
        </div>
      </div>
    </div>
  )
}

function PageLink({
  state,
  page,
  disabled,
  hrefFor,
  onNavigate,
  children,
}: {
  state: DirectoryState
  page: number
  disabled: boolean
  hrefFor: (next: DirectoryState) => string
  onNavigate: Navigate
  children: React.ReactNode
}) {
  if (disabled) {
    return (
      <Button variant="outline" className="h-11 sm:h-9" disabled>
        {children}
      </Button>
    )
  }
  const href = hrefFor({ ...state, page })
  return (
    <Button variant="outline" className="h-11 sm:h-9" asChild>
      <a href={href} onClick={(event) => onNavigate(href, event)}>
        {children}
      </a>
    </Button>
  )
}

/** A small line drawing of an arched bridge over the river: the empty state's
 * mark, in the decorative river green. */
function BridgeMark() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 120 48"
      className="h-12 w-30 text-primary"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <path d="M6 30h108" />
      <path d="M18 30c8-16 20-22 42-22s34 6 42 22" />
      <path d="M30 30v-8M42 30V16M60 30V12M78 30V16M90 30v-8" opacity=".5" />
      <path
        d="M4 40c10-4 18 4 28 0s18 4 28 0 18 4 28 0 18 4 28 0"
        stroke="var(--backs)"
        strokeWidth="2"
      />
    </svg>
  )
}

function EmptyResults({
  q,
  chips,
  onDropQuery,
  onClear,
}: {
  q?: string
  chips: AppliedChip[]
  onDropQuery: () => void
  onClear: () => void
}) {
  return (
    <div className="flex flex-col items-center gap-5 rounded-2xl border border-dashed px-6 py-12 text-center">
      <BridgeMark />
      <div className="flex max-w-md flex-col gap-1.5">
        <h3 className="font-serif text-2xl font-medium">No societies match all of these</h3>
        <p className="text-sm text-muted-foreground">
          Drop one filter at a time to widen the search, or start again.
        </p>
      </div>
      <div className="flex max-w-xl flex-wrap justify-center gap-2">
        {q && (
          <Button variant="outline" size="sm" className="h-9" onClick={onDropQuery}>
            Drop the search “{q}”
          </Button>
        )}
        {chips.map((chip) => (
          <Button
            key={chip.key}
            variant="outline"
            size="sm"
            className="h-9"
            onClick={chip.onRemove}
          >
            Drop “{chip.label}”
          </Button>
        ))}
        {(chips.length > 0 || q) && (
          <Button variant="ghost" size="sm" className="h-9" onClick={onClear}>
            Clear all
          </Button>
        )}
      </div>
      <p className="text-sm">
        Can’t find your society?{" "}
        <Link
          href="/request?kind=add"
          className="font-medium text-primary underline underline-offset-4"
        >
          Tell us
        </Link>{" "}
        and we will add it.
      </p>
    </div>
  )
}
