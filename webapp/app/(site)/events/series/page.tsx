import type { Metadata } from "next"
import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { api } from "@/convex/_generated/api"
import { formatDate, londonIsoDate } from "@/lib/calendar"
import { collectionJsonLd } from "@/lib/directory-hubs"
import { SERIES_INDEX_PATH, seriesPath } from "@/lib/event-series"
import { pageMetadata } from "@/lib/page-metadata"
import { publicQuery } from "@/lib/public-data"
import { jsonLdScript } from "@/lib/structured-data"

const TITLE = "Yearly Cambridge events: every edition, one page each"
const DESCRIPTION =
  "Cambridge's recurring student events, from the Greek Play and the Footlights panto to the Fairbairn Cup and the Steele-Bodger: the next dates and every year's edition."

export const metadata: Metadata = pageMetadata({
  title: TITLE,
  description: DESCRIPTION,
  path: SERIES_INDEX_PATH,
})

type Series = Awaited<ReturnType<typeof loadSeries>>[number]

/** Every series; a failed read is thrown (5xx), so an empty page is never cached. */
async function loadSeries() {
  try {
    return await publicQuery(api.eventSeries.list, {})
  } catch (error) {
    unstable_rethrow(error)
    throw error
  }
}

/**
 * `/events/series` (ENG-282): every recurring event CAMsocs has seen, the
 * ones with a date coming up first (soonest first), then the rest by name.
 * Each links its own page, which keeps one URL from year to year.
 */
export default async function SeriesIndexPage() {
  const all = await loadSeries()
  const upcoming = all
    .filter((series) => series.nextStartsAt !== undefined)
    .sort((a, b) => (a.nextStartsAt ?? 0) - (b.nextStartsAt ?? 0))
  const rest = all.filter((series) => series.nextStartsAt === undefined)
  const jsonLd = collectionJsonLd({
    path: SERIES_INDEX_PATH,
    title: TITLE,
    description: DESCRIPTION,
    items: [...upcoming, ...rest].map((series) => ({
      name: series.name,
      path: seriesPath(series.slug),
    })),
    crumbs: [
      { name: "Events", path: "/events" },
      { name: "Yearly events", path: SERIES_INDEX_PATH },
    ],
  })

  return (
    <>
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD, `<` escaped by jsonLdScript
        dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }}
      />
      <header className="border-b bg-card/40">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 pt-8 pb-6 sm:px-6 sm:pt-12">
          <p className="font-mono text-xs tracking-wider text-muted-foreground uppercase">
            <Link href="/events" className="underline-offset-4 hover:underline">
              Events
            </Link>
          </p>
          <h1 className="font-serif text-4xl font-medium tracking-tight text-balance sm:text-5xl">
            Yearly events in Cambridge
          </h1>
          <p className="max-w-2xl text-pretty text-muted-foreground">
            Shows, races, matches and fairs that come back every year. Each has one page that stays
            the same from year to year, with the next dates and the earlier editions.
          </p>
        </div>
      </header>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-4 py-8 sm:px-6 sm:py-10">
        <SeriesList
          id="coming-up"
          heading="Coming up"
          series={upcoming}
          when={(series) =>
            `Next: ${formatDate(londonIsoDate(series.nextStartsAt ?? series.lastStartsAt))}`
          }
          empty="No yearly event has a date listed at the moment."
        />
        {rest.length > 0 && (
          <SeriesList
            id="not-yet-listed"
            heading="Next edition not listed yet"
            series={rest}
            when={(series) => `Last: ${formatDate(londonIsoDate(series.lastStartsAt))}`}
          />
        )}
      </div>
    </>
  )
}

function SeriesList({
  id,
  heading,
  series,
  when,
  empty,
}: {
  id: string
  heading: string
  series: readonly Series[]
  when: (series: Series) => string
  empty?: string
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="font-serif text-2xl">
        {heading}
      </h2>
      {series.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-xl border text-sm">
          {series.map((row) => (
            <li key={row.slug} className="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:gap-4">
              <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums sm:w-44 sm:pt-0.5">
                {when(row)}
              </span>
              <span className="min-w-0">
                <Link
                  href={seriesPath(row.slug)}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {row.name}
                </Link>
                {row.org && <span className="text-muted-foreground"> · {row.org.name}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
