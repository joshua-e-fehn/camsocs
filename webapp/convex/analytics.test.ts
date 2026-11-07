import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { api, internal } from "./_generated/api"
import { newTest, type TestConvex, withEnv } from "./lib/harness.testing"
import {
  CAPTURE_PATH,
  captureBody,
  posthogConfig,
  SERVER_DISTINCT_ID,
  sendCapture,
} from "./lib/posthog"

/**
 * The listing-request count (ENG-7; record of processing P12): an accepted
 * `listingRequests.submit` schedules `analytics.captureListingRequest`, which
 * posts exactly `listing_request_received { kind }` under the fixed distinct
 * id to PostHog's capture path, and nothing of the submitter. Without the env
 * vars nothing is sent; a refused request is never counted; PostHog failing
 * (refusal, network error) is logged by status or error type and swallowed,
 * and the submission still succeeds.
 *
 * PostHog itself is a stub: `fetch` records what would have been sent.
 */

const HOST = "https://eu.i.posthog.test"
const KEY = "phc_test_not_a_real_key"
const ENV = { POSTHOG_KEY: KEY, POSTHOG_HOST: HOST, POSTHOG_ENV: undefined }
const OFF = { POSTHOG_KEY: undefined, POSTHOG_HOST: undefined, POSTHOG_ENV: undefined }

const ADD = {
  kind: "add" as const,
  submitterEmail: "Founder@Example.org",
  role: "President",
  message: "Please list the Cambridge Origami Society.",
  fields: { name: "CU Origami Society" },
}

type Sent = { url: string; init: RequestInit; body: Record<string, unknown> }
let sent: Sent[] = []
/** What the stub does with a capture request; reset to "200 OK" per test. */
let respond: () => Promise<Response>
const realFetch = globalThis.fetch

beforeEach(() => {
  sent = []
  respond = async () => Response.json({ status: "Ok" })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url !== `${HOST}${CAPTURE_PATH}`) throw new Error(`Unexpected network call to ${url}`)
    sent.push({ url, init: init ?? {}, body: JSON.parse(String(init?.body)) })
    return respond()
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

/** Submits, then runs every scheduled function to the end. */
async function submitAndSettle(t: TestConvex, args: typeof ADD = ADD) {
  const result = await t.mutation(api.listingRequests.submit, args)
  await t.finishAllScheduledFunctions(() => {})
  return result
}

describe("listingRequests.submit → listing_request_received", () => {
  test("an accepted request is counted by kind, and nothing else is sent", async () => {
    await withEnv(ENV, async () => {
      const t = newTest()
      const { key } = await submitAndSettle(t)
      expect(key).toStartWith("lr-")
      expect(sent).toHaveLength(1)
      expect(sent[0].url).toBe("https://eu.i.posthog.test/i/v0/e/")
      expect(sent[0].init.method).toBe("POST")
      expect(new Headers(sent[0].init.headers).get("content-type")).toBe("application/json")
      expect(sent[0].body).toEqual({
        api_key: KEY,
        event: "listing_request_received",
        distinct_id: "camsocs-server",
        properties: {
          kind: "add",
          campus: "cam",
          environment: "production",
          $process_person_profile: false,
          $geoip_disable: true,
        },
      })
      const wire = JSON.stringify(sent[0])
      for (const secret of ["founder", "Founder", "President", "Origami", key]) {
        expect(wire).not.toContain(secret)
      }
    })
  })

  test("without POSTHOG_KEY / POSTHOG_HOST nothing is sent, and the request is stored", async () => {
    for (const env of [OFF, { ...OFF, POSTHOG_KEY: KEY }, { ...OFF, POSTHOG_HOST: HOST }]) {
      await withEnv(env, async () => {
        const t = newTest()
        const { key } = await submitAndSettle(t)
        const row = await t.run(async (ctx) => await ctx.db.query("listingRequests").first())
        expect(row?.key).toBe(key)
      })
    }
    expect(sent).toHaveLength(0)
  })

  test("a refused request is never counted", async () => {
    await withEnv(ENV, async () => {
      const t = newTest()
      await expect(
        t.mutation(api.listingRequests.submit, { ...ADD, submitterEmail: "nope" }),
      ).rejects.toThrow(/valid email/)
      await expect(
        t.mutation(api.listingRequests.submit, { ...ADD, kind: "claim" }),
      ).rejects.toThrow(/Which listing/)
      for (let i = 0; i < 5; i++) {
        await t.mutation(api.listingRequests.submit, { ...ADD, message: `${ADD.message} ${i}` })
      }
      await expect(t.mutation(api.listingRequests.submit, ADD)).rejects.toThrow(/Too many/)
      await t.finishAllScheduledFunctions(() => {})
      expect(sent).toHaveLength(5)
    })
  })

  test("PostHog refusing or unreachable: logged without the key, swallowed, request kept", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {})
    try {
      await withEnv(ENV, async () => {
        const t = newTest()
        respond = async () => new Response("bad key", { status: 401 })
        await submitAndSettle(t)
        respond = async () => {
          throw new TypeError("fetch failed")
        }
        await submitAndSettle(t, { ...ADD, message: `${ADD.message} again` })
        const rows = await t.run(async (ctx) => await ctx.db.query("listingRequests").collect())
        expect(rows).toHaveLength(2)
      })
      expect(sent).toHaveLength(2)
      const lines = logged.mock.calls.map((call) => call.join(" "))
      expect(lines).toEqual([
        "PostHog refused listing_request_received (HTTP 401)",
        "PostHog capture of listing_request_received failed (TypeError)",
      ])
      expect(lines.join("\n")).not.toContain(KEY)
    } finally {
      logged.mockRestore()
    }
  })
})

