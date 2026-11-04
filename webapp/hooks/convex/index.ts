// Convex-specific hooks: thin wrappers over useQuery/useMutation from
// convex/react. Convex has its own real-time subscriptions — never wrap a
// Convex query in another data-fetching library.
//
// A hook that must not run yet passes "skip" as the args:
//   useQuery(api.x.y, ready ? { id } : "skip")
import { useConvexAuth, useQuery } from "convex/react"
import { useMemo } from "react"
import { api } from "@/convex/_generated/api"
import { addDays, londonIsoDate, londonMidnight } from "@/lib/calendar"

/** The signed-in user's profile, null when signed out, undefined while loading. */
export function useCurrentUser() {
  return useQuery(api.auth.getCurrentUser)
}

/**
 * `{ signedIn, isBroker }` for the caller, undefined while loading — and while
 * the Convex client is still taking up the session. The server hands it no
 * token (app/layout.tsx), so on a fresh load of /dashboard the first answer
 * would otherwise be a signed-out "no broker access" before the right one.
 */
export function useBrokerAccess() {
  const { isLoading } = useConvexAuth()
  return useQuery(api.auth.getBrokerAccess, isLoading ? "skip" : {})
}

const ORG_SEARCH_LIMIT = 8

/** Directory cards whose name matches `q` (search relevance), for pickers.
 * Skipped while `q` is empty; undefined while loading. */
export function useOrgSearch(q: string) {
  const text = q.trim()
  return useQuery(
    api.orgs.list,
    text ? { q: text, paginationOpts: { numItems: ORG_SEARCH_LIMIT, cursor: null } } : "skip",
  )
}

/** The colleges (key, slug, name), for naming `collegeKeys`; skipped until
 * `enabled`. */
export function useColleges(enabled: boolean) {
  return useQuery(api.orgs.colleges, enabled ? {} : "skip")
}

const EVENT_SEARCH_DAYS = 28

/** Events of the next four weeks (today included) whose title has every word
 * of `q`, by start time — for the ⌘K palette. Skipped below two characters;
 * the window moves on at London midnight, not on every render. */
export function useEventSearch(q: string) {
  const text = q.trim()
  const today = londonIsoDate(Date.now())
  const range = useMemo(
    () => ({ from: londonMidnight(today), to: londonMidnight(addDays(today, EVENT_SEARCH_DAYS)) }),
    [today],
  )
  // The browser only, so talks.cam-derived events may be found too (owner
  // decision G1 keeps them out of server renders, not out of search).
  return useQuery(
    api.events.list,
    text.length >= 2 ? { ...range, q: text, talksCam: "include" as const } : "skip",
  )
}

const TALK_SEARCH_LIMIT = 6

/** Upcoming talks matching `q` (title, speakers, series, venue, departments),
 * best match first — for the ⌘K palette. Skipped below two characters. */
export function useTalkSearch(q: string) {
  const text = q.trim()
  return useQuery(
    api.talks.search,
    text.length >= 2 ? { q: text, limit: TALK_SEARCH_LIMIT } : "skip",
  )
}

/** One event the viewer may see (null if not), skipped without a key. */
export function useEvent(key: string | undefined) {
  return useQuery(api.events.get, key ? { key } : "skip")
}

/** `{ title }` of the event a request is about: null for one this viewer may
 * not see or a talks.cam-derived one (G1); undefined while loading. */
export function useEventRequestLabel(key: string) {
  return useQuery(api.events.requestLabel, { key })
}

/** The venues, for naming an event's `venueKey`; skipped until `enabled`. */
export function useVenues(enabled: boolean) {
  return useQuery(api.venues.list, enabled ? {} : "skip")
}

/** `{ google, camEmail }`: which sign-in options the deployment has switched on. */
export function useSignInOptions() {
  return useQuery(api.auth.getSignInOptions)
}

/** `{ signedIn, isBroker, isCamVerified }` for the caller, undefined while loading. */
export function useViewerTier() {
  return useQuery(api.auth.getViewerTier)
}
