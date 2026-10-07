// Convex-specific hooks: thin wrappers over useQuery/useMutation from
// convex/react. Convex has its own real-time subscriptions — never wrap a
// Convex query in another data-fetching library.
//
// A hook that must not run yet passes "skip" as the args:
//   useQuery(api.x.y, ready ? { id } : "skip")
import { useMutation, useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"

/** The signed-in user's profile, null when signed out, undefined while loading. */
export function useCurrentUser() {
  return useQuery(api.auth.getCurrentUser)
}

/** `{ signedIn, isBroker }` for the caller, undefined while loading. */
export function useBrokerAccess() {
  return useQuery(api.auth.getBrokerAccess)
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

/** One event the viewer may see (null if not), skipped without a key. */
export function useEvent(key: string | undefined) {
  return useQuery(api.events.get, key ? { key } : "skip")
}

/** The venues, for naming an event's `venueKey`; skipped until `enabled`. */
export function useVenues(enabled: boolean) {
  return useQuery(api.venues.list, enabled ? {} : "skip")
}

/** The public claim / correct / remove / object / add form. */
export function useSubmitListingRequest() {
  return useMutation(api.listingRequests.submit)
}

/** `{ google, camEmail }`: which sign-in options the deployment has switched on. */
export function useSignInOptions() {
  return useQuery(api.auth.getSignInOptions)
}

/** `{ signedIn, isBroker, isCamVerified }` for the caller, undefined while loading. */
export function useViewerTier() {
  return useQuery(api.auth.getViewerTier)
}