describe("analytics.captureListingRequest", () => {
  test("accepts only the listing-request kinds", async () => {
    await withEnv(ENV, async () => {
      const t = newTest()
      await t.action(internal.analytics.captureListingRequest, { kind: "object" })
      await expect(
        t.action(internal.analytics.captureListingRequest, { kind: "jane@example.org" } as never),
      ).rejects.toThrow()
    })
    expect(sent.map((s) => (s.body.properties as Record<string, unknown>).kind)).toEqual(["object"])
  })
})

describe("lib/posthog", () => {
  test("posthogConfig: both values or off; a trailing slash on the host is dropped", () => {
    expect(posthogConfig({})).toBeNull()
    expect(posthogConfig({ POSTHOG_KEY: KEY })).toBeNull()
    expect(posthogConfig({ POSTHOG_KEY: " ", POSTHOG_HOST: HOST })).toBeNull()
    expect(posthogConfig({ POSTHOG_KEY: KEY, POSTHOG_HOST: `${HOST}/` })).toEqual({
      key: KEY,
      host: HOST,
      environment: "production",
    })
    expect(
      posthogConfig({ POSTHOG_KEY: KEY, POSTHOG_HOST: HOST, POSTHOG_ENV: "development" })
        ?.environment,
    ).toBe("development")
  })

  test("captureBody: our tags win over a property of the same name", () => {
    const config = { key: KEY, host: HOST, environment: "development" as const }
    const body = captureBody(config, "x", {
      environment: "production",
      campus: "elsewhere",
      $process_person_profile: true,
    })
    expect(body.distinct_id).toBe(SERVER_DISTINCT_ID)
    expect(body.properties).toEqual({
      campus: "cam",
      environment: "development",
      $process_person_profile: false,
      $geoip_disable: true,
    })
  })

  test("sendCapture gives up on a hung request", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {})
    try {
      const config = { key: KEY, host: HOST, environment: "production" as const }
      let aborted = false
      const hang = ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true
            reject(new DOMException("aborted", "AbortError"))
          })
        })) as typeof fetch
      const started = Date.now()
      await sendCapture(config, "x", {}, hang, 20)
      expect(aborted).toBe(true)
      expect(Date.now() - started).toBeLessThan(1_000)
      expect(logged.mock.calls[0]?.join(" ")).toBe("PostHog capture of x failed (AbortError)")
    } finally {
      logged.mockRestore()
    }
  })
})
