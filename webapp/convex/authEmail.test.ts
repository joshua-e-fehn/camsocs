import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { isCamEmail } from "../lib/cam-email"
import { api, components, internal } from "./_generated/api"
import { LINKS_PER_CLIENT, LINKS_PER_HOUR } from "./authEmail"
import { NOT_CAM_EMAIL } from "./betterAuth/auth"
import { newTest, type TestConvex, withEnv } from "./lib/harness.testing"
import {
  buildSignInEmail,
  RESEND_ENDPOINT,
  resendConfig,
  SIGN_IN_CODE_ATTEMPTS,
} from "./lib/signInEmail"

/**
 * The `@cam.ac.uk` sign-in code end to end, through the real Better Auth
 * routes (convex-test `t.fetch` → convex/http.ts → betterAuth/auth.ts):
 * the domain restriction is enforced on the server, the throttle holds, the
 * option is off without Resend, and a verified code yields a session that
 * `getViewer` reports as `isCamVerified`. Resend itself is a stub: the test
 * captures what would have been sent.
 */

const SITE = "http://localhost:3000"
const ENV = {
  BETTER_AUTH_SECRET: "test-secret-for-better-auth-0123456789",
  SITE_URL: SITE,
  RESEND_API_KEY: "re_test_not_a_real_key",
  RESEND_FROM: "CAMsocs <sign-in@example.org>",
}

type Sent = { url: string; headers: Headers; body: { to: string[]; text: string; from: string } }
let sent: Sent[] = []
const realFetch = globalThis.fetch

beforeEach(() => {
  sent = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url !== RESEND_ENDPOINT) throw new Error(`Unexpected network call to ${url}`)
    sent.push({
      url,
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    })
    return Response.json({ id: `email-${sent.length}` })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

function requestLink(t: TestConvex, email: string, forwardedFor?: string, type = "sign-in") {
  return t.fetch("/api/auth/email-otp/send-verification-otp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: SITE,
      ...(forwardedFor ? { "x-forwarded-for": forwardedFor } : {}),
    },
    body: JSON.stringify({ email, type }),
  })
}

function signIn(t: TestConvex, email: string, otp: string) {
  return t.fetch("/api/auth/sign-in/email-otp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: SITE },
    body: JSON.stringify({ email, otp }),
  })
}

/** The code in the last email. */
function lastCode(): string {
  const match = sent[sent.length - 1]?.body.text.match(/^\d{6}$/m)
  if (!match) throw new Error("no code in the email")
  return match[0]
}

describe("isCamEmail", () => {
  test("exactly @cam.ac.uk, case-insensitive, trimmed", () => {
    expect(isCamEmail("ab123@cam.ac.uk")).toBe(true)
    expect(isCamEmail("  Ab123@CAM.AC.UK ")).toBe(true)
    expect(isCamEmail("ab123@srcf.cam.ac.uk")).toBe(false)
    expect(isCamEmail("ab123@hermes.cam.ac.uk")).toBe(false)
    expect(isCamEmail("ab123@cam.ac.uk.evil.com")).toBe(false)
    expect(isCamEmail("ab123@notcam.ac.uk")).toBe(false)
    expect(isCamEmail("a b@cam.ac.uk")).toBe(false)
    expect(isCamEmail("a@b@cam.ac.uk")).toBe(false)
    expect(isCamEmail("someone@gmail.com")).toBe(false)
    expect(isCamEmail(`${"a".repeat(250)}@cam.ac.uk`)).toBe(false)
  })
})

