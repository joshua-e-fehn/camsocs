"use client"

import { type Preloaded, usePreloadedQuery } from "convex/react"
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  SearchXIcon,
  SlidersHorizontalIcon,
  XIcon,
} from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { FacetList, type FacetOption } from "@/components/molecules/facet-list"
import { OrgCard } from "@/components/molecules/org-card"
import { SearchField } from "@/components/molecules/search-field"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Label } from "@/components/ui/label"
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import type { api } from "@/convex/_generated/api"
import { pageNumbers } from "@/lib/pagination"
import {
  activeDirectoryFilterCount,
  DIRECTORY_PAGE_SIZE,
  type DirectoryState,
  EMPTY_DIRECTORY,
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

/**
 * The /societies browser: text search, facet filters with live counts, the
 * active filters as removable chips, a card grid and numbered pages. All state
 * lives in the URL (lib/url-state.ts); a change navigates, the server page
 * preloads the next result, and `usePreloadedQuery` keeps it live.
 */
export function OrgDirectory({
  state,
  preloadedList,
  preloadedFacets,
  preloadedColleges,
}: {
  state: DirectoryState
  preloadedList: Preloaded<typeof api.orgs.list>
  preloadedFacets: Preloaded<typeof api.orgs.facets>
  preloadedColleges: Preloaded<typeof api.orgs.colleges>
}) {
  const list = usePreloadedQuery(preloadedList)
  const facets = usePreloadedQuery(preloadedFacets)
  const colleges = usePreloadedQuery(preloadedColleges)
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [sheetOpen, setSheetOpen] = useState(false)

  const collegeNames = Object.fromEntries(colleges.map((college) => [college.key, college.name]))
  const hrefFor = (next: DirectoryState) => `/societies${serializeDirectoryState(next)}`
  const navigate = (next: DirectoryState) =>
    startTransition(() => router.push(hrefFor(next), { scroll: false }))

  const toggle = (facet: DirectoryFacet, value: string, checked: boolean) => {
    const current = state[facet] as string[]
    const values = checked ? [...current, value] : current.filter((item) => item !== value)
    navigate({ ...state, [facet]: values, page: 1 })
  }

  const filterCount = activeDirectoryFilterCount(state)
  const pages = Math.max(1, Math.ceil(facets.total / DIRECTORY_PAGE_SIZE))
  const firstShown = facets.total === 0 ? 0 : (state.page - 1) * DIRECTORY_PAGE_SIZE + 1
  const lastShown = (state.page - 1) * DIRECTORY_PAGE_SIZE + list.page.length

  const groups: {
    facet: DirectoryFacet
    legend: string
    options: FacetOption[]
    collapseAfter?: number
  }[] = [
    {
      facet: "categories",
      legend: "Category",
      options: options(CATEGORIES, CATEGORY_LABELS, facets.categories),
      // The main way in: all sixteen, never folded.
      collapseAfter: CATEGORIES.length,
    },
    {
      facet: "levels",
      legend: "Level",
      options: options(ORG_LEVELS, ORG_LEVEL_LABELS, facets.levels),
    },
    {
      facet: "collegeKeys",
      legend: "College",
      options: colleges.map((college) => ({
        value: college.key,
        label: college.name,
        count: facets.collegeKeys[college.key] ?? 0,
      })),
    },
    {
      facet: "activityTypes",
      legend: "Activities",
      options: options(ACTIVITY_TYPES, ACTIVITY_TYPE_LABELS, facets.activityTypes),
    },
    {
      facet: "audiences",
      legend: "Who it is for",
      options: options(AUDIENCES, AUDIENCE_LABELS, facets.audiences),
    },
    {
      facet: "statuses",
      legend: "Activity status",
      options: options(ORG_STATUSES, ORG_STATUS_LABELS, facets.statuses),
    },
    {
      facet: "blueStatus",
      legend: "Sport: Blue status",
      options: options(BLUE_STATUSES, BLUE_STATUS_LABELS, facets.blueStatus),
    },
    {
      facet: "gender",
      legend: "Sport: gender category",
      options: options(GENDER_CATEGORIES, GENDER_CATEGORY_LABELS, facets.gender),
    },
  ]

  const chips: { key: string; label: string; next: DirectoryState }[] = []
  for (const group of groups) {
    for (const value of state[group.facet] as string[]) {
      const option = group.options.find((item) => item.value === value)
      chips.push({
        key: `${group.facet}:${value}`,
        label: option?.label ?? value,
        next: {
          ...state,
          [group.facet]: (state[group.facet] as string[]).filter((item) => item !== value),
          page: 1,
        },
      })
    }
  }
  if (state.beginnerFriendly !== undefined) {
    chips.push({
      key: "beginner",
      label: state.beginnerFriendly ? "Beginner-friendly" : "Not beginner-friendly",
      next: { ...state, beginnerFriendly: undefined, page: 1 },
    })
  }

  const filters = (
    <div className="flex flex-col gap-7">
      {groups.map((group) => (
        <FacetList
          key={group.facet}
          legend={group.legend}
          options={group.options}
          selected={state[group.facet] as string[]}
          onToggle={(value, checked) => toggle(group.facet, value, checked)}
          collapseAfter={group.collapseAfter}
        />
      ))}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-xs font-medium tracking-wider text-muted-foreground uppercase">
          For beginners
        </legend>
        <div className="flex min-h-9 items-center gap-2.5 lg:min-h-7">
          <Checkbox
            id="filter-beginner"
            checked={state.beginnerFriendly === true}
            onCheckedChange={(value) =>
              navigate({ ...state, beginnerFriendly: value === true ? true : undefined, page: 1 })
            }
          />
          <Label htmlFor="filter-beginner" className="flex-1 cursor-pointer font-normal">
            Beginner-friendly
          </Label>
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {facets.beginnerFriendly.true ?? 0}
          </span>
        </div>
      </fieldset>
    </div>
  )

  return (
    <div className="mx-auto grid w-full max-w-7xl gap-8 px-4 py-8 sm:px-6 lg:grid-cols-[16rem_1fr]">
      <aside aria-label="Filters" className="hidden lg:block">
        <div className="sticky top-20 max-h-[calc(100svh-6rem)] overflow-y-auto pr-2 pb-8 [scrollbar-width:thin]">
          {filters}
        </div>
      </aside>

      <div className="flex min-w-0 flex-col gap-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <SearchField
            value={state.q ?? ""}
            label="Search societies and clubs"
            placeholder="Search by name, topic or tag"
            onSearch={(q) => navigate({ ...state, q: q || undefined, page: 1 })}
          />
          {/* Below lg the filters live in a sheet: each tick applies at once
              (the count in the footer follows), and the footer closes it. */}
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetTrigger asChild>
              <Button variant="outline" className="h-10 lg:hidden">
                <SlidersHorizontalIcon data-icon="inline-start" />
                Filters
                {filterCount > 0 && (
                  <span className="font-mono text-xs tabular-nums">({filterCount})</span>
                )}
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-[88vw] max-w-sm gap-0">
              <SheetHeader className="border-b">
                <SheetTitle>Filters</SheetTitle>
                <SheetDescription>Any value within a group, all groups together.</SheetDescription>
              </SheetHeader>
              <div className="flex-1 overflow-y-auto px-4 py-5">{filters}</div>
              <SheetFooter className="flex-row items-center gap-2 border-t bg-background">
                <Button
                  variant="ghost"
                  disabled={filterCount === 0}
                  onClick={() => navigate({ ...EMPTY_DIRECTORY, q: state.q })}
                >
                  Clear
                </Button>
                <SheetClose asChild>
                  <Button className="flex-1">
                    {isPending ? (
                      <Spinner data-icon="inline-start" />
                    ) : (
                      <>
                        Show <span className="font-mono tabular-nums">{facets.total}</span>{" "}
                        {facets.total === 1 ? "result" : "results"}
                      </>
                    )}
                  </Button>
                </SheetClose>
              </SheetFooter>
            </SheetContent>
          </Sheet>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <p className="mr-auto text-sm text-muted-foreground" aria-live="polite">
            {isPending ? (
              <span className="inline-flex items-center gap-2">
                <Spinner /> Updating…
              </span>
            ) : (
              <>
                <span className="font-mono text-foreground tabular-nums">{facets.total}</span>{" "}
                {facets.total === 1 ? "society or club" : "societies and clubs"}
                {facets.total > 0 && (
                  <span className="font-mono tabular-nums">
                    {" "}
                    · {firstShown}–{lastShown}
                  </span>
                )}
                {facets.truncated && <span> · best matches only; try a narrower search</span>}
              </>
            )}
          </p>
          {chips.map((chip) => (
            <Button
              key={chip.key}
              variant="secondary"
              size="xs"
              onClick={() => navigate(chip.next)}
              aria-label={`Remove filter: ${chip.label}`}
            >
              {chip.label}
              <XIcon data-icon="inline-end" />
            </Button>
          ))}
          {(chips.length > 0 || state.q) && (
            <Button variant="ghost" size="xs" onClick={() => navigate(EMPTY_DIRECTORY)}>
              Clear all
            </Button>
          )}
        </div>

        <div
          aria-busy={isPending}
          className={cn("transition-opacity duration-200", isPending && "opacity-60")}
        >
          {/* Cards are h3s: this keeps the outline h1 → h2 → h3. */}
          <h2 className="sr-only">Results</h2>
          {list.page.length > 0 ? (
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {list.page.map((card) => (
                <li key={card.key} className="min-w-0">
                  <OrgCard card={card} collegeNames={collegeNames} />
                </li>
              ))}
            </ul>
          ) : (
            <Empty className="rounded-xl border border-dashed py-14">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <SearchXIcon />
                </EmptyMedia>
                <EmptyTitle>No societies match</EmptyTitle>
                <EmptyDescription>
                  Try fewer filters or a shorter search. If a society you know is missing, tell us
                  and we will add it.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent className="flex-row justify-center">
                <Button variant="outline" size="sm" onClick={() => navigate(EMPTY_DIRECTORY)}>
                  Clear filters
                </Button>
                <Button size="sm" asChild>
                  <Link href="/request?kind=add">Add a society</Link>
                </Button>
              </EmptyContent>
            </Empty>
          )}
        </div>

        {pages > 1 && (
          <nav aria-label="Pages" className="flex items-center justify-between gap-2 pt-2">
            {state.page > 1 ? (
              <Button variant="outline" size="sm" asChild>
                <Link href={hrefFor({ ...state, page: state.page - 1 })} scroll>
                  <ChevronLeftIcon data-icon="inline-start" />
                  Previous
                </Link>
              </Button>
            ) : (
              <Button variant="outline" size="sm" disabled>
                <ChevronLeftIcon data-icon="inline-start" />
                Previous
              </Button>
            )}
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
                      <Link
                        href={hrefFor({ ...state, page })}
                        scroll
                        aria-current={page === state.page ? "page" : undefined}
                        aria-label={`Page ${page}`}
                      >
                        {page}
                      </Link>
                    </Button>
                  </li>
                ),
              )}
            </ol>
            <span className="font-mono text-sm text-muted-foreground tabular-nums sm:hidden">
              Page {state.page} of {pages}
            </span>
            {state.page < pages ? (
              <Button variant="outline" size="sm" asChild>
                <Link href={hrefFor({ ...state, page: state.page + 1 })} scroll>
                  Next
                  <ChevronRightIcon data-icon="inline-end" />
                </Link>
              </Button>
            ) : (
              <Button variant="outline" size="sm" disabled>
                Next
                <ChevronRightIcon data-icon="inline-end" />
              </Button>
            )}
          </nav>
        )}
      </div>
    </div>
  )
}
