import { preloadQuery } from "convex/nextjs"
import type { FunctionArgs } from "convex/server"
import { unstable_cache } from "next/cache"
import { api } from "@/convex/_generated/api"

// Only anonymous public projections enter the shared Data Cache. Signed-in
// requests always fetch directly; tokens and personalized results are never
// stored here. The client Convex subscriptions continue to update live.
// Include the deployment in keys so preview/dev cannot reuse production data.
const deployment = process.env.NEXT_PUBLIC_CONVEX_URL ?? "unconfigured"
const options = { revalidate: 60 }

const publicEvents = unstable_cache(
  (args: FunctionArgs<typeof api.events.list>) => preloadQuery(api.events.list, args),
  ["public-events-v1", deployment],
  options,
)
const publicRestrictedCount = unstable_cache(
  (args: FunctionArgs<typeof api.events.restrictedCount>) =>
    preloadQuery(api.events.restrictedCount, args),
  ["public-restricted-count-v1", deployment],
  options,
)
export const preloadPublicColleges = unstable_cache(
  () => preloadQuery(api.orgs.colleges, {}),
  ["public-colleges-v1", deployment],
  options,
)

export function preloadEvents(args: FunctionArgs<typeof api.events.list>, token?: string) {
  return token ? preloadQuery(api.events.list, args, { token }) : publicEvents(args)
}

export function preloadRestrictedCount(
  args: FunctionArgs<typeof api.events.restrictedCount>,
  token?: string,
) {
  return token
    ? preloadQuery(api.events.restrictedCount, args, { token })
    : publicRestrictedCount(args)
}
