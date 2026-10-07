import { describe, expect, test } from "bun:test"
import { convexBetterAuthNextJs } from "@convex-dev/better-auth/nextjs"
import {
  CONVEX_INGRESS_UNSAFE_HEADERS,
  convexAuthForwardHeaders,
  convexAuthRouteHandlers,
  stripConvexIngressUnsafeHeaders,
} from "./auth-forwarded-headers"

/**
 * The proxy hop that serves `/api/auth/*` from the Vercel origin.
 *
 * Ported from Bundestracker, where it was written against an observed production
 * failure: every same-origin auth route returned 404 while the identical route
 * on the deployment's own `.convex.site` host returned 200. The cause is a
 * header, not a route and not an environment variable — see
 * lib/auth-forwarded-headers.ts. `camsocs.example` stands in for the public
 * origin (a reserved name, never resolved).
 *
 * The offline group is the regression proper. The live group reaches the real
 * deployment and is opt-in, because a test that silently depends on the network
 * fails for the wrong reason when the network is what broke.
 */

const SITE = process.env.NEXT_PUBLIC_CONVEX_SITE_URL ?? "https://placeholder-test-000.convex.site"
const PUBLIC_ORIGIN = "https://camsocs.example"

/** What Vercel hands the route handler for a same-origin auth request. */
function incomingRequest(path = "/api/auth/ok", init: RequestInit = {}): Request {
  return new Request(`${PUBLIC_ORIGIN}${path}`, {
    headers: { accept: "*/*", "user-agent": "regression-test" },
    ...init,
  })
}

describe("convexAuthForwardHeaders", () => {
  const forward = (incoming: Headers = new Headers()) =>
    convexAuthForwardHeaders(incoming, new URL(`${PUBLIC_ORIGIN}/api/auth/ok`), SITE)

  test("does not send the header Convex's edge router rejects", () => {
    // The whole bug in one assertion. With `x-forwarded-host: camsocs.example`
    // on the wire, every route on the deployment 404s at ingress — including
    // /api/pipeline/health, which is not a Better Auth route at all.
    expect(forward().get("x-forwarded-host")).toBeNull()
    expect(forward().get("x-forwarded-proto")).toBeNull()
  })

  test("strips an inbound x-forwarded-* pair rather than passing it through", () => {
    // Vercel's own proxy may set these before the handler ever runs, naming the
    // public origin exactly as the library would. Not setting them is not
    // enough; they have to be removed.
    const incoming = new Headers({
      "x-forwarded-host": "camsocs.example",
      "x-forwarded-proto": "https",
    })
    expect(forward(incoming).get("x-forwarded-host")).toBeNull()
    expect(forward(incoming).get("x-forwarded-proto")).toBeNull()
  })

  test("carries the public origin on the x-better-auth-* pair", () => {
    // `restoreOriginalForwardedHeaders` (dist/client/create-client.js:5-19)
    // re-derives x-forwarded-* from these *inside* Convex, past the edge
    // router. Dropping them too would fix the 404 by making Better Auth forget
    // which origin it serves — sign-in would mint callbacks for the wrong host.
    expect(forward().get("x-better-auth-forwarded-host")).toBe("camsocs.example")
    expect(forward().get("x-better-auth-forwarded-proto")).toBe("https")
  })

  test("addresses the request to the Convex deployment", () => {
    expect(forward().get("host")).toBe(new URL(SITE).host)
  })

  test("drops hop-by-hop headers", () => {
    // undici rejects an outbound `transfer-encoding: chunked`, and a stale
    // content-length contradicts the body actually sent.
    const incoming = new Headers({
      "transfer-encoding": "chunked",
      "content-length": "99",
      connection: "keep-alive",
    })
    for (const name of ["transfer-encoding", "content-length", "connection"]) {
      expect(forward(incoming).get(name)).toBeNull()
    }
  })

  test("does not touch x-forwarded-for — it names the client, not the host", () => {
    // Convex resolves deployments from the host headers only, and Better Auth
    // records this one as the session IP. Stripping it would be an unrelated
    // regression smuggled in by an adjacent-looking fix.
    const incoming = new Headers({ "x-forwarded-for": "203.0.113.7" })
    expect(forward(incoming).get("x-forwarded-for")).toBe("203.0.113.7")
  })

  test("preserves the caller's other headers", () => {
    const incoming = new Headers({ cookie: "better-auth.session=abc", accept: "*/*" })
    expect(forward(incoming).get("cookie")).toBe("better-auth.session=abc")
    expect(forward(incoming).get("accept")).toBe("*/*")
  })

  test("does not mutate the incoming headers", () => {
    const incoming = new Headers({ "x-forwarded-host": "camsocs.example" })
    forward(incoming)
    expect(incoming.get("x-forwarded-host")).toBe("camsocs.example")
  })

  test("names both halves of the unsafe pair", () => {
    // Measured: `x-forwarded-host` alone is what 404s — sending only
    // `x-forwarded-proto: https` still returns 200. The proto is stripped
    // because the library sets the two as a pair from one source, and leaving a
    // proto that names the public origin behind a host that no longer does is a
    // contradiction the next reader would have to re-derive.
    expect([...CONVEX_INGRESS_UNSAFE_HEADERS]).toEqual(["x-forwarded-host", "x-forwarded-proto"])
  })
})