describe("the @cam.ac.uk sign-in code", () => {
  test("refuses every address that is not @cam.ac.uk, and sends nothing", async () => {
    await withEnv(ENV, async () => {
      const t = newTest()
      for (const email of ["someone@gmail.com", "ab123@srcf.cam.ac.uk", "x@cam.ac.uk.evil.com"]) {
        const response = await requestLink(t, email)
        expect(response.status).toBe(400)
        expect(((await response.json()) as { message: string }).message).toBe(NOT_CAM_EMAIL)
      }
      expect(sent).toEqual([])
    })
  })

  test("is not registered at all until Resend is configured", async () => {
    await withEnv({ ...ENV, RESEND_API_KEY: undefined }, async () => {
      const t = newTest()
      expect((await requestLink(t, "ab123@cam.ac.uk")).status).toBe(404)
      expect(await t.query(api.auth.getSignInOptions, {})).toEqual({
        google: false,
        camEmail: false,
      })
      expect(sent).toEqual([])
    })
  })

  test("sends a code to a @cam.ac.uk address; the code signs in as cam-verified", async () => {
    await withEnv(ENV, async () => {
      const t = newTest()
      expect((await t.query(api.auth.getSignInOptions, {})).camEmail).toBe(true)

      const response = await requestLink(t, "AB123@cam.ac.uk")
      expect(response.status).toBe(200)
      expect(sent).toHaveLength(1)
      expect(sent[0].body.to).toEqual(["ab123@cam.ac.uk"])
      expect(sent[0].body.from).toBe(ENV.RESEND_FROM)
      expect(sent[0].headers.get("Authorization")).toBe(`Bearer ${ENV.RESEND_API_KEY}`)
      // No link a mail scanner could open.
      expect(sent[0].body.text).not.toMatch(/https?:\/\//)
      const code = lastCode()

      // A wrong code does not sign in and does not spend the right one.
      expect(
        (await signIn(t, "ab123@cam.ac.uk", code === "000000" ? "111111" : "000000")).status,
      ).toBe(400)

      const verify = await signIn(t, "ab123@cam.ac.uk", code)
      expect(verify.status).toBe(200)
      expect(verify.headers.get("set-cookie")).toContain("better-auth.session_token")

      const user = await t.query(components.betterAuth.adapter.findOne, {
        model: "user",
        where: [{ field: "email", value: "ab123@cam.ac.uk" }],
      })
      expect(user?.emailVerified).toBe(true)
      const session = await t.query(components.betterAuth.adapter.findOne, {
        model: "session",
        where: [{ field: "userId", value: user?._id as string }],
      })
      const viewer = t.withIdentity({ subject: user?._id, sessionId: session?._id } as never)
      expect(await viewer.query(api.auth.getViewerTier, {})).toEqual({
        signedIn: true,
        isBroker: false,
        isCamVerified: true,
      })

      // A code works once.
      expect((await signIn(t, "ab123@cam.ac.uk", code)).status).toBeGreaterThanOrEqual(400)
    })
  })

  test("a code stops working after too many wrong guesses", async () => {
    await withEnv(ENV, async () => {
      const t = newTest()
      await requestLink(t, "ab123@cam.ac.uk")
      const code = lastCode()
      const wrong = code === "000000" ? "111111" : "000000"
      for (let i = 0; i < SIGN_IN_CODE_ATTEMPTS; i++) await signIn(t, "ab123@cam.ac.uk", wrong)
      const late = await signIn(t, "ab123@cam.ac.uk", code)
      expect(late.status).toBe(403)
      expect(((await late.json()) as { code: string }).code).toBe("TOO_MANY_ATTEMPTS")
    })
  })

  test("refuses every other email-OTP use (password reset, email change, verify-email)", async () => {
    await withEnv(ENV, async () => {
      const t = newTest()
      for (const type of ["forget-password", "email-verification"]) {
        expect((await requestLink(t, "ab123@cam.ac.uk", undefined, type)).status).toBe(404)
      }
      const reset = await t.fetch("/api/auth/forget-password/email-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: SITE },
        body: JSON.stringify({ email: "ab123@cam.ac.uk" }),
      })
      expect(reset.status).toBe(404)
      expect(sent).toEqual([])
    })
  })

  test("throttles repeat requests for one address", async () => {
    await withEnv(ENV, async () => {
      const t = newTest()
      const statuses: number[] = []
      for (let i = 0; i < 4; i++) statuses.push((await requestLink(t, "ab123@cam.ac.uk")).status)
      expect(statuses).toEqual([200, 200, 200, 429])
      expect(sent).toHaveLength(3)
      // Another address is unaffected.
      expect((await requestLink(t, "cd456@cam.ac.uk")).status).toBe(200)
    })
  })

  test("throttles one client asking for links to many addresses", async () => {
    await withEnv(ENV, async () => {
      const t = newTest()
      const statuses: number[] = []
      for (let i = 0; i <= LINKS_PER_CLIENT; i++) {
        statuses.push((await requestLink(t, `zz${i}@cam.ac.uk`, "203.0.113.7, 10.0.0.1")).status)
      }
      expect(statuses.filter((status) => status === 200)).toHaveLength(LINKS_PER_CLIENT)
      expect(statuses[LINKS_PER_CLIENT]).toBe(429)
    })
  })

  test("logs a Resend failure without the key or the code", async () => {
    await withEnv(ENV, async () => {
      globalThis.fetch = (async () =>
        Response.json({ name: "validation_error" }, { status: 422 })) as unknown as typeof fetch
      const logged = spyOn(console, "error").mockImplementation(() => {})
      try {
        // Better Auth runs the send through runInBackgroundOrAwait, which logs
        // what it throws; the caller sees success and can ask for a new code.
        const response = await requestLink(newTest(), "ab123@cam.ac.uk")
        expect(response.status).toBe(200)
        const log = JSON.stringify(logged.mock.calls)
        expect(log).toContain("HTTP 422: validation_error")
        expect(log).not.toContain(ENV.RESEND_API_KEY)
        expect(log).not.toMatch(/\b\d{6}\b/)
      } finally {
        logged.mockRestore()
      }
    })
  })
})

