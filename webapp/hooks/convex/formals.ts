// Hooks for the formal tracker (/formals/tracker, convex/formals.ts). The page
// is one cached, anonymous render (docs/webapp.md "Caching"), so everything
// here is asked for only in the browser, once the Convex client holds the
// session; a signed-out view costs no read.
import { useConvexAuth, useMutation, useQuery } from "convex/react"
import type { FunctionReturnType } from "convex/server"
import { ConvexError } from "convex/values"
import { api } from "@/convex/_generated/api"

export type FormalTracker = NonNullable<FunctionReturnType<typeof api.formals.mine>>
export type FormalEntry = FormalTracker["entries"][number]
export type FormalProfile = NonNullable<FormalTracker["profile"]>
export type FormalLeaderboardRow = NonNullable<
  FunctionReturnType<typeof api.formals.leaderboard>
>[number]

/** The args for a signed-in reader only, else "skip" (as hooks/convex/events.ts). */
function useSignedIn<Args>(args: Args | "skip"): Args | "skip" {
  const { isAuthenticated } = useConvexAuth()
  return isAuthenticated ? args : "skip"
}

/** The member's tracker: undefined while loading or signed out (skipped),
 * null if the session has gone. */
export function useFormalTracker() {
  return useQuery(api.formals.mine, useSignedIn({}))
}

/** The leaderboard, asked for once `enabled` (a member who may see it);
 * null for anyone else. */
export function useFormalLeaderboard(enabled: boolean) {
  return useQuery(api.formals.leaderboard, useSignedIn(enabled ? {} : "skip"))
}

export function useSetFormalAttended() {
  return useMutation(api.formals.setAttended)
}

export function useSaveFormalDetails() {
  return useMutation(api.formals.saveDetails)
}

export function useSaveFormalProfile() {
  return useMutation(api.formals.saveProfile)
}

export function useEraseFormalTracker() {
  return useMutation(api.formals.eraseMine)
}

/** The readable part of a failed tracker write: a `ConvexError`'s message,
 * else a plain retry line (a server error's text is never shown). */
export function formalErrorMessage(error: unknown): string {
  if (error instanceof ConvexError && typeof error.data === "string") return error.data
  return "That did not save. Please try again."
}
