import { v } from "convex/values"
import { LISTING_REQUEST_KINDS } from "../lib/vocab"
import { internalAction } from "./_generated/server"
import { posthogConfig, sendCapture } from "./lib/posthog"
import { literalUnion } from "./lib/validators"

/**
 * Aggregate server-side counts sent to PostHog (ENG-7; record of processing
 * P12, legitimate interests: nothing is read from or stored on a visitor's
 * device). Mutations cannot `fetch`, so a mutation schedules one of these
 * actions (`ctx.scheduler.runAfter(0, …)`), which then runs only if the
 * mutation commits. The sending rules live in `lib/posthog.ts`.
 */

/**
 * `listing_request_received { kind }`, scheduled by `listingRequests.submit`
 * once a request is accepted and stored. The kind and nothing else: never
 * the submitter's address, role, message, proposed fields or the listing.
 * A no-op without `POSTHOG_KEY` / `POSTHOG_HOST`; never throws.
 */
export const captureListingRequest = internalAction({
  args: { kind: literalUnion(LISTING_REQUEST_KINDS) },
  returns: v.null(),
  handler: async (_ctx, { kind }) => {
    const config = posthogConfig()
    if (config) await sendCapture(config, "listing_request_received", { kind })
    return null
  },
})