describe("convexAuthRouteHandlers", () => {
  /** Captures the outbound request without touching the network. */
  function captureOutbound() {
    const calls: Request[] = []
    const fetchSpy = async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(new Request(typeof input === "string" ? input : input.toString(), init))
      return new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    return { calls, fetchSpy }
  }

  /**
   * Runs one request through the handler with `fetch` stubbed.
   *
   * The stub is installed and removed around a single await, sequentially —
   * acceptable in a test, and precisely the pattern rejected for the
   * implementation, where concurrent requests would interleave the restore.
   */
  async function runHandler(method: "GET" | "POST", request: Request) {
    const { calls, fetchSpy } = captureOutbound()
    const original = globalThis.fetch
    globalThis.fetch = fetchSpy as typeof globalThis.fetch
    try {
      const response = await convexAuthRouteHandlers(SITE)[method](request)
      return { response, outbound: calls[0] }
    } finally {
      globalThis.fetch = original
    }
  }

  test("forwards GET to the same path on the Convex site URL", async () => {
    const { outbound } = await runHandler("GET", incomingRequest("/api/auth/get-session"))
    expect(outbound.url).toBe(`${SITE}/api/auth/get-session`)
  })

  test("preserves the query string", async () => {
    const { outbound } = await runHandler(
      "GET",
      incomingRequest("/api/auth/callback/google?code=abc&state=xyz"),
    )
    expect(outbound.url).toBe(`${SITE}/api/auth/callback/google?code=abc&state=xyz`)
  })

  test("the outbound request carries no x-forwarded-host", async () => {
    const { outbound } = await runHandler("GET", incomingRequest())
    expect(outbound.headers.get("x-forwarded-host")).toBeNull()
    expect(outbound.headers.get("x-better-auth-forwarded-host")).toBe("camsocs.example")
  })

  test("forwards a POST body", async () => {
    const body = JSON.stringify({ provider: "google" })
    const { outbound } = await runHandler(
      "POST",
      incomingRequest("/api/auth/sign-in/social", {
        method: "POST",
        body,
        headers: { "content-type": "application/json" },
      }),
    )
    expect(outbound.method).toBe("POST")
    expect(await outbound.text()).toBe(body)
  })

  test("returns the upstream response", async () => {
    const { response } = await runHandler("GET", incomingRequest())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  test("does not follow the OAuth 302 — the browser must", async () => {
    // The sign-in leg answers with a redirect that belongs to the reader. If
    // this hop followed it, the provider's HTML would be returned in its place
    // and the sign-in would resolve server-side, which is the "stuck on
    // Redirecting" symptom wearing a different hat.
    const original = globalThis.fetch
    let sawInit: RequestInit | undefined
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      sawInit = init
      return new Response(null, {
        status: 302,
        headers: { location: "https://accounts.google.com/o/oauth2/v2/auth?x=1" },
      })
    }) as typeof globalThis.fetch
    try {
      const response = await convexAuthRouteHandlers(SITE).GET(
        incomingRequest("/api/auth/callback/google?code=abc"),
      )
      expect(sawInit?.redirect).toBe("manual")
      expect(response.status).toBe(302)
      expect(response.headers.get("location")).toBe(
        "https://accounts.google.com/o/oauth2/v2/auth?x=1",
      )
    } finally {
      globalThis.fetch = original
    }
  })

  test("passes Set-Cookie through — the callback leg's whole point", async () => {
    // Better Auth mints the session cookie on the callback. It reaches the
    // reader only if this hop returns the upstream response with its headers
    // intact; dropping it would sign nobody in while every status looked fine.
    const original = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(null, {
        status: 302,
        headers: {
          location: "/",
          "set-cookie": "better-auth.session_token=tok; Path=/; HttpOnly; SameSite=Lax",
        },
      })) as unknown as typeof globalThis.fetch
    try {
      const response = await convexAuthRouteHandlers(SITE).GET(
        incomingRequest("/api/auth/callback/google?code=abc"),
      )
      expect(response.headers.get("set-cookie")).toContain("better-auth.session_token=tok")
      // No `Domain`: the browser sees this as same-origin on the public host,
      // which is what makes the proxy worth having.
      expect(response.headers.get("set-cookie")).not.toContain("Domain=")
    } finally {
      globalThis.fetch = original
    }
  })

  test("sends the session cookie upstream", async () => {
    const { outbound } = await runHandler(
      "GET",
      incomingRequest("/api/auth/get-session", {
        headers: { cookie: "better-auth.session_token=tok" },
      }),
    )
    expect(outbound.headers.get("cookie")).toBe("better-auth.session_token=tok")
  })
})

