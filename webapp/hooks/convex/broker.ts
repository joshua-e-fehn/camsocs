// Hooks for the private broker area (/dashboard). Thin wrappers over
// convex/react, like ./index.ts. Every function behind them calls
// `requireBrokerUser`, so they are only mounted inside `BrokerGate`
// (components/organisms/broker-gate.tsx) — a non-broker would get a thrown
// query instead of an empty page.
import { useMutation, usePaginatedQuery, useQuery } from "convex/react"
import type { FunctionReturnType } from "convex/server"
import { ConvexError } from "convex/values"
import { useEffect } from "react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { RelationshipType } from "@/lib/vocab"

export type BrokerOrgRow = FunctionReturnType<typeof api.broker.orgs.page>["page"][number]
export type BrokerOrgDetail = NonNullable<FunctionReturnType<typeof api.broker.orgs.detail>>
export type BrokerPerson = FunctionReturnType<typeof api.broker.people.list>[number]
export type BrokerInteraction = FunctionReturnType<typeof api.broker.interactions.list>[number]
export type BrokerIntroduction = FunctionReturnType<typeof api.broker.introductions.list>[number]
export type BrokerGraph = FunctionReturnType<typeof api.broker.graph.relationships>
export type BrokerMatch = FunctionReturnType<typeof api.broker.graph.matches>[number]
export type BrokerListingRequest = FunctionReturnType<
  typeof api.broker.listingRequests.list
>[number]
export type BrokerOrgRef = FunctionReturnType<typeof api.broker.orgs.search>[number]
export type BrokerSuppression = FunctionReturnType<typeof api.broker.suppressions.list>[number]
export type BrokerSummary = FunctionReturnType<typeof api.broker.overview.summary>

const PAGE = 250

/**
 * Every organisation row, loading page after page until done (about a
 * thousand rows, a few hundred bytes each). `rows` is undefined until the
 * first page arrives; `complete` turns true once the last one has.
 */
export function useAllBrokerOrgRows() {
  const { results, status, loadMore } = usePaginatedQuery(
    api.broker.orgs.page,
    {},
    { initialNumItems: PAGE },
  )
  useEffect(() => {
    if (status === "CanLoadMore") loadMore(PAGE)
  }, [status, loadMore])
  return {
    rows: status === "LoadingFirstPage" ? undefined : results,
    complete: status === "Exhausted",
  }
}

export function useBrokerOrgDetail(key: string | null) {
  return useQuery(api.broker.orgs.detail, key ? { key } : "skip")
}

export function useBrokerOrgSearch(q: string) {
  const text = q.trim()
  return useQuery(api.broker.orgs.search, text ? { q: text } : "skip")
}

export function useBrokerSummary() {
  return useQuery(api.broker.overview.summary)
}

export function useBrokerPeople() {
  return useQuery(api.broker.people.list)
}

export function useBrokerInteractions(orgKey?: string) {
  return useQuery(api.broker.interactions.list, orgKey ? { orgKey } : {})
}

export function useBrokerFollowUps(days?: number) {
  return useQuery(api.broker.interactions.followUps, days === undefined ? {} : { days })
}

export function useBrokerIntroductions() {
  return useQuery(api.broker.introductions.list)
}

export function useBrokerGraph(types: RelationshipType[]) {
  return useQuery(api.broker.graph.relationships, types.length ? { types } : {})
}

export function useBrokerMatches() {
  return useQuery(api.broker.graph.matches)
}

export function useBrokerListingRequests(status?: BrokerListingRequest["status"]) {
  return useQuery(api.broker.listingRequests.list, status ? { status } : {})
}

/** Suppressions of one listing (removals and objections accepted). */
export function useBrokerSuppressions(orgKey: string | null) {
  return useQuery(api.broker.suppressions.list, orgKey ? { orgKey } : "skip")
}

/** The broker's write operations, grouped by area. */
export function useBrokerOrgMutations() {
  return {
    updateProfile: useMutation(api.broker.orgs.updateProfile),
    setNeedOffer: useMutation(api.broker.orgs.setNeedOffer),
    setHidden: useMutation(api.broker.orgs.setHidden),
  }
}

export function useBrokerPeopleMutations() {
  return {
    create: useMutation(api.broker.people.create),
    update: useMutation(api.broker.people.update),
    setArchived: useMutation(api.broker.people.setArchived),
  }
}

export function useBrokerInteractionMutations() {
  return {
    create: useMutation(api.broker.interactions.create),
    update: useMutation(api.broker.interactions.update),
    completeFollowUp: useMutation(api.broker.interactions.completeFollowUp),
    remove: useMutation(api.broker.interactions.remove),
  }
}

export function useBrokerIntroductionMutations() {
  return {
    create: useMutation(api.broker.introductions.create),
    update: useMutation(api.broker.introductions.update),
    remove: useMutation(api.broker.introductions.remove),
  }
}

export function useSetListingRequestStatus() {
  return useMutation(api.broker.listingRequests.setStatus)
}

/** Accepting requests: corrections become owner claims, removals suppressions. */
export function useListingRequestMutations() {
  return {
    acceptCorrections: useMutation(api.broker.listingRequests.acceptCorrections),
    acceptRemoval: useMutation(api.broker.listingRequests.acceptRemoval),
    liftSuppression: useMutation(api.broker.suppressions.lift),
  }
}

/** Recomputes the overview's directory coverage on the server now. */
export function useRefreshCoverage() {
  return useMutation(api.broker.overview.refreshCoverage)
}

/** The readable part of a thrown Convex error: a `ConvexError`'s message as
 * data, else the "Uncaught Error: …" line (dev). */
export function errorMessage(error: unknown): string {
  if (error instanceof ConvexError && typeof error.data === "string") return error.data
  const text = error instanceof Error ? error.message : String(error)
  const match = /Uncaught Error: ([^\n]+)/.exec(text)
  return (match ? match[1] : text).trim() || "Something went wrong"
}

/** Awaits a mutation, confirming success or showing the error as a toast. */
export async function runWithToast<T>(work: Promise<T>, success?: string): Promise<T | undefined> {
  try {
    const result = await work
    if (success) toast.success(success)
    return result
  } catch (error) {
    toast.error(errorMessage(error))
    return undefined
  }
}
