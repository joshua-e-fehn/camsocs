import { convexAuthRouteHandlers } from "@/lib/auth-forwarded-headers"
import { convexSiteUrl } from "@/lib/auth-server"

/**
 * `/api/auth/*` on this origin, proxied to Better Auth inside Convex.
 *
 * A route handler rather than a `next.config` rewrite: on Next 16 an
 * `afterFiles` rewrite matching this path would *win* over this file, and the
 * rewrite proxy sets an `x-forwarded-host` that Convex's edge router rejects
 * (Bundestracker's production outage — see next.config.ts).
 *
 * The hop is `lib/auth-forwarded-headers.ts` rather than the library's own
 * `handler`, for the same header. That file says why it reimplements the hop.
 */
export const { GET, POST } = convexAuthRouteHandlers(convexSiteUrl)
