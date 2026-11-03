import { ArrowLeftIcon, CalendarSyncIcon, ChevronRightIcon } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound, unstable_rethrow } from "next/navigation"
import { cache } from "react"
import { TalkActionBar, TalkDetails } from "@/components/molecules/talk-details"
import { TrackView } from "@/components/molecules/track-view"
import { api } from "@/convex/_generated/api"
import { analyticsAttrs } from "@/lib/analytics-events"
import { londonIsoDate } from "@/lib/calendar"
import { pageMetadata } from "@/lib/page-metadata"
import { publicQuery } from "@/lib/public-data"
import { SITE_URL } from "@/lib/site"
import { jsonLdScript } from "@/lib/structured-data"
import { SCHOOL_TONE, talkMetaDescription, talkStructuredData } from "@/lib/talks"
import { isTalkKey, talksFeedQuery, talksHref } from "@/lib/talks-url-state"
import { fetchTermDates } from "@/lib/term-dates"
import type { TermDatesRow } from "@/lib/term-week"
import { cn } from "@/lib/utils"
import { termWeekTag } from "@/lib/week-strip"

type Props = { params: Promise<{ key: string }> }

/** No talk page is built with the site: each is rendered on its first
 * request and then served from the edge, revalidated as the (site) layout
 * says (docs/webapp.md "Caching"). proxy.ts answers AI agents with a 403
 * before that cache, and an unknown key with a 404. */
export function generateStaticParams(): { key: string }[] {
  return []
}

/** One read per render, shared by the metadata and the page. */
const loadTalk = cache(async (key: string) => {
  if (!isTalkKey(key)) return null
  return await publicQuery(api.talks.get, { key })
})

async function loadTerms(): Promise<TermDatesRow[]> {
  try {
    return await fetchTermDates()
  } catch (error) {
    unstable_rethrow(error)
    return []
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const talk = await loadTalk((await params).key)
  if (!talk) notFound()
  return pageMetadata({
    title: talk.cancelled ? `Cancelled: ${talk.title}` : talk.title,
    description: talkMetaDescription(talk),
    path: `/talks/${talk.key}`,
  })
}

/**
 * A talk's own, shareable page (talks-redesign-spec §6): the details the
 * /talks sheet shows, as an article with its schema.org graph (WebPage,
 * Event, BreadcrumbList; lib/talks.ts `talkStructuredData`) and a
 * canonical URL; on a phone a sticky bar carries Add to calendar, the
 * source and Share. The talk's listing on its source stays the authority —
 * "Read at source" links it.
 */
export default async function TalkPage({ params }: Props) {
  const talk = await loadTalk((await params).key)
  if (!talk) notFound()
  const terms = await loadTerms()
  const pageUrl = `${SITE_URL}/talks/${talk.key}`
  const department = talk.departments[0]
  const termWeek = termWeekTag(londonIsoDate(talk.startsAt), terms)
  const feed = department ? talksFeedQuery({ dept: department.slug }) : ""

  return (
    <>
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD; `<` is escaped (jsonLdScript)
        dangerouslySetInnerHTML={{ __html: jsonLdScript(talkStructuredData(talk)) }}
      />
      <div className="border-b bg-card/40">
        <nav
          aria-label="Breadcrumb"
          className="mx-auto flex w-full max-w-7xl items-center gap-1.5 px-4 py-3 text-sm text-muted-foreground sm:px-6"
        >
          <Link
            href="/talks"
            className="inline-flex min-h-11 items-center gap-1 underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring sm:min-h-8"
          >
            <ArrowLeftIcon aria-hidden className="size-3.5 sm:hidden" />
            Talks
          </Link>
          {department && (
            <>
              <ChevronRightIcon aria-hidden className="hidden size-3.5 sm:block" />
              <Link
                href={talksHref({ dept: department.slug })}
                className="hidden min-h-8 items-center underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring sm:inline-flex"
              >
                {department.shortName}
              </Link>
            </>
          )}
        </nav>
      </div>

      <div className="mx-auto grid w-full max-w-7xl gap-x-16 gap-y-10 px-4 pt-8 pb-32 sm:px-6 sm:pt-12 sm:pb-20 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <article className="max-w-3xl">
          <TrackView
            event="talk_viewed"
            props={{ talkKey: talk.key, departmentKey: department?.key }}
          />
          <TalkDetails
            talk={talk}
            pageUrl={pageUrl}
            termWeek={termWeek}
            showTitle
            actions="from-sm"
          />
        </article>

        {department && (
          <aside aria-label={`More from ${department.shortName}`} className="lg:pt-16">
            <div className="flex flex-col gap-4 rounded-2xl border bg-card p-5 lg:sticky lg:top-[calc(var(--site-header-height,4rem)+1.5rem)]">
              <p className="flex items-center gap-2 font-mono text-[0.6875rem] tracking-[0.14em] text-muted-foreground uppercase">
                <span
                  aria-hidden
                  className={cn("size-2 rounded-full", SCHOOL_TONE[department.school].dot)}
                />
                The department
              </p>
              <p className="font-serif text-2xl leading-tight">{department.shortName}</p>
              <p className="text-sm text-muted-foreground">
                Every talk it lists, day by day — or in your own calendar, kept up to date.
              </p>
              <div className="flex flex-col gap-2">
                <Link
                  href={talksHref({ dept: department.slug })}
                  className="inline-flex h-11 items-center justify-between gap-2 rounded-full border px-4 text-sm font-medium transition-colors hover:border-foreground/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:h-10"
                >
                  All its talks
                  <ChevronRightIcon aria-hidden className="size-4" />
                </Link>
                <a
                  href={`webcal://${new URL(SITE_URL).host}/talks.ics${feed}`}
                  {...analyticsAttrs("calendar_subscribe_clicked", {
                    feed: "talks",
                    key: department.key,
                  })}
                  className="inline-flex h-11 items-center justify-between gap-2 rounded-full border border-talks px-4 text-sm font-medium text-talks transition-colors hover:bg-talks-tint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:h-10"
                >
                  Subscribe to its talks
                  <CalendarSyncIcon aria-hidden className="size-4" />
                </a>
              </div>
            </div>
          </aside>
        )}
      </div>
      <TalkActionBar talk={talk} pageUrl={pageUrl} />
    </>
  )
}
