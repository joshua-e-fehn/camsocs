import type { Metadata } from "next"
import { DayMap } from "@/components/organisms/day-map"
import { api } from "@/convex/_generated/api"
import { londonIsoDate, startOfWeek } from "@/lib/calendar"
import { mapDate, mapIndexing, parseMapParams } from "@/lib/map-url-state"
import { pageMetadata } from "@/lib/page-metadata"
import { publicPreload } from "@/lib/public-data"
import type { SearchParams } from "@/lib/url-state"

type Props = { searchParams: Promise<SearchParams> }

const TITLE = "Map of today’s events and talks"
const DESCRIPTION =
  "Where Cambridge’s student events and public talks are happening, day by day, on a map of the city: what is on now, what is next, and directions to each venue."

/**
 * `/map` is one indexable page; every `?d=` or `?show=` view is noindex,
 * follow, canonical to it (docs/locations-and-map.md §4, lib/map-url-state.ts),
 * and robots.txt disallows `/map?` (lib/crawl-traps.ts).
 */
export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const { canonical, index } = mapIndexing(await searchParams)
  return {
    ...pageMetadata({ title: TITLE, description: DESCRIPTION, path: canonical }),
    ...(index ? {} : { robots: { index: false, follow: true } }),
  }
}

/**
 * The map of one London day. The server preloads the day's events only — no
 * talks and no talks.cam-derived events (owner decision G1,
 * lib/talks-boundary.ts: nothing from talks.cam in the HTML or RSC payload of
 * a URL outside /talks) — and the week strip's counts, which are numbers
 * only. The organism adds the talks in the browser once hydrated.
 *
 * Anonymous and cached (lib/public-data.ts): a signed-in reader's
 * Cambridge-only events join through the live query. No loading.tsx, so the
 * H1 is in the first chunk of HTML.
 */
export default async function MapPage({ searchParams }: Props) {
  const serverNow = Date.now()
  const today = londonIsoDate(serverNow)
  const date = mapDate(parseMapParams(await searchParams), today)
  const [preloadedDay, preloadedWeek] = await Promise.all([
    publicPreload(api.map.day, { date, talks: "exclude", talksCam: "exclude" }),
    publicPreload(api.map.weekCounts, { from: startOfWeek(date), days: 7 }),
  ])
  return (
    <DayMap
      today={today}
      serverNow={serverNow}
      preloadedDay={preloadedDay}
      preloadedWeek={preloadedWeek}
    />
  )
}
