import { unstable_rethrow } from "next/navigation"
import { api } from "@/convex/_generated/api"
import { addDays, londonIsoDate, londonMidnight } from "@/lib/calendar"
import type { EventListItem } from "@/lib/public-api"
import { publicQuery } from "@/lib/public-data"
import type { Category } from "@/lib/vocab"

/** Days ahead the guides look for races and fixtures (events.list allows 186). */
const HORIZON_DAYS = 185

/**
 * The sport events of the next six months, for the rowing and Varsity guides'
 * "coming up" lists (lib/sport-calendar.ts picks from them). Cached and
 * anonymous like every public read; the window starts at London midnight so
 * one cache entry serves the whole day. Null when Convex cannot be read: the
 * guide then shows its text without the list.
 */
export async function loadSportEvents(now: number): Promise<EventListItem[] | null> {
  return loadCategoryEvents(now, "sport", HORIZON_DAYS)
}

/** One category's events from today for `days` days, cached the same way. */
export async function loadCategoryEvents(
  now: number,
  category: Category,
  days: number,
): Promise<EventListItem[] | null> {
  const today = londonIsoDate(now)
  try {
    return await publicQuery(api.events.list, {
      from: londonMidnight(today),
      to: londonMidnight(addDays(today, days)),
      categories: [category],
    })
  } catch (error) {
    unstable_rethrow(error)
    console.error("events.list failed; a guide without its coming-up list", error)
    return null
  }
}

/** Every public, non-talks event from today for `days` days (the events
 * finder's "this week's picks"), cached the same way; null when Convex
 * cannot be read. */
export async function loadUpcomingEvents(
  now: number,
  days: number,
): Promise<EventListItem[] | null> {
  const today = londonIsoDate(now)
  try {
    return await publicQuery(api.events.list, {
      from: londonMidnight(today),
      to: londonMidnight(addDays(today, days)),
      university: "hide",
    })
  } catch (error) {
    unstable_rethrow(error)
    console.error("events.list failed; the events finder without its picks", error)
    return null
  }
}
