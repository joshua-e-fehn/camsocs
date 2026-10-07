/**
 * The `/api/auth/*` proxy hop, and the header that made it 404 in production.
 *
 * Ported verbatim (code) from Bundestracker, where this fixed a production
 * outage. Kept as-is because the failure is a property of Convex's edge and of
 * `@convex-dev/better-auth`, not of that app.
 *
 * ## The bug this exists to prevent
 *
 * The library's own Next.js handler (`convexBetterAuthNextJs`, dist/nextjs/
 * index.js) forwards `/api/auth/*` to the Convex site URL with four headers
 * naming the *public* origin:
 *
 *   x-forwarded-host              <public host>
 *   x-forwarded-proto             https
 *   x-better-auth-forwarded-host  <public host>
 *   x-better-auth-forwarded-proto https
 *
 * The `x-better-auth-*` pair is the library's own channel: `registerRoutes`
 * copies it back onto `x-forwarded-*` *inside* the Convex runtime, so Better
 * Auth still learns the real origin. The `x-forwarded-*` pair on the wire is
 * the problem: Convex's edge router resolves the deployment from
 * `x-forwarded-host`, and a host that is not the deployment's own is rejected
 * at ingress with a bare 404 — before any route or app code runs. Measured on
 * Bundestracker production:
 *
 *   no header                                → 200 {"ok":true}
 *   x-forwarded-host: <deployment>.convex.site → 200
 *   x-forwarded-host: <public host>          → 404, empty body
 *
 * It is not specific to auth (the same header 404s `/api/pipeline/health`), and
 * it is not an environment-variable problem: every URL is correct, the request
 * is refused for *whose origin it claims to be*.
 *
 * ## Why this reimplements the hop instead of wrapping it
 *
 * The headers are built inside the library's closure from one source, and the
 * two pairs must disagree. Intercepting `globalThis.fetch` was tried and
 * rejected (concurrent route handlers interleave save/restore). So this
 * forwards the request itself — a transcription of the library's hop minus the
 * two headers. The `library drift` block in `lib/auth-forwarded-headers.test.ts`
 * invokes the *installed* handler offline and asserts our header set equals the
 * library's minus exactly `CONVEX_INGRESS_UNSAFE_HEADERS`, so CI catches drift.
 *
 * ⚠ The SSR token path is *not* this hop: `getToken` in `lib/auth-server.ts`
 * sanitizes its headers with `stripConvexIngressUnsafeHeaders` below. Missing
 * that path made signed-in renders silently paint signed-out.
 *
 * `x-forwarded-for` is deliberately not touched: Convex does not resolve
 * deployments from it, and Better Auth reads it to record the session IP.
 */

/**
 * The headers a proxied hop must not assert to Convex's edge router.
 *
 * `x-forwarded-host` is the causal one — measured, `x-forwarded-proto: https`
 * on its own still returns 200. The proto is stripped with it because the
 * library derives both from a single source, and a proto still naming the
 * public origin behind a host that no longer does is a contradiction rather
 * than a fix.
 */
export const CONVEX_INGRESS_UNSAFE_HEADERS = ["x-forwarded-host", "x-forwarded-proto"] as const

/**
 * Hop-by-hop headers that must not be re-sent on a new request.
 *
 * Kept from the library's own list (dist/nextjs/index.js:31-33): undici rejects
 * an outbound `transfer-encoding: chunked`, and a stale `content-length`
 * contradicts the body actually being sent.
 */
const HOP_BY_HOP_HEADERS = ["transfer-encoding", "content-length", "connection"] as const

/**
 * Removes the headers Convex's edge router rejects, in place.
 *
 * Shared by both paths that leave this app for the deployment — the
 * `/api/auth/*` hop below and the SSR token fetch in `lib/auth-server.ts`.
 * One definition of "unsafe", so a fix to one is a fix to both: the first
 * version of this fix sanitized only the hop, and the token path kept 404ing
 * silently on every server render.
 */
