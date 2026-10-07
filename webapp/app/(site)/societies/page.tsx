import { preloadQuery } from "convex/nextjs"
import type { Metadata } from "next"
import { OrgDirectory } from "@/components/organisms/org-directory"
import { api } from "@/convex/_generated/api"
import {
  DIRECTORY_PAGE_SIZE,
  directoryCursor,
  directoryFilters,
  parseDirectoryParams,
  type SearchParams,
} from "@/lib/url-state"
import { CATEGORY_LABELS } from "@/lib/vocab"

type Props = { searchParams: Promise<SearchParams> }

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const state = parseDirectoryParams(await searchParams)
  const category = state.categories.length === 1 ? CATEGORY_LABELS[state.categories[0]] : undefined
  const title = state.q
    ? `“${state.q}” — societies and clubs`
    : category
      ? `${category} societies and clubs`
      : "Societies and clubs"
  return {
    title,
    description:
      "Browse and filter Cambridge student societies and sports clubs by category, level, college, activities and more. Every fact is sourced.",
    alternates: { canonical: "/societies" },
  }
}

/**
 * The directory. The URL is the filter state; this server component preloads
 * the page of cards, the facet counts and the college list for it, so the
 * first paint has data and the client keeps it live.
 */
export default async function SocietiesPage({ searchParams }: Props) {
  const state = parseDirectoryParams(await searchParams)
  const filters = directoryFilters(state)
  const [preloadedList, preloadedFacets, preloadedColleges] = await Promise.all([
    preloadQuery(api.orgs.list, {
      ...filters,
      paginationOpts: { numItems: DIRECTORY_PAGE_SIZE, cursor: directoryCursor(state) },
    }),
    preloadQuery(api.orgs.facets, filters),
    preloadQuery(api.orgs.colleges, {}),
  ])

  return (
    <>
      <header className="border-b">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-2 px-4 py-8 sm:px-6">
          <h1 className="text-3xl font-bold tracking-tight">Societies and clubs</h1>
          <p className="max-w-2xl text-muted-foreground">
            University and college societies, sports clubs, theatre companies and student bodies.
            Filters combine: any of the values within a group, all of the groups together.
          </p>
        </div>
      </header>
      <OrgDirectory
        state={state}
        preloadedList={preloadedList}
        preloadedFacets={preloadedFacets}
        preloadedColleges={preloadedColleges}
      />
    </>
  )
}
