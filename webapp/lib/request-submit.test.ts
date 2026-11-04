import { afterEach, describe, expect, type Mock, spyOn, test } from "bun:test"
import { ConvexError } from "convex/values"
import type { SubmitArgs } from "./listing-request"
import { BOT_REFUSED, REQUEST_PATH, SEND_FAILED } from "./request-client"
import {
  botCheckEnabled,
  handleRequestSubmit,
  isBotIdSetupError,
  MAX_BODY_BYTES,
  type SubmitDeps,
} from "./request-submit"

/**
 * The request form's route (ENG-37): BotID only on Vercel, failing open only
 * while it is not set up, the form secret added on the server only, Convex's
 * refusals passed on in its own words, and nothing the visitor wrote in a log
 * line.
 */

const ARGS = {
  kind: "correct",
  orgKey: "org-cu-chess-club",
  submitterEmail: "sec@cuchess.org",
  message: "Training moved to Thursdays.",
  fields: { timeCommitment: "Thursdays 7pm" },
} satisfies SubmitArgs

const ON_VERCEL = { VERCEL: "1" }

function post(body: unknown): Request {
  return new Request(`https://camsocs.test${REQUEST_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

/** Deps that record what reached them. */
function deps(overrides: Partial<SubmitDeps> = {}) {
  const calls = { checkBot: 0, submit: [] as SubmitArgs[] }
  return {
    calls,
    deps: {
      checkBot: async () => {
        calls.checkBot += 1
        return { isBot: false }
      },
      submit: async (args: SubmitArgs) => {
        calls.submit.push(args)
        return { key: "lr-0123456789abcdef0123" }
      },
      env: {},
      ...overrides,
    } satisfies SubmitDeps,
  }
}

/** console.error, silenced and recorded for the test that asks. */
let log: Mock<typeof console.error> | null = null
const quiet = () => {
  log = spyOn(console, "error").mockImplementation(() => {})
  return log
}

afterEach(() => {
  log?.mockRestore()
  log = null
})

describe("botCheckEnabled", () => {
  test("on Vercel only, with an off switch", () => {
    expect(botCheckEnabled({})).toBe(false)
    expect(botCheckEnabled({ VERCEL: "1" })).toBe(true)
    expect(botCheckEnabled({ VERCEL: "1", REQUEST_BOT_CHECK: "off" })).toBe(false)
    expect(botCheckEnabled({ VERCEL_ENV: "production" })).toBe(false)
  })
})

describe("isBotIdSetupError", () => {
  test("botid 1.5.11's setup throws, and nothing else", () => {
    for (const message of [
      "The 'x-vercel-oidc-token' header is missing from the request. Do you have the OIDC option enabled in the Vercel project settings?",
      "VERCEL_OIDC_TOKEN is not set",
      "Must be deployed on Vercel to access response headers",
      "Must be deployed on Vercel to set response headers",
    ]) {
      expect(isBotIdSetupError(new Error(message))).toBe(true)
    }
    expect(isBotIdSetupError(new SyntaxError("Unexpected end of JSON input"))).toBe(false)
    expect(isBotIdSetupError(new TypeError("fetch failed"))).toBe(false)
    expect(isBotIdSetupError("VERCEL_OIDC_TOKEN is not set")).toBe(false)
    expect(isBotIdSetupError(undefined)).toBe(false)
  })
})

describe("handleRequestSubmit", () => {
  test("off Vercel it stores without asking BotID, and sends no secret it lacks", async () => {
    const { calls, deps: d } = deps()
    const response = await handleRequestSubmit(post(ARGS), d)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ key: "lr-0123456789abcdef0123" })
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(calls.checkBot).toBe(0)
    expect(calls.submit).toEqual([ARGS])
  })

  test("on Vercel a human passes and the server adds the form secret", async () => {
    const { calls, deps: d } = deps({ env: { ...ON_VERCEL, REQUEST_FORM_SECRET: "s3cret" } })
    const response = await handleRequestSubmit(post(ARGS), d)
    expect(response.status).toBe(200)
    expect(calls.checkBot).toBe(1)
    expect(calls.submit).toEqual([{ ...ARGS, formSecret: "s3cret" }])
  })

  test("a bot is turned away before Convex", async () => {
    const { calls, deps: d } = deps({ env: ON_VERCEL, checkBot: async () => ({ isBot: true }) })
    const response = await handleRequestSubmit(post(ARGS), d)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: BOT_REFUSED })
    expect(calls.submit).toEqual([])
  })

  test("a check that is not set up lets the request through (fail open) and logs no content", async () => {
    const log = quiet()
    const { calls, deps: d } = deps({
      env: ON_VERCEL,
      checkBot: async () => {
        throw new Error("The 'x-vercel-oidc-token' header is missing from the request.")
      },
    })
    const response = await handleRequestSubmit(post(ARGS), d)
    expect(response.status).toBe(200)
    expect(calls.submit).toHaveLength(1)
    const logged = log.mock.calls.flat().join(" ")
    expect(logged).toContain("BotID check failed")
    expect(logged).not.toContain(ARGS.submitterEmail)
  })

  test("any other failing check refuses the request (fail closed) and logs no content", async () => {
    const log = quiet()
    for (const thrown of [
      new SyntaxError(`Unexpected token '<', "<html>" is not valid JSON`),
      new TypeError("fetch failed"),
      "a string",
    ]) {
      const { calls, deps: d } = deps({
        env: ON_VERCEL,
        checkBot: async () => {
          throw thrown
        },
      })
      const response = await handleRequestSubmit(post(ARGS), d)
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: SEND_FAILED })
      expect(calls.submit).toEqual([])
    }
    const logged = log.mock.calls.flat().join(" ")
    expect(logged).toContain("BotID check errored")
    expect(logged).not.toContain("<html>")
    expect(logged).not.toContain(ARGS.submitterEmail)
  })

  test("REQUEST_BOT_CHECK=off skips the check on Vercel", async () => {
    const { calls, deps: d } = deps({ env: { ...ON_VERCEL, REQUEST_BOT_CHECK: "off" } })
    expect((await handleRequestSubmit(post(ARGS), d)).status).toBe(200)
    expect(calls.checkBot).toBe(0)
  })

  test("a body the form would never send is refused unseen by Convex", async () => {
    const { calls, deps: d } = deps()
    for (const body of [
      "not json",
      { ...ARGS, kind: "delete" },
      { ...ARGS, message: 42 },
      // Only the server may add the secret.
      { ...ARGS, formSecret: "guessed" },
      { ...ARGS, extra: true },
    ]) {
      const response = await handleRequestSubmit(post(body), d)
      expect(response.status).toBe(400)
    }
    const huge = { ...ARGS, message: "x".repeat(MAX_BODY_BYTES) }
    expect((await handleRequestSubmit(post(huge), d)).status).toBe(413)
    expect(calls.submit).toEqual([])
  })

  test("Convex's refusals reach the form in its own words; other failures do not", async () => {
    const refused = deps({
      submit: async () => {
        throw new ConvexError("Too many requests from this address; please try again in an hour")
      },
    })
    const response = await handleRequestSubmit(post(ARGS), refused.deps)
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      error: "Too many requests from this address; please try again in an hour",
    })

    const log = quiet()
    const broken = deps({
      submit: async () => {
        throw new Error(`ArgumentValidationError: Value ${JSON.stringify(ARGS)} does not match`)
      },
    })
    const failed = await handleRequestSubmit(post(ARGS), broken.deps)
    expect(failed.status).toBe(502)
    expect(await failed.json()).toEqual({ error: SEND_FAILED })
    expect(log.mock.calls.flat().join(" ")).not.toContain(ARGS.submitterEmail)
  })
})
