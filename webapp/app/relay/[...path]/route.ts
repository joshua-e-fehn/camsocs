import { relayRouteHandlers } from "@/lib/relay"

/**
 * `/relay/*` on this origin, forwarded to PostHog's EU Cloud for the browser
 * analytics client (ENG-4).
 *
 * A route handler rather than PostHog's `next.config` rewrites: a rewrite
 * would pass the visitor's cookies (Better Auth's session among them) on to
 * PostHog, and cannot filter headers. `lib/relay.ts` forwards by allow-list
 * and says why.
 */
export const { GET, POST } = relayRouteHandlers()
