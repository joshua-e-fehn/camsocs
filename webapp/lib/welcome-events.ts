import { unstable_rethrow } from "next/navigation"
import { api } from "@/convex/_generated/api"
import { addDays, londonIsoDate, londonMidnight } from "@/lib/calendar"
import type { EventListItem } from "@/lib/public-api"
import { publicQuery } from "@/lib/public-data"
import { dedupeRuns } from "@/lib/sport-calendar"

/** Title words of events for newcomers. */
const WORDS = ["fresher", "freshers", "refreshers", "welcome", "taster", "give it a go"] as const

/**
 * Welcome, freshers' and taster events in the next 90 days, for the
 * Freshers' guide (ENG-117): one cached read per title word (events.list
 * matches every word of `q` in the title), merged and deduplicated. Null when
 * Convex cannot be read.
 */
export async function loadWelcomeEvents(now: number): Promise<EventListItem[] | null> {
  const today = londonIsoDate(now)
  const window = { from: londonMidnight(today), to: londonMidnight(addDays(today, 90)) }
  try {
    const lists = await Promise.all(
      WORDS.map((q) => publicQuery(api.events.list, { ...window, q })),
    )
    const byKey = new Map(lists.flat().map((event) => [event.key, event]))
    const upcoming = dedupeRuns(
      [...byKey.values()].filter(
        (event) =>
          !event.cancelled && !event.talksDerived && (event.endsAt ?? event.startsAt) >= now,
      ),
    )
    // A show on four nights is one line: its first night.
    const seen = new Set<string>()
    return upcoming.filter((event) => {
      const title = event.title.toLowerCase().trim()
      if (seen.has(title)) return false
      seen.add(title)
      return true
    })
  } catch (error) {
    unstable_rethrow(error)
    console.error("events.list failed; the Freshers' guide without its list", error)
    return null
  }
}
