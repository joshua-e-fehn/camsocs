import { describe, expect, test } from "bun:test"
import { RELAY_PATH } from "./analytics-client"
import {
  FORWARDED_REQUEST_HEADERS,
  POSTHOG_ASSETS_HOST,
  POSTHOG_INGEST_HOST,
  RELAY_PREFIX,
  relayRouteHandlers,
  relayTarget,
} from "./relay"

/**
 * The `/relay/*` hop to PostHog (ENG-4, lib/relay.ts): PostHog gets the
 * analytics request and nothing of the visitor's — no cookie (Better Auth's
 * session and `convex_jwt`, PostHog's own `ph_*`), no authorization, no user
 * agent, no client address — and the browser gets PostHog's answer without
 * any cookie of PostHog's. `fetch` is replaced by a recorder, so nothing is
 * sent. `camsocs.example` stands in for the public origin.
 */

const ORIGIN = "https://camsocs.example"

type Sent = { url: string; init: RequestInit }

/** A fake upstream that records what it was sent and answers `answer`. */
function upstream(answer: () => Response = () => Response.json({ status: 1 })) {
  const sent: Sent[] = []
  const send = (async (url: URL | string, init: RequestInit = {}) => {
    sent.push({ url: String(url), init })
    return answer()
  }) as typeof fetch
  return { sent, handlers: relayRouteHandlers(send) }
}

/** What a consented, signed-in visitor's browser sends to `/relay/e/`. */
function browserRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    body: "compressed-batch",
    ...init,
    headers: {
      "content-type": "text/plain",
      cookie:
        "better-auth.session_token=SECRET-SESSION; better-auth.convex_jwt=eyJ.SECRET.JWT; ph_phc_x_posthog=%7B%22%24initial_person_info%22%3A%7B%22u%22%3A%22https%3A%2F%2Fcamsocs.example%2F%3Fq%3Dme%22%7D%7D",
      authorization: "Bearer SECRET",
      "user-agent": "Mozilla/5.0 (Macintosh) full identification string",
      "x-forwarded-for": "203.0.113.7",
      "x-real-ip": "203.0.113.7",
      "x-forwarded-host": "camsocs.example",
      referer: `${ORIGIN}/dashboard?x=1`,
      origin: ORIGIN,
      "accept-language": "en-GB",
      ...(init.headers as Record<string, string> | undefined),
    },
  })
}

describe("relayTarget", () => {
  const target = (path: string) => relayTarget(new URL(`${ORIGIN}${path}`))?.toString()

  test("is the path our client and robots.txt use", () => {
    expect(RELAY_PREFIX).toBe(RELAY_PATH)
  })

  test("maps ingestion to eu.i and assets to eu-assets, keeping slash and query", () => {
    expect(target("/relay/e/?ip=0&_=1&ver=1.444.0&compression=gzip-js")).toBe(
      `${POSTHOG_INGEST_HOST}/e/?ip=0&_=1&ver=1.444.0&compression=gzip-js`,
    )
    expect(target("/relay/i/v0/e/")).toBe(`${POSTHOG_INGEST_HOST}/i/v0/e/`)
    expect(target("/relay/static/array.js")).toBe(`${POSTHOG_ASSETS_HOST}/static/array.js`)
    expect(target("/relay/array/phc_x/config.js")).toBe(
      `${POSTHOG_ASSETS_HOST}/array/phc_x/config.js`,
    )
  })

  test("never leaves PostHog's hosts, and only serves /relay/", () => {
    for (const path of ["/relay//evil.example/x", "/relay/@evil.example/", "/relay/..%2f..%2fx"]) {
      expect(new URL(target(path) ?? "").origin).toBe(POSTHOG_INGEST_HOST)
    }
    // Dot segments resolve before routing: this is `/x`, not the relay.
    expect(target("/relay/../x")).toBeUndefined()
    expect(target("/relay")).toBeUndefined()
    expect(target("/relayed/e/")).toBeUndefined()
    expect(target("/about")).toBeUndefined()
  })
})

describe("the relay", () => {
  test("sends PostHog the body and content headers, and nothing of the visitor's", async () => {
    const { sent, handlers } = upstream()
    const response = await handlers.POST(browserRequest("/relay/e/?compression=gzip-js"))
    expect(response.status).toBe(200)
    expect(sent).toHaveLength(1)
    const [{ url, init }] = sent as [Sent]
    expect(url).toBe(`${POSTHOG_INGEST_HOST}/e/?compression=gzip-js`)
    expect(init.method).toBe("POST")
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe("compressed-batch")
    const headers = new Headers(init.headers)
    expect([...headers.keys()].sort()).toEqual(["content-type"])
    expect(headers.get("content-type")).toBe("text/plain")
    for (const name of [
      "cookie",
      "authorization",
      "user-agent",
      "x-forwarded-for",
      "x-real-ip",
      "x-forwarded-host",
      "referer",
      "origin",
      "accept-language",
    ]) {
      expect(headers.has(name)).toBe(false)
    }
    // Nothing of the secrets in any header value either.
    expect(JSON.stringify([...headers])).not.toMatch(/SECRET|203\.0\.113|initial_person_info/)
  })

  test("forwards exactly the allow-listed request headers", async () => {
    expect([...FORWARDED_REQUEST_HEADERS].sort()).toEqual([
      "accept",
      "content-encoding",
      "content-type",
    ])
    const { sent, handlers } = upstream()
    await handlers.POST(
      browserRequest("/relay/e/", { headers: { "content-encoding": "gzip", accept: "*/*" } }),
    )
    const headers = new Headers(sent[0]?.init.headers)
    expect(headers.get("content-encoding")).toBe("gzip")
    expect(headers.get("accept")).toBe("*/*")
  })

  test("a GET carries no body and reaches the assets host", async () => {
    const { sent, handlers } = upstream(
      () =>
        new Response("js", {
          headers: {
            "content-type": "application/javascript",
            "cache-control": "public, max-age=3600",
          },
        }),
    )
    const response = await handlers.GET(
      browserRequest("/relay/static/array.js", { method: "GET", body: null }),
    )
    expect(sent[0]?.url).toBe(`${POSTHOG_ASSETS_HOST}/static/array.js`)
    expect(sent[0]?.init.body).toBeUndefined()
    expect(sent[0]?.init.redirect).toBe("manual")
    expect(await response.text()).toBe("js")
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600")
  })

  test("passes PostHog's status and body back without its cookies", async () => {
    const { handlers } = upstream(
      () =>
        new Response('{"status":0}', {
          status: 400,
          headers: {
            "content-type": "application/json",
            "set-cookie": "ph_tracker=1; Domain=camsocs.example",
            "content-encoding": "gzip",
            "access-control-allow-credentials": "true",
          },
        }),
    )
    const response = await handlers.POST(browserRequest("/relay/e/"))
    expect(response.status).toBe(400)
    expect(await response.text()).toBe('{"status":0}')
    expect([...response.headers.keys()]).toEqual(["content-type"])
  })

  test("unreachable PostHog is a bare 502; a path outside /relay/ a 404", async () => {
    const failing = relayRouteHandlers((async () => {
      throw new TypeError("fetch failed")
    }) as unknown as typeof fetch)
    expect((await failing.POST(browserRequest("/relay/e/"))).status).toBe(502)
    const { sent, handlers } = upstream()
    expect(
      (await handlers.GET(browserRequest("/relay", { method: "GET", body: null }))).status,
    ).toBe(404)
    expect(sent).toHaveLength(0)
  })
})