describe("reserveSignInLink", () => {
  test("one client cycling through addresses is stopped before the overall cap", async () => {
    const t = newTest()
    const verdicts: string[] = []
    for (let i = 0; i < LINKS_PER_CLIENT + 1; i++) {
      verdicts.push(
        await t.mutation(internal.authEmail.reserveSignInLink, {
          email: `zz${i}@cam.ac.uk`,
          client: "203.0.113.7",
        }),
      )
    }
    expect(verdicts.slice(0, LINKS_PER_CLIENT).every((v) => v === "ok")).toBe(true)
    expect(verdicts[LINKS_PER_CLIENT]).toBe("client_limit")
    // Another client is unaffected.
    expect(
      await t.mutation(internal.authEmail.reserveSignInLink, {
        email: "ab123@cam.ac.uk",
        client: "198.51.100.2",
      }),
    ).toBe("ok")
    // The client is stored only hashed.
    const rows = await t.run(async (ctx) => await ctx.db.query("signInLinkSends").collect())
    expect(JSON.stringify(rows)).not.toContain("203.0.113.7")
  })

  test("the overall cap never locks out an address that has signed in before", async () => {
    const t = newTest()
    for (let i = 0; i < LINKS_PER_HOUR; i++) {
      await t.mutation(internal.authEmail.reserveSignInLink, {
        email: `zz${i}@cam.ac.uk`,
        client: `client-${i}`,
      })
    }
    const fresh = { email: "new1@cam.ac.uk", client: "client-new" }
    expect(await t.mutation(internal.authEmail.reserveSignInLink, fresh)).toBe("global_limit")
    expect(
      await t.mutation(internal.authEmail.reserveSignInLink, {
        email: "known1@cam.ac.uk",
        client: "client-known",
        knownUser: true,
      }),
    ).toBe("ok")
  })
})

describe("signInEmail", () => {
  test("is off unless both env vars are set", () => {
    expect(resendConfig({})).toBeNull()
    expect(resendConfig({ RESEND_API_KEY: "re_x" })).toBeNull()
    expect(resendConfig({ RESEND_API_KEY: " ", RESEND_FROM: "a@b.c" })).toBeNull()
    expect(resendConfig({ RESEND_API_KEY: "re_x", RESEND_FROM: "a@b.c" })).toEqual({
      apiKey: "re_x",
      from: "a@b.c",
    })
  })

  test("carries the code, and no link", () => {
    const email = buildSignInEmail("a@b.c", "ab123@cam.ac.uk", "042917")
    expect(email.subject).toBe("042917 is your CAMsocs sign-in code")
    expect(email.text.split("\n")).toContain("042917")
    expect(email.html).toContain("042917")
    expect(email.html).not.toContain("<a ")
  })
})
