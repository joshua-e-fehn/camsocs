import { preloadedQueryResult, preloadQuery } from "convex/nextjs"
import type { Preloaded } from "convex/react"
import {
  type FunctionArgs,
  type FunctionReference,
  type FunctionReturnType,
  getFunctionName,
  makeFunctionReference,
} from "convex/server"
import { unstable_cache } from "next/cache"
import { PHASE_PRODUCTION_BUILD } from "next/constants"
import { unstable_rethrow } from "next/navigation"
import { connection } from "next/server"
import { isPlaceholderDeployment } from "./convex-url"

/**
 * Every Convex read a public page makes on the server, anonymous and through
 * Next's Data Cache (SEO audit 2026-11-02, no-cdn-cache and
 * per-request-convex-fanout).
 *
 * Anonymous by construction: no token can be passed, so a result is the
 * public projection, the same for every viewer, and safe to share between
 * requests. What a signed-in reader may see beyond it (a `cam_only` event) is
 * added in the browser once the Convex client has the session
 * (docs/webapp.md "Caching"). The Convex client's subscriptions stay live
 * after hydration, so a cached read only seeds the first paint.
 *
 * Why this and not `fetchQuery` straight from `convex/nextjs`: that sends
 * `cache: "no-store"`, which makes any page that calls it dynamic, so no page
 * that reads Convex could be served from Vercel's edge (ISR). Inside
 * `unstable_cache` the fetch is part of a cached result instead, and a page
 * whose every read goes through here, and that reads no cookie, header or
 * search param, is static and revalidated (`revalidate` in
 * app/(site)/layout.tsx). A stray direct `fetchQuery` still works: it only
 * makes that page dynamic again.
 *
 * One cache entry per function and arguments; the deployment URL is part of
 * the key, so a preview or dev build never reuses production's entries.
 */

/**
 * Seconds an anonymous result is reused: the (site) layout's `revalidate`
 * (lib/public-data.test.ts holds them equal). A cached read's lifetime also
 * caps the lifetime of the page that made it, so a shorter one here would
 * quietly shorten every public page's. A cached page can thus be up to twice
 * this behind the database; the live client queries catch up once hydrated.
 */
export const PUBLIC_DATA_REVALIDATE = 300

const deployment = process.env.NEXT_PUBLIC_CONVEX_URL ?? "unconfigured"

type PublicQuery = FunctionReference<"query", "public">

// The function travels by name: the cache key is built from the arguments,
// and a function reference is a proxy with nothing to serialise.
const cachedPreload = unstable_cache(
  (name: string, args: Record<string, unknown>) =>
    preloadQuery(makeFunctionReference<"query">(name), args),
  ["public-query-v1", deployment],
  { revalidate: PUBLIC_DATA_REVALIDATE },
)

/**
 * A build against `scripts/build-env-defaults.sh`'s placeholder has no
 * backend and must never contact one, yet Next prerenders every page that is
 * static at build time, and a cached read would run. `connection()` marks the
 * page dynamic instead (it is then not prerendered in that build only). A
 * real build is unaffected: its static pages are prerendered from its own
 * deployment, as any ISR page is. Dynamic segments are never prerendered
 * (`generateStaticParams` returns none), with or without a backend, except
 * the category hubs, which are prerendered like a static page.
 */
async function deferWithoutBackend(): Promise<void> {
  if (isPlaceholderDeployment(process.env.NEXT_PUBLIC_CONVEX_URL)) await connection()
}

/**
 * A cached read that, while `next build` prerenders, degrades instead of
 * failing the build (review of the SEO audit 2026-11-02, build-coupling): a
 * preview build against a dev deployment that is unreachable, or behind the
 * branch's functions, would otherwise fail on the static pages (/, /about,
 * /categories, the category hubs, /term-dates). Each failed read warns,
 * naming the function, then `connection()` makes that page dynamic in that
 * build only, as `deferWithoutBackend` does for the placeholder; the page
 * renders on its first request. Outside the build the error propagates unchanged, and
 * Next's own control flow (a bail-out to dynamic, `notFound()`, a redirect)
 * is rethrown first, never mistaken for a backend failure.
 *
 * Never on Vercel Production (`VERCEL_ENV=production`; review of the SEO
 * audit 2026-11-02, build-fallback-production): its functions were pushed to
 * the production deployment just before, so a failed read there is an outage,
 * not a lagging backend, and the build fails. The last good deployment stays
 * live, instead of one whose static pages are all rendered per request.
 */
async function readCached(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    return await cachedPreload(name, args)
  } catch (error) {
    unstable_rethrow(error)
    if (
      process.env.NEXT_PHASE !== PHASE_PRODUCTION_BUILD ||
      process.env.VERCEL_ENV === "production"
    )
      throw error
    const reason = error instanceof Error ? error.message : String(error)
    console.warn(
      `public-data: ${name} failed during the build, so its page renders on request: ${reason}`,
    )
    await connection()
    // Not prerendering after all (connection() returned): nothing to defer.
    throw error
  }
}

/** A public query's result as `preloadQuery` would give it, for a client
 * organism's `usePreloadedQuery` (live after hydration). Anonymous, cached. */
export async function publicPreload<Query extends PublicQuery>(
  query: Query,
  args: FunctionArgs<Query>,
): Promise<Preloaded<Query>> {
  await deferWithoutBackend()
  return (await readCached(getFunctionName(query), args)) as Preloaded<Query>
}

/** A public query's result, as `fetchQuery` would give it. Anonymous, cached. */
export async function publicQuery<Query extends PublicQuery>(
  query: Query,
  args: FunctionArgs<Query>,
): Promise<FunctionReturnType<Query>> {
  return preloadedQueryResult(await publicPreload(query, args))
}
