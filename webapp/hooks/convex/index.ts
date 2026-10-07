// Convex-specific hooks: thin wrappers over useQuery/useMutation from
// convex/react. Convex has its own real-time subscriptions — never wrap a
// Convex query in another data-fetching library.
//
// A hook that must not run yet passes "skip" as the args:
//   useQuery(api.x.y, ready ? { id } : "skip")
import { useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"

/** The signed-in user's profile, null when signed out, undefined while loading. */
export function useCurrentUser() {
  return useQuery(api.auth.getCurrentUser)
}

/** `{ signedIn, isBroker }` for the caller, undefined while loading. */
export function useBrokerAccess() {
  return useQuery(api.auth.getBrokerAccess)
}

/** `{ google, camEmail }`: which sign-in options the deployment has switched on. */
export function useSignInOptions() {
  return useQuery(api.auth.getSignInOptions)
}

/** `{ signedIn, isBroker, isCamVerified }` for the caller, undefined while loading. */
export function useViewerTier() {
  return useQuery(api.auth.getViewerTier)
}
