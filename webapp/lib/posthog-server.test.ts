import { afterEach, describe, expect, test } from "bun:test"
import type { PostHogOptions } from "posthog-node"
import {
  captureServerEvent,
  captureServerException,
  createPostHogServer,
  errorContextProperties,
  requestErrorContext,
  SERVER_DISTINCT_ID,
  sanitizeServerEvent,
  serverEnvironment,
  serverEventProperties,
  setPostHogServerForTests,
} from "./posthog-server"

/**
 * The server's PostHog sender (ENG-6; spec "Errors", law report §7): no key,
 * no client and no request; with a key, an error report carries the route
 * path without its query string, the method, Next's router facts, the
 * environment and the scrubbed exception, under the fixed distinct id and
 * without a person profile, and never a header, cookie, body, IP or user
 * agent.
 *
 * The real posthog-node client runs against a recording `fetch`, so the
 * assertions are on the bytes that would leave the server.
 */

const KEY = "phc_test_not_a_real_key"

type Sent = { url: string; body: Record<string, unknown> }

/** A client whose requests are recorded instead of sent. */
function recordingClient(env: Record<string, string> = { NEXT_PUBLIC_POSTHOG_KEY: KEY }) {
  const sent: Sent[] = []
  const fetch: PostHogOptions["fetch"] = async (url, options) => {
    sent.push({ url, body: JSON.parse(String(options.body)) })
    return { status: 200, text: async () => "{}", json: async () => ({}) }
  }
  const client = createPostHogServer(env, { fetch, disableCompression: true })
  setPostHogServerForTests(client)
  return { client, sent }
}

/** Every event in the recorded requests. */
function events(sent: Sent[]): Record<string, unknown>[] {
  return sent.flatMap(({ body }) => (body.batch as Record<string, unknown>[]) ?? [])
}

/** What `onRequestError` receives for a failed page render. */
function nextRequestError() {
  const request = {
    path: "/talks/talk-123?q=jane+doe&utm_source=x#frag",
    method: "GET",
    headers: {
      cookie: "better-auth.session_token=secret; ph_phc_x_posthog=%7B%7D",
      "user-agent": "Mozilla/5.0 (Macintosh) Secret/1.0",
      "x-forwarded-for": "203.0.113.7",
      authorization: "Bearer secret",
      referer: "https://camsocs.uk/search?q=private",
    },
  }
  const context = {
    routerKind: "App Router" as const,
    routePath: "/talks/[key]",
    routeType: "render" as const,
    renderSource: "react-server-components" as const,
    revalidateReason: undefined,
  }
  return { request, context }
}

afterEach(() => setPostHogServerForTests(undefined))

describe("without a key", () => {
  test("there is no client, and every call is a quiet no-op", async () => {
    expect(createPostHogServer({})).toBeNull()
    expect(createPostHogServer({ NEXT_PUBLIC_POSTHOG_KEY: "  " })).toBeNull()
    setPostHogServerForTests(null)
    await expect(captureServerException(new Error("boom"), { path: "/" })).resolves.toBeUndefined()
    await expect(captureServerEvent("anything", { a: 1 })).resolves.toBeUndefined()
  })
})

describe("serverEnvironment", () => {
  test("is production only on Vercel's production deployment", () => {
    expect(serverEnvironment({ VERCEL_ENV: "production" })).toBe("production")
    expect(serverEnvironment({ VERCEL_ENV: "preview" })).toBe("development")
    expect(serverEnvironment({})).toBe("development")
  })
})