export function stripConvexIngressUnsafeHeaders(headers: Headers): Headers {
  for (const name of CONVEX_INGRESS_UNSAFE_HEADERS) {
    headers.delete(name)
  }
  return headers
}

/**
 * The headers to send to Convex for a request that arrived at `requestUrl`.
 *
 * Exported for the test, which asserts both halves of the contract: the
 * ingress-hostile pair is absent, and the `x-better-auth-*` pair carrying the
 * real public origin is present.
 */
export function convexAuthForwardHeaders(
  incoming: Headers,
  requestUrl: URL,
  siteUrl: string,
): Headers {
  const headers = new Headers(incoming)

  for (const name of HOP_BY_HOP_HEADERS) {
    headers.delete(name)
  }
  // Deleted rather than never-set: the inbound request may carry its own pair
  // from Vercel's proxy, naming the public origin exactly as the library would.
  stripConvexIngressUnsafeHeaders(headers)

  // ⚠ `application/json` is a MIME type in a content-coding slot, so it
  // negotiates no compression at all. Transcribed verbatim from the library
  // (dist/nextjs/index.js:34) and deliberately left wrong: this hop's job is to
  // match the library's behaviour minus two headers, and quietly "fixing" an
  // unrelated field here would be a second, untested change riding along.
  headers.set("accept-encoding", "application/json")
  headers.set("host", new URL(siteUrl).host)
  // The library's own channel for the public origin, restored onto
  // `x-forwarded-*` inside the Convex runtime, past the edge router.
  //
  // ⚠ `requestUrl.host` traces back to a client-supplied `Host` on Vercel, so
  // this value is influenceable, and it becomes what Better Auth believes its
  // own origin is — feeding `trustedOrigins` and the OAuth `redirect_uri`. The
  // check that makes that safe is not here and cannot be: `trustedOrigins` is
  // `[process.env.SITE_URL]`, evaluated inside Convex (convex/betterAuth/
  // auth.ts), so a forged origin is rejected there rather than trusted here.
  // `set` rather than `append` so an inbound forgery is overwritten, not added
  // to. This is the library's own derivation (dist/nextjs/index.js:37-38);
  // it is noted because the fix moved it into first-party code.
  headers.set("x-better-auth-forwarded-host", requestUrl.host)
  headers.set("x-better-auth-forwarded-proto", requestUrl.protocol.replace(/:$/, ""))

  return headers
}

/**
 * Proxies one `/api/auth/*` request to Better Auth inside Convex.
 *
 * `redirect: "manual"` because the OAuth flow answers with 302s that belong to
 * the browser, not to this hop — following them here would resolve the sign-in
 * redirect server-side and return the provider's page instead of sending the
 * reader to it.
 */
async function proxyToConvexAuth(request: Request, siteUrl: string): Promise<Response> {
  const requestUrl = new URL(request.url)
  const target = `${siteUrl}${requestUrl.pathname}${requestUrl.search}`

  const init: RequestInit = {
    method: request.method,
    headers: convexAuthForwardHeaders(request.headers, requestUrl, siteUrl),
    redirect: "manual",
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    const body = await request.arrayBuffer()
    if (body.byteLength > 0) {
      init.body = body
    }
  }

  return fetch(target, init)
}

/** The `{ GET, POST }` shape a Next route module exports. */
export type RouteHandlers = {
  GET: (request: Request) => Promise<Response>
  POST: (request: Request) => Promise<Response>
}

/**
 * The route handlers for `/api/auth/*`, bound to a Convex site URL.
 *
 * Takes the URL as an argument rather than reading the environment, so the test
 * can exercise the hop without one — `lib/auth-server.ts` is where the value is
 * validated, once, for the whole build.
 */
export function convexAuthRouteHandlers(siteUrl: string): RouteHandlers {
  return {
    GET: (request: Request) => proxyToConvexAuth(request, siteUrl),
    POST: (request: Request) => proxyToConvexAuth(request, siteUrl),
  }
}
