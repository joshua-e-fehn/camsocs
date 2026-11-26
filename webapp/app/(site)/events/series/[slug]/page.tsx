import type { Metadata } from "next"
import Link from "next/link"
import { notFound, unstable_rethrow } from "next/navigation"
import { UpcomingEventList } from "@/components/molecules/upcoming-event-list"
import { api } from "@/convex/_generated/api"
import { formatDate, londonIsoDate } from "@/lib/calendar"
import { collectionJsonLd } from "@/lib/directory-hubs"
import {
  editionsOf,
  leadEdition,
  SERIES_INDEX_PATH,
  seriesDescription,
  seriesPath,
  seriesTitle,
} from "@/lib/event-series"
import { pageMetadata } from "@/lib/page-metadata"
import { publicQuery } from "@/lib/public-data"
import { jsonLdScript } from "@/lib/structured-data"

type Props = { params: Promise<{ slug: string }> }

/** Rendered on first request, then cached at the edge (docs/webapp.md "Caching"). */
export function generateStaticParams(): { slug: string }[] {
  return []
}

/** The series, or null when it does not exist; a failed read is thrown (5xx), never a 404. */
async function load(slug: string) {
  try {
    return await publicQuery(api.eventSeries.get, { slug })
  } catch (error) {
    unstable_rethrow(error)
    throw error
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
  const data = await load(slug)
  if (!data) notFound()
  const lead = leadEdition(editionsOf(data.editions), Date.now())
  const year = lead?.edition.year
  return pageMetadata({
    title: seriesTitle(data.series.name, year),
    description: seriesDescription(data.series.name, data.series.org?.name, year),
    path: seriesPath(data.series.slug),
  })
}

/**
 * `/events/series/<slug>` (ENG-282): one recurring event, whatever the year.
 * Each year's edition has its own event pages; this page keeps one URL, so
 * what it earns in search carries over to next year's edition. It leads with
 * the edition still to come (or the latest held), then the earlier editions
 * CAMsocs still holds (events go a year after they end, retention R3).
 */
export default async function SeriesPage({ params }: Props) {
  const { slug } = await params
  const data = await load(slug)
  if (!data) notFound()
  const { series } = data
  const now = Date.now()
  const editions = editionsOf(data.editions)
  const lead = leadEdition(editions, now)
  const earlier = editions.filter((edition) => edition !== lead?.edition)
  const path = seriesPath(series.slug)
  const jsonLd = collectionJsonLd({
    path,
    title: seriesTitle(series.name, lead?.edition.year),
    description: seriesDescription(series.name, series.org?.name, lead?.edition.year),
    items: editions
      .flatMap((edition) => edition.events)
      .slice(0, 50)
      .map((event) => ({ name: event.title, path: `/events/${event.key}` })),
    crumbs: [
      { name: "Events", path: "/events" },
      { name: "Yearly events", path: SERIES_INDEX_PATH },
      { name: series.name, path },
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
            <Link href={SERIES_INDEX_PATH} className="underline-offset-4 hover:underline">
              Yearly events
            </Link>
          </p>
          <h1 className="font-serif text-4xl font-medium tracking-tight text-balance sm:text-5xl">
            {series.name}
          </h1>
          <p className="max-w-2xl text-pretty text-muted-foreground">
            {series.org ? (
              <>
                Held every year by{" "}
                <Link
                  href={`/societies/${series.org.slug}`}
                  className="text-foreground underline underline-offset-4"
                >
                  {series.org.name}
                </Link>
                .
              </>
            ) : (
              "Held every year in Cambridge."
            )}{" "}
            This page stays the same from year to year: each edition is added here as soon as it is
            listed.
          </p>
        </div>
      </header>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-4 py-8 sm:px-6 sm:py-10">
        <section aria-labelledby="lead" className="flex flex-col gap-3">
          <h2 id="lead" className="font-serif text-2xl">
            {lead
              ? lead.upcoming
                ? `${series.name} ${lead.edition.year}`
                : `Last held: ${lead.edition.year}`
              : "Dates"}
          </h2>
          {lead && !lead.upcoming && (
            <p className="text-sm text-muted-foreground">
              The next edition is not listed yet. It last took place on{" "}
              {formatDate(londonIsoDate(lead.edition.events[0].startsAt))}; it appears here once it
              is announced.
            </p>
          )}
          {lead ? (
            <UpcomingEventList events={lead.edition.events} empty="" limit={40} />
          ) : (
            <p className="text-sm text-muted-foreground">
              No edition is listed at the moment; it appears here once it is announced.
            </p>
          )}
        </section>
        {earlier.length > 0 && (
          <section aria-labelledby="earlier" className="flex flex-col gap-3">
            <h2 id="earlier" className="font-serif text-2xl">
              Earlier editions
            </h2>
            {earlier.map((edition) => (
              <div key={edition.year} className="flex flex-col gap-2">
                <h3 className="font-mono text-sm text-muted-foreground">{edition.year}</h3>
                <UpcomingEventList events={edition.events} empty="" limit={40} />
              </div>
            ))}
          </section>
        )}
        <p className="text-sm text-muted-foreground">
          <Link href={SERIES_INDEX_PATH} className="underline underline-offset-4">
            All yearly events
          </Link>
          {" · "}
          <Link href="/events" className="underline underline-offset-4">
            The events calendar
          </Link>
          {series.org && (
            <>
              {" · "}
              <Link href={`/societies/${series.org.slug}`} className="underline underline-offset-4">
                {series.org.name}
              </Link>
            </>
          )}
        </p>
      </div>
    </>
  )
}