describe("an onRequestError report", () => {
  test("keeps only the allow-listed request facts", () => {
    const { request, context } = nextRequestError()
    expect(errorContextProperties(requestErrorContext(request, context), {})).toEqual({
      environment: "development",
      $pathname: "/talks/talk-123",
      $http_method: "GET",
      nextjs_router_kind: "App Router",
      nextjs_route_path: "/talks/[key]",
      nextjs_route_type: "render",
      nextjs_render_source: "react-server-components",
    })
  })

  test("sends the scrubbed exception and nothing from the request", async () => {
    const { sent } = recordingClient()
    const { request, context } = nextRequestError()
    const error = new TypeError("No talk for jane@cam.ac.uk at https://camsocs.uk/talks?q=jane")
    await captureServerException(error, requestErrorContext(request, context))

    expect(sent).toHaveLength(1)
    expect(sent[0]?.url).toBe("https://eu.i.posthog.com/batch/")
    const [event] = events(sent)
    expect(event?.event).toBe("$exception")
    expect(event?.distinct_id).toBe(SERVER_DISTINCT_ID)
    const props = event?.properties as Record<string, unknown>
    expect(Object.keys(props).sort()).toEqual(
      [
        // `$exception_level`, `$lib`, `$lib_version` and `$is_server` are the SDK's own.
        "$exception_level",
        "$exception_list",
        "$geoip_disable",
        "$http_method",
        "$is_server",
        "$lib",
        "$lib_version",
        "$pathname",
        "$process_person_profile",
        "environment",
        "nextjs_render_source",
        "nextjs_route_path",
        "nextjs_route_type",
        "nextjs_router_kind",
      ].sort(),
    )
    expect(props.$pathname).toBe("/talks/talk-123")
    expect(props.$process_person_profile).toBe(false)
    expect(props.$geoip_disable).toBe(true)
    const [exception] = props.$exception_list as Record<string, unknown>[]
    expect(exception?.type).toBe("TypeError")
    expect(exception?.value).toBe("No talk for [email] at https://camsocs.uk/talks")

    // Nothing from the headers, the query string or the message's secrets.
    const wire = JSON.stringify(sent[0]?.body)
    for (const secret of [
      "secret",
      "Mozilla",
      "203.0.113.7",
      "jane",
      "utm_source",
      "frag",
      "private",
      "ph_phc",
    ]) {
      expect(wire).not.toContain(secret)
    }
    // No source lines from the server's files.
    expect(wire).not.toContain("context_line")
  })

  test("a broker-area or sign-in error is not reported", async () => {
    const { sent } = recordingClient()
    await captureServerException(new Error("Jane Doe is already listed"), {
      path: "/dashboard/people?x=1",
    })
    await captureServerException(new Error("x"), { path: "/sign-in/verify" })
    expect(sent).toHaveLength(0)
  })

  test("onRequestError returns at once and still sends in the background", async () => {
    const { sent } = recordingClient()
    const previous = process.env.NEXT_RUNTIME
    process.env.NEXT_RUNTIME = "nodejs"
    try {
      const { onRequestError } = await import("../instrumentation")
      const { request, context } = nextRequestError()
      await onRequestError(new Error("render failed"), request, context)
      for (let i = 0; i < 50 && sent.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(events(sent).map((event) => event.event)).toEqual(["$exception"])
    } finally {
      process.env.NEXT_RUNTIME = previous
    }
  })

  test("outside the Node.js runtime it does nothing", async () => {
    const { sent } = recordingClient()
    const previous = process.env.NEXT_RUNTIME
    process.env.NEXT_RUNTIME = "edge"
    try {
      const { onRequestError } = await import("../instrumentation")
      const { request, context } = nextRequestError()
      await onRequestError(new Error("x"), request, context)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(sent).toHaveLength(0)
    } finally {
      process.env.NEXT_RUNTIME = previous
    }
  })

  test("a PostHog failure never reaches the caller", async () => {
    const fetch: PostHogOptions["fetch"] = async () => {
      throw new Error("network down")
    }
    setPostHogServerForTests(createPostHogServer({ NEXT_PUBLIC_POSTHOG_KEY: KEY }, { fetch }))
    await expect(captureServerException(new Error("x"), { path: "/" })).resolves.toBeUndefined()
  })
})

describe("server events (for ENG-7)", () => {
  const allowList = { ics_feed_fetched: ["feed", "key"] }

  test("keep only allow-listed primitive properties", () => {
    expect(
      serverEventProperties(
        "ics_feed_fetched",
        { feed: "talk", key: "talk-1?x=1", ip: "203.0.113.7", n: Number.NaN },
        allowList,
        { VERCEL_ENV: "production" },
      ),
    ).toEqual({ environment: "production", feed: "talk", key: "talk-1" })
  })

  test("an event without an allow-list entry, or an SDK name, is never sent", () => {
    expect(serverEventProperties("page_viewed", {}, allowList)).toBeNull()
    expect(serverEventProperties("$pageview", {}, { $pageview: [] })).toBeNull()
    expect(serverEventProperties("toString", {}, allowList)).toBeNull()
  })

  test("captureServerEvent sends nothing for an unlisted event", async () => {
    const { sent } = recordingClient()
    await captureServerEvent("ics_feed_fetched", { feed: "talks" })
    expect(sent).toHaveLength(0)
  })
})

describe("before_send", () => {
  test("pins the distinct id and drops unlisted properties and events", () => {
    const out = sanitizeServerEvent(
      {
        distinctId: "someone",
        event: "ics_feed_fetched",
        properties: {
          feed: "talks",
          $ip: "203.0.113.7",
          $raw_user_agent: "Mozilla",
          environment: "x",
        },
      },
      { ics_feed_fetched: ["feed"] },
    )
    expect(out?.distinctId).toBe(SERVER_DISTINCT_ID)
    expect(out?.properties).toEqual({
      feed: "talks",
      environment: "x",
      $process_person_profile: false,
      $geoip_disable: true,
    })
    expect(sanitizeServerEvent({ distinctId: "x", event: "$pageview" }, {})).toBeNull()
    expect(sanitizeServerEvent({ distinctId: "x", event: "other" }, {})).toBeNull()
  })
})