/**
 * The SSR token path — the half that survived the first fix.
 *
 * `lib/auth-server.ts`'s `getToken` sanitizes Next's inbound headers with this
 * function before handing them to the library. It cannot be imported here (it
 * reads `next/headers` and validates env at module load), so the contract is
 * pinned on the shared helper both paths use.
 *
 * Measured against Bundestracker production, `GET /api/auth/convex/token` with a cookie:
 *
 *   x-forwarded-host: camsocs.example → 404 (refused at ingress)
 *   pair stripped                          → 401 {"code":"UNAUTHORIZED"}
 *
 * 401 is Better Auth rejecting a fake cookie — the auth layer answering. 404 is
 * it never being reached, which `betterFetch` reports as no `data` and the
 * library returns as `token: undefined`: indistinguishable from signed out.
 */
describe("stripConvexIngressUnsafeHeaders", () => {
  test("removes the pair Convex's edge router rejects", () => {
    const headers = new Headers({
      "x-forwarded-host": "camsocs.example",
      "x-forwarded-proto": "https",
    })
    stripConvexIngressUnsafeHeaders(headers)
    expect(headers.get("x-forwarded-host")).toBeNull()
    expect(headers.get("x-forwarded-proto")).toBeNull()
  })

  test("keeps the session cookie — the point of the token request", () => {
    // Stripping this would turn every signed-in render signed-out just as
    // surely as the 404 did, and just as silently.
    const headers = new Headers({
      cookie: "better-auth.session_token=tok",
      "x-forwarded-host": "camsocs.example",
    })
    stripConvexIngressUnsafeHeaders(headers)
    expect(headers.get("cookie")).toBe("better-auth.session_token=tok")
  })

  test("leaves x-forwarded-for intact", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.7" })
    stripConvexIngressUnsafeHeaders(headers)
    expect(headers.get("x-forwarded-for")).toBe("203.0.113.7")
  })

  test("is what the hop uses, so both paths cannot diverge", () => {
    // The first fix sanitized the hop and left the token path unsanitized.
    // Sharing one helper is what makes that class of gap impossible.
    const viaHop = convexAuthForwardHeaders(
      new Headers({ "x-forwarded-host": "camsocs.example" }),
      new URL(`${PUBLIC_ORIGIN}/api/auth/ok`),
      SITE,
    )
    expect(viaHop.get("x-forwarded-host")).toBeNull()
  })
})

/**
 * The drift guard the reimplementation is justified by.
 *
 * `auth-forwarded-headers.ts` transcribes the library's forwarding rather than
 * wrapping it, and the stated price is that a change to the library will not
 * arrive here on its own. This is the assertion that makes that price payable:
 * it invokes the *installed* handler, captures what it really sends, and diffs
 * it against ours. It runs offline, so CI enforces it.
 *
 * Previously this contract was a hand-copied literal inside the opt-in live
 * block — a copy of the library's headers could not detect the library
 * changing them.
 */
describe("library drift", () => {
  /** What the installed `convexBetterAuthNextJs` handler really sends. */
  async function librarysOutboundHeaders(): Promise<Headers> {
    const { handler } = convexBetterAuthNextJs({
      convexUrl: SITE.replace(".convex.site", ".convex.cloud"),
      convexSiteUrl: SITE,
    })
    let captured: Headers | undefined
    const original = globalThis.fetch
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      captured = new Headers(init?.headers)
      return new Response("{}", { status: 200 })
    }) as typeof globalThis.fetch
    try {
      await handler.GET(new Request(`${PUBLIC_ORIGIN}/api/auth/ok`))
    } finally {
      globalThis.fetch = original
    }
    if (!captured) throw new Error("library handler did not call fetch")
    return captured
  }

  const names = (headers: Headers) => [...headers.keys()].sort()

  test("ours is the library's header set minus exactly the unsafe pair", async () => {
    const librarys = names(await librarysOutboundHeaders())
    const ours = names(
      convexAuthForwardHeaders(new Headers(), new URL(`${PUBLIC_ORIGIN}/api/auth/ok`), SITE),
    )
    // The whole claim, as an equation. A fifth header, a renamed channel, or a
    // dropped one fails here — on the day it is installed, not in production.
    expect(ours).toEqual(
      librarys.filter((n) => !CONVEX_INGRESS_UNSAFE_HEADERS.includes(n as never)),
    )
  })

  test("the library still sends the header that caused the outage", async () => {
    // If this ever fails, the library fixed it upstream and this whole
    // reimplementation can be reconsidered — a failure worth reading, not a
    // tautology.
    const librarys = await librarysOutboundHeaders()
    expect(librarys.get("x-forwarded-host")).toBe("camsocs.example")
  })

  test("the values we do send match the library's", async () => {
    const librarys = await librarysOutboundHeaders()
    const ours = convexAuthForwardHeaders(
      new Headers(),
      new URL(`${PUBLIC_ORIGIN}/api/auth/ok`),
      SITE,
    )
    for (const name of names(ours)) {
      expect(`${name}=${ours.get(name)}`).toBe(`${name}=${librarys.get(name)}`)
    }
  })
})

