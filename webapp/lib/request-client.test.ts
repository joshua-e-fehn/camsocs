import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { SubmitArgs } from "./listing-request"
import { REQUEST_PATH, SEND_FAILED, sendListingRequest } from "./request-client"

/**
 * The request form's sender (ENG-37): what it posts, the sentence it shows,
 * the timeout that aborts a slow request, and the imports that keep it (and
 * instrumentation-client.ts, which loads on every page) free of server code.
 */

const ARGS = {
  kind: "correct",
  orgKey: "org-cu-chess-club",
  submitterEmail: "sec@cuchess.org",
  message: "Training moved to Thursdays.",
  fields: { timeCommitment: "Thursdays 7pm" },
} satisfies SubmitArgs

describe("sendListingRequest", () => {
  const respond = (body: unknown, status = 200) =>
    (async () => Response.json(body, { status })) as unknown as typeof fetch

  test("posts the arguments as JSON to the route", async () => {
    let seen: { url: string; init?: RequestInit } | null = null
    const send = (async (url: string, init?: RequestInit) => {
      seen = { url, init }
      return Response.json({ key: "lr-1" })
    }) as unknown as typeof fetch
    expect(await sendListingRequest(ARGS, { fetch: send })).toEqual({ ok: true, key: "lr-1" })
    expect(seen).toMatchObject({ url: REQUEST_PATH, init: { method: "POST" } })
    expect(JSON.parse(String((seen as unknown as { init: RequestInit }).init.body))).toEqual(ARGS)
  })

  test("passes on the route's sentence, and falls back to a generic one", async () => {
    expect(await sendListingRequest(ARGS, { fetch: respond({ error: "Busy" }, 422) })).toEqual({
      ok: false,
      error: "Busy",
    })
    expect(await sendListingRequest(ARGS, { fetch: respond("<html>", 500) })).toEqual({
      ok: false,
      error: SEND_FAILED,
    })
    const offline = (async () => {
      throw new TypeError("Failed to fetch")
    }) as unknown as typeof fetch
    expect(await sendListingRequest(ARGS, { fetch: offline })).toEqual({
      ok: false,
      error: SEND_FAILED,
    })
  })

  test("gives up on a request that never answers, and aborts it", async () => {
    let signal: AbortSignal | undefined
    const never = ((_: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>(() => {})
    }) as unknown as typeof fetch
    expect(await sendListingRequest(ARGS, { fetch: never, timeoutMs: 20 })).toEqual({
      ok: false,
      error: SEND_FAILED,
    })
    expect(signal?.aborted).toBe(true)
  })

  test("a request that answers in time is not aborted", async () => {
    let signal: AbortSignal | undefined
    const quick = (async (_: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return Response.json({ key: "lr-2" })
    }) as unknown as typeof fetch
    expect(await sendListingRequest(ARGS, { fetch: quick, timeoutMs: 20 })).toEqual({
      ok: true,
      key: "lr-2",
    })
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(signal?.aborted).toBe(false)
  })
})

describe("the browser's imports", () => {
  /** Module specifiers a file imports at run time (`import type` is erased). */
  const runtimeImports = (path: string) =>
    [
      ...readFileSync(join(import.meta.dir, "..", path), "utf8").matchAll(
        /^import (?!type )[^"]*"([^"]+)"/gm,
      ),
    ].map((match) => match[1])

  test("request-client.ts pulls in no zod, convex/values or server module", () => {
    expect(runtimeImports("lib/request-client.ts")).toEqual(["./site"])
  })

  test("instrumentation-client.ts takes the path from request-client, not the route's module", () => {
    const imports = runtimeImports("instrumentation-client.ts")
    expect(imports).toContain("@/lib/request-client")
    expect(imports).not.toContain("@/lib/request-submit")
  })
})
