/**
 * The `/relay/*` hop to PostHog's EU Cloud (ENG-4): the browser analytics
 * client (lib/analytics-client.ts, `api_host: RELAY_PATH`) sends to our own
 * origin, and `app/relay/[...path]/route.ts` forwards here.
 *
 * ## Why a route handler and not PostHog's `next.config` rewrites
 *
 * PostHog's Next.js recipe (research-js §2) is three rewrites. A rewrite
 * forwards every request header as it came, and Next has no hook to filter
 * them (the same gap that ruled out an `/api/auth` rewrite, next.config.ts).
 * On camsocs.uk that hands PostHog the visitor's cookies with every analytics
 * request: for a signed-in visitor Better Auth's session token (a live
 * credential) and its `convex_jwt` (name and email in readable base64), and
 * for everyone PostHog's own `ph_*` cookie. None of that passes through
 * `before_send`, and the privacy notice promises PostHog never gets anything
 * that links its records to an account.
 *
 * So the hop is ours and forwards by allow-list, both ways:
 *
 *  - To PostHog: the method, the path after `/relay`, the query string, the
 *    body as bytes, and only `FORWARDED_REQUEST_HEADERS`. No cookie, no
 *    authorization, no user agent (the SDK sends browser and OS names in the
 *    event; the full string never leaves, hard rule 2), no `x-forwarded-for`
 *    or other client address: PostHog sees our server, not the visitor (the
 *    project discards IP data anyway, and GeoIP is off).
 *  - Back to the browser: the status, the body and only
 *    `FORWARDED_RESPONSE_HEADERS`. PostHog sets no cookie on our origin.
 *
 * The cost is a function invocation per analytics request, which only a
 * consented visitor's browser makes. Hosts are fixed: the path can choose an
 * endpoint on PostHog's hosts, never another host.
 */

/** Our reverse-proxy path for PostHog; lib/analytics-client.ts `RELAY_PATH`
 * and robots.ts name it too (a test keeps them equal). */
export const RELAY_PREFIX = "/relay"

/** PostHog EU Cloud: ingestion, and the static assets (`/static/*`,
 * `/array/*`), which come from a separate host. */
export const POSTHOG_INGEST_HOST = "https://eu.i.posthog.com"
export const POSTHOG_ASSETS_HOST = "https://eu-assets.i.posthog.com"

/** The only request headers PostHog receives: what it needs to read the body. */
export const FORWARDED_REQUEST_HEADERS = ["content-type", "content-encoding", "accept"] as const

/** The only response headers passed back. `content-encoding` and
 * `content-length` are not among them: `fetch` has already decoded the body. */
export const FORWARDED_RESPONSE_HEADERS = ["content-type", "cache-control"] as const

/** The PostHog URL for a request that arrived at `requestUrl`, or null when it
 * is not under `/relay/`. Query string kept, trailing slash kept (`/e/`). */
export function relayTarget(requestUrl: URL): URL | null {
  const { pathname, search } = requestUrl
  if (!pathname.startsWith(`${RELAY_PREFIX}/`)) return null
  // Starts with "/", so it can only ever be a path on the fixed host.
  const rest = pathname.slice(RELAY_PREFIX.length)
  const host = /^\/(static|array)\//.test(rest) ? POSTHOG_ASSETS_HOST : POSTHOG_INGEST_HOST
  return new URL(`${host}${rest}${search}`)
}

/** `incoming` reduced to `allowed`. */
function pickHeaders(incoming: Headers, allowed: readonly string[]): Headers {
  const headers = new Headers()
  for (const name of allowed) {
    const value = incoming.get(name)
    if (value !== null) headers.set(name, value)
  }
  return headers
}

/** The headers PostHog receives for a browser request with `incoming`. */
export function relayRequestHeaders(incoming: Headers): Headers {
  return pickHeaders(incoming, FORWARDED_REQUEST_HEADERS)
}

/** The headers the browser receives for PostHog's answer with `upstream`. */
export function relayResponseHeaders(upstream: Headers): Headers {
  return pickHeaders(upstream, FORWARDED_RESPONSE_HEADERS)
}

/**
 * Forwards one `/relay/*` request. `redirect: "manual"`: a PostHog redirect is
 * passed back as it is rather than followed from our server. Unreachable
 * PostHog is a bare 502; the SDK retries or drops the batch.
 */
export async function relay(request: Request, send: typeof fetch = fetch): Promise<Response> {
  const target = relayTarget(new URL(request.url))
  if (!target) return new Response(null, { status: 404 })

  const init: RequestInit = {
    method: request.method,
    headers: relayRequestHeaders(request.headers),
    redirect: "manual",
    cache: "no-store",
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    const body = await request.arrayBuffer()
    if (body.byteLength > 0) init.body = body
  }

  let upstream: Response
  try {
    upstream = await send(target, init)
  } catch {
    return new Response(null, { status: 502 })
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: relayResponseHeaders(upstream.headers),
  })
}

/** The `{ GET, POST }` a Next route module exports; `send` is for tests
 * (unset, the global `fetch` is looked up on each request). */
export function relayRouteHandlers(send?: typeof fetch): {
  GET: (request: Request) => Promise<Response>
  POST: (request: Request) => Promise<Response>
} {
  return {
    GET: (request: Request) => relay(request, send),
    POST: (request: Request) => relay(request, send),
  }
}