/**
 * The live half — the 404-vs-200 matrix that actually failed in production.
 *
 * Opt-in via CONVEX_LIVE_AUTH_TEST=1: it depends on the deployment being up and
 * on outbound network.
 *
 *   CONVEX_LIVE_AUTH_TEST=1 bun test lib/auth-forwarded-headers.test.ts
 *
 * ⚠ State the consequence plainly: **CI does not set this**, so the only tests
 * that observe a real 404 do not run there. What CI does enforce is the
 * `library drift` block above — it needs no network and fails if our header set
 * stops matching the library's minus the unsafe pair, which is the shape the
 * outage took. The offline assertions elsewhere in this file are change
 * detectors: they pin the contract, but they cannot observe the production
 * failure, and it would be dishonest to read them as if they could.
 */
const LIVE = process.env.CONVEX_LIVE_AUTH_TEST === "1"

describe.if(LIVE)("against the live Convex deployment", () => {
  /** The exact header set the library sends — dist/nextjs/index.js:30-39. */
  function librarysHeaders() {
    return new Headers({
      accept: "*/*",
      "accept-encoding": "application/json",
      host: new URL(SITE).host,
      "x-forwarded-host": "camsocs.example",
      "x-forwarded-proto": "https",
      "x-better-auth-forwarded-host": "camsocs.example",
      "x-better-auth-forwarded-proto": "https",
    })
  }

  test("the library's header set reproduces the production 404", async () => {
    const response = await fetch(`${SITE}/api/auth/ok`, {
      headers: librarysHeaders(),
      redirect: "manual",
    })
    // The production symptom exactly: rejected at ingress, so no body and none
    // of the CORS headers a real auth response carries.
    expect(response.status).toBe(404)
    expect(response.headers.get("content-type")).toBeNull()
  }, 30_000)

  test("the same header set 404s a non-auth route too", async () => {
    // /api/pipeline/health answers 401 without a key. Getting 404 instead is
    // what proves the rejection happens at the edge, before any of our code —
    // this route has nothing to do with Better Auth.
    const response = await fetch(`${SITE}/api/pipeline/health`, {
      headers: librarysHeaders(),
      redirect: "manual",
    })
    expect(response.status).toBe(404)
  }, 30_000)

  test("our headers reach Better Auth", async () => {
    const response = await fetch(`${SITE}/api/auth/ok`, {
      headers: convexAuthForwardHeaders(
        new Headers({ accept: "*/*" }),
        new URL(`${PUBLIC_ORIGIN}/api/auth/ok`),
        SITE,
      ),
      redirect: "manual",
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  }, 30_000)

  test("the SSR token endpoint: 404 with the header, 401 without", async () => {
    // Finding 1 of the adversarial review, as an assertion. This is the path
    // `getToken` takes on every server render, and the difference between the
    // two statuses is the difference between "refused at the edge" and "Better
    // Auth answering". Both are non-2xx for a fake cookie, which is exactly why
    // the bug survived the first fix — only the status tells them apart.
    const url = `${SITE}/api/auth/convex/token`
    const cookie = "better-auth.session_token=fake-token-for-probe"

    const poisoned = await fetch(url, {
      headers: { cookie, "x-forwarded-host": "camsocs.example" },
      redirect: "manual",
    })
    expect(poisoned.status).toBe(404)

    const sanitized = await fetch(url, {
      headers: stripConvexIngressUnsafeHeaders(
        new Headers({ cookie, "x-forwarded-host": "camsocs.example" }),
      ),
      redirect: "manual",
    })
    expect(sanitized.status).toBe(401)
    expect(await sanitized.json()).toMatchObject({ code: "UNAUTHORIZED" })
  }, 30_000)

  test("get-session is answered rather than 404ing", async () => {
    const response = await fetch(`${SITE}/api/auth/get-session`, {
      headers: convexAuthForwardHeaders(
        new Headers({ accept: "*/*" }),
        new URL(`${PUBLIC_ORIGIN}/api/auth/get-session`),
        SITE,
      ),
      redirect: "manual",
    })
    // 200 null — no cookie was sent, so there is no session. The point is that
    // the auth layer answers at all.
    expect(response.status).toBe(200)
  }, 30_000)
})
