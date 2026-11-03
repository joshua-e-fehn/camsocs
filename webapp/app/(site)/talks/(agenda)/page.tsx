import type { Metadata } from "next"
import { unstable_rethrow } from "next/navigation"
import { cache } from "react"
import { TalksBrowser } from "@/components/organisms/talks-browser"
import { api } from "@/convex/_generated/api"
import type { InitialTalkPage } from "@/hooks/convex/talks"
import { londonIsoDate } from "@/lib/calendar"
import { currentTermEnd } from "@/lib/date-presets"
import { pageMetadata } from "@/lib/page-metadata"
import { publicPreload, publicQuery } from "@/lib/public-data"
import { type TalkOverview, talksPageTitle } from "@/lib/talks"
import {
  parseTalksParams,
  TALKS_PAGE_SIZE,
  talksCountArgs,
  talksDayCountArgs,
  talksFeedQuery,
  talksIndexing,
  talksListArgs,
  talksSearchArgs,
  talksWindow,
} from "@/lib/talks-url-state"
import { fetchTermDates } from "@/lib/term-dates"
import type { TermDatesRow } from "@/lib/term-week"
import type { SearchParams } from "@/lib/url-state"
import { stripAnchor } from "@/lib/week-strip"

type Props = { searchParams: Promise<SearchParams> }

const DESCRIPTION =
  "Public seminars, lectures and workshops across Cambridge departments, day by day — filter by School, department or kind, and subscribe in your own calendar."

/** The `?dept=` department, for the title and description (the page's own
 * preload of the departments is opaque to the metadata). */
const departmentName = cache(async (slug: string | undefined) => {
  if (!slug) return undefined
  try {
    const departments = await publicQuery(api.talks.departments, {})
    return departments.find((department) => department.slug === slug)
  } catch (error) {
    unstable_rethrow(error)
    return undefined
  }
})

/**
 * The agenda, one department's and one School's are pages of their own for
 * classic search, each canonical with its own title (SEO audit
 * "talks-department-hubs", "hub-page-titles-weak"); every other slice is
 * noindex, follow (lib/talks-url-state.ts `talksIndexing`). The talks feed
 * is their calendar alternate. robots.txt and proxy.ts keep AI agents out of
 * all of it.
 */
export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const state = parseTalksParams(await searchParams)
  const { canonical, index } = talksIndexing(state)
  const department = await departmentName(state.dept)
  const { title, absolute } = talksPageTitle(state, department?.shortName)
  const description = department
    ? `Public seminars, lectures and workshops in ${department.name}, Cambridge, day by day — and subscribe in your own calendar.`
    : DESCRIPTION
  const base = pageMetadata({ title, description, path: canonical })
  return {
    ...base,
    ...(absolute ? { title: { absolute: title } } : {}),
    alternates: {
      ...base.alternates,
      types: { "text/calendar": [{ url: `/talks.ics${talksFeedQuery(state)}`, title }] },
    },
    ...(index ? {} : { robots: { index: false, follow: true } }),
  }
}

/** Term dates for "Rest of term" and the week tags. Decoration: without
 * them the agenda still renders. */
async function loadTerms(): Promise<TermDatesRow[]> {
  try {
    return await fetchTermDates()
  } catch (error) {
    unstable_rethrow(error)
    return []
  }
}

/** The header's numbers; null when they cannot be read. */
async function loadOverview(): Promise<TalkOverview | null> {
  try {
    return await publicQuery(api.talks.overview, {})
  } catch (error) {
    unstable_rethrow(error)
    return null
  }
}

/**
 * The talks agenda. The URL is the filter state (lib/talks-url-state.ts);
 * this server component preloads, for it: the department index (counts per
 * School and department), the first page of the agenda (or the search), the
 * week strip's counts and the window's total, and an open talk — so the
 * first paint has data, and the client follows later changes in place.
 */
export default async function TalksPage({ searchParams }: Props) {
  const state = parseTalksParams(await searchParams)
  const today = londonIsoDate(Date.now())
  const [terms, overview] = await Promise.all([loadTerms(), loadOverview()])
  const span = talksWindow(state, today, currentTermEnd(today, terms))
  const listArgs = talksListArgs(state, span)

  const [
    preloadedDepartments,
    firstPage,
    preloadedSearch,
    preloadedWeek,
    preloadedTotal,
    preloadedTalk,
  ] = await Promise.all([
    publicPreload(api.talks.departments, {}),
    state.q
      ? undefined
      : publicQuery(api.talks.list, {
          ...listArgs,
          paginationOpts: { numItems: TALKS_PAGE_SIZE, cursor: null },
        }),
    state.q ? publicPreload(api.talks.search, talksSearchArgs(state, span)) : undefined,
    publicPreload(
      api.talks.dayCounts,
      talksDayCountArgs(state, stripAnchor(span.first, span.last, today)),
    ),
    state.q ? undefined : publicPreload(api.talks.dayCounts, talksCountArgs(state, span).args),
    state.talk ? publicPreload(api.talks.get, { key: state.talk }) : undefined,
  ])
  const initialPage: InitialTalkPage | undefined = firstPage && {
    args: listArgs,
    page: firstPage.page,
    isDone: firstPage.isDone,
  }

  return (
    <TalksBrowser
      today={today}
      terms={terms}
      overview={overview}
      preloadedDepartments={preloadedDepartments}
      initialPage={initialPage}
      preloadedSearch={preloadedSearch}
      preloadedWeek={preloadedWeek}
      preloadedTotal={preloadedTotal}
      preloadedTalk={preloadedTalk}
    />
  )
}
