import { fetchQuery, preloadQuery } from "convex/nextjs"
import type { Metadata } from "next"
import { OrgDirectory } from "@/components/organisms/org-directory"
import { api } from "@/convex/_generated/api"
import { directoryTitle } from "@/lib/directory-title"
import { pageMetadata } from "@/lib/page-metadata"
import type { OrgBusy } from "@/lib/public-api"
import { preloadPublicColleges } from "@/lib/public-data"
import {
  directoryFilters,
  directoryListArgs,
  parseDirectoryParams,
  type SearchParams,
} from "@/lib/url-state"

type Props = { searchParams: Promise<SearchParams> }

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const state = parseDirectoryParams(await searchParams)
  return pageMetadata({
    title: directoryTitle(state),
    description:
      "Browse and filter Cambridge student societies and sports clubs by category, level, college, activities and more. Every fact is sourced.",
    path: "/societies",
  })
}

/** The "Busy this week" shelf. Null when it cannot be read — the page must
 * not fail over a shelf. */
async function loadBusy(): Promise<OrgBusy | null> {
  try {
    return await fetchQuery(api.orgs.busy, { limit: 8 })
  } catch {
    return null
  }
}

/**
 * The directory. The URL is the filter state; this server component preloads
 * the page of cards, the facet counts and the college list for it, so the
 * first paint has data, and the client follows later changes in place.
 */
export default async function SocietiesPage({ searchParams }: Props) {
  const state = parseDirectoryParams(await searchParams)
  const [preloadedList, preloadedFacets, preloadedColleges, busy] = await Promise.all([
    preloadQuery(api.orgs.list, directoryListArgs(state)),
    preloadQuery(api.orgs.facets, directoryFilters(state)),
    preloadPublicColleges(),
    loadBusy(),
  ])

  return (
    <>
      <header className="border-b bg-card/40">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-2 px-4 pt-8 pb-6 sm:px-6 sm:pt-12">
          <p className="font-mono text-xs tracking-wider text-muted-foreground uppercase">
            The directory
          </p>
          <h1 className="font-serif text-4xl font-medium tracking-tight text-balance sm:text-5xl">
            Societies & clubs
          </h1>
          <p className="max-w-2xl text-pretty text-muted-foreground">
            University-wide and college societies, sports clubs, theatre companies and student
            bodies — what they do, how to join, and where every fact came from.
          </p>
        </div>
      </header>
      <OrgDirectory
        preloadedList={preloadedList}
        preloadedFacets={preloadedFacets}
        preloadedColleges={preloadedColleges}
        busy={busy}
      />
    </>
  )
}
