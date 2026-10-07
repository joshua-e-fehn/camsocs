import { convexBetterAuthNextJs } from "@convex-dev/better-auth/nextjs"
import { getToken as libraryGetToken } from "@convex-dev/better-auth/utils"
import { headers as nextHeaders } from "next/headers"
import { cache } from "react"
import { stripConvexIngressUnsafeHeaders } from "@/lib/auth-forwarded-headers"
import { requireConvexUrls } from "@/lib/convex-url"

/**
 * Server-side auth helpers, bound to this deployment. Ported from Bundestracker.
 *
 * This module is imported during `next build`'s page-data collection, so the
 * URL check runs at build time: a misconfigured deploy fails before it can
 * serve. `scripts/build-env-defaults.sh` supplies a placeholder pair for a
 * build that is going nowhere (CI, a clean checkout).
 */
// Named one at a time rather than passing `process.env`: Next inlines
// `NEXT_PUBLIC_*` by matching the literal member expression in the source.
const { cloudUrl, siteUrl } = requireConvexUrls({
  NEXT_PUBLIC_CONVEX_URL: process.env.NEXT_PUBLIC_CONVEX_URL,
  NEXT_PUBLIC_CONVEX_SITE_URL: process.env.NEXT_PUBLIC_CONVEX_SITE_URL,
})

/**
 * The Convex site URL this build proxies auth to, validated above. Exported so
 * `app/api/auth/[...all]/route.ts` binds its hop to the same checked value.
 */
export const convexSiteUrl = siteUrl

// `handler` and `getToken` are deliberately not re-exported from the library:
// both send an `x-forwarded-host` naming the public origin, which Convex's edge
// router rejects at ingress (see lib/auth-forwarded-headers.ts). `getToken` is
// replaced below.
//
// ⚠ The five re-exported here reach that same unsanitized path internally, via
// the library's `cachedGetToken`. None is used today. Wiring one onto a page
// would silently render signed-in users as signed out in production while
// passing every gate locally — pass the sanitized `getToken()` below to
// `fetchQuery`/`preloadQuery` instead.
export const {
  preloadAuthQuery,
  isAuthenticated,
  fetchAuthQuery,
  fetchAuthMutation,
  fetchAuthAction,
} = convexBetterAuthNextJs({
  convexUrl: cloudUrl,
  convexSiteUrl: siteUrl,
})

/**
 * The Convex JWT for the current request, or `undefined` when signed out.
 *
 * Wraps the library's exported `getToken(siteUrl, headers)` with sanitized
 * headers. The library's own Next.js variant forwards Vercel's inbound
 * `x-forwarded-host`, which Convex's edge answers with a 404 that `betterFetch`
 * reports as "no data" — indistinguishable from a signed-out reader.
 *
 * Memoised per request (`React.cache`): the root layout and the page that
 * preloads viewer-dependent queries both ask, and each ask is an HTTP round
 * trip to the Convex site.
 */
export const getToken = cache(async (): Promise<string | undefined> => {
  const inbound = new Headers(await nextHeaders())
  // Mirrors the library's own hop-by-hop handling.
  inbound.delete("content-length")
  inbound.delete("transfer-encoding")
  inbound.set("accept-encoding", "identity")

  const { token } = await libraryGetToken(siteUrl, stripConvexIngressUnsafeHeaders(inbound))
  return token
})
