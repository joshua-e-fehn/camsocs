import { fetchQuery } from "convex/nextjs"
import type { FunctionReturnType } from "convex/server"
import type { NextRequest } from "next/server"
import { api } from "@/convex/_generated/api"
import { DAY_MS, londonIsoDate, londonMidnight } from "@/lib/calendar"
import { type IcsTalk, parseTalkFeedParams, talkFeedName, talksCalendar } from "@/lib/ics"

/**
 * `GET /talks.ics` — the talks calendar feed (talks-redesign-spec §4): the
 * next 60 days from the start of today (London) as RFC 5545, filtered by the
 * `/talks` URL state (`school`, `dept` slug, `kind`, `online`, `q`). The Subscribe
 * modal links it as `webcal://`.
 *
 * Cached at the edge for an hour per URL: subscribers poll, and the talks
 * change at most with each harvest.
 */

/** Rendered per request: the feed changes with every harvest, and a build
 * has no data to read. */
export const dynamic = "force-dynamic"

const WINDOW_DAYS = 60
const PAGE = 100
/** Far above 60 days of talks; a stop, not a target. */
const MAX_PAGES = 40
const SEARCH_LIMIT = 50
const DEPARTMENT_NAMES: Record<string, string> = { "other-series": "Other series" }

type ListPage = FunctionReturnType<typeof api.talks.list>

function plain(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  })
}

export async function GET(request: NextRequest): Promise<Response> {
  const parsed = parseTalkFeedParams(request.nextUrl.searchParams)
  if (!parsed.ok) return plain(parsed.error, 400)
  const { filters } = parsed
  const now = Date.now()
  const from = londonMidnight(londonIsoDate(now))
  const to = from + WINDOW_DAYS * DAY_MS

  let talks: IcsTalk[] = []
  try {
    if (filters.q) {
      // Search is by relevance and capped; the feed is still in date order.
      const hits = await fetchQuery(api.talks.search, {
        q: filters.q,
        school: filters.school,
        department: filters.department,
        from,
        limit: SEARCH_LIMIT,
      })
      talks = hits
        .filter(
          (talk) =>
            talk.startsAt < to &&
            (!filters.kind || talk.kind === filters.kind) &&
            (filters.online === undefined || talk.online === filters.online),
        )
        .sort((a, b) => a.startsAt - b.startsAt)
    } else {
      let cursor: string | null = null
      for (let page = 0; page < MAX_PAGES; page++) {
        const result: ListPage = await fetchQuery(api.talks.list, {
          from,
          to,
          school: filters.school,
          department: filters.department,
          kind: filters.kind,
          online: filters.online,
          paginationOpts: { numItems: PAGE, cursor },
        })
        talks.push(...result.page)
        if (result.isDone) break
        cursor = result.continueCursor
      }
    }
  } catch {
    return plain("The talks could not be read just now. Try again later.", 503)
  }

  const departmentName = filters.department
    ? (DEPARTMENT_NAMES[filters.department] ??
      talks
        .flatMap((talk) => talk.departments ?? [])
        .find((department) => department.slug === filters.department)?.shortName)
    : undefined
  const body = talksCalendar(talks, { name: talkFeedName(filters, departmentName), now })
  return new Response(body, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="camsocs-talks.ics"',
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  })
}
