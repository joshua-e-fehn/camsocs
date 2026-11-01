import { fetchQuery, preloadQuery } from "convex/nextjs"
import type { Metadata } from "next"
import { unstable_rethrow } from "next/navigation"
import { TalksBrowser } from "@/components/organisms/talks-browser"
import { api } from "@/convex/_generated/api"
import type { InitialTalkPage } from "@/hooks/convex/talks"
import { londonIsoDate } from "@/lib/calendar"
import { currentTermEnd } from "@/lib/date-presets"
import { pageMetadata } from "@/lib/page-metadata"
import type { TalkOverview } from "@/lib/talks"
import {
  parseTalksParams,
  TALKS_PAGE_SIZE,
  talksCountArgs,
  talksDayCountArgs,
  talksListArgs,
  talksSearchArgs,
  talksWindow,
} from "@/lib/talks-url-state"
import { fetchTermDates } from "@/lib/term-dates"
import type { TermDatesRow } from "@/lib/term-week"
import type { SearchParams } from "@/lib/url-state"
import { stripAnchor } from "@/lib/week-strip"

type Props = { searchParams: Promise<SearchParams> }

export const metadata: Metadata = pageMetadata({
  title: "Talks",
  description:
    "Public seminars, lectures and workshops across Cambridge departments, day by day — filter by School, department or kind, and subscribe in your own calendar.",
  path: "/talks",
})

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
    return await fetchQuery(api.talks.overview, {})
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
    preloadQuery(api.talks.departments, {}),
    state.q
      ? undefined
      : fetchQuery(api.talks.list, {
          ...listArgs,
          paginationOpts: { numItems: TALKS_PAGE_SIZE, cursor: null },
        }),
    state.q ? preloadQuery(api.talks.search, talksSearchArgs(state, span)) : undefined,
    preloadQuery(
      api.talks.dayCounts,
      talksDayCountArgs(state, stripAnchor(span.first, span.last, today)),
    ),
    state.q ? undefined : preloadQuery(api.talks.dayCounts, talksCountArgs(state, span).args),
    state.talk ? preloadQuery(api.talks.get, { key: state.talk }) : undefined,
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
