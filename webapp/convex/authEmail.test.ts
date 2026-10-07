import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { isCamEmail } from "../lib/cam-email"
import { api, components } from "./_generated/api"
import { NOT_CAM_EMAIL } from "./betterAuth/auth"
import { newTest, type TestConvex, withEnv } from "./lib/harness.testing"
import { buildSignInEmail, RESEND_ENDPOINT, resendConfig } from "./lib/signInEmail"

/**
 * The `@cam.ac.uk` sign-in link end to end, through the real Better Auth
 * routes (convex-test `t.fetch` → convex/http.ts → betterAuth/auth.ts):
 * the domain restriction is enforced on the server, the throttle holds, the
 * option is off without Resend, and a verified link yields a session that
 * `getViewer` reports as `isCamVerified`. Resend itself is a stub: the test
 * captures what would have been sent.
 */

const SITE = "http://localhost:3000"
const ENV = {
  BETTER_AUTH_SECRET: "test-secret-for-better-auth-0123456789",
  SITE_URL: SITE,
  RESEND_API_KEY: "re_test_not_a_real_key",
  RESEND_FROM: "camsocs <sign-in@example.org>",
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

function requestLink(t: TestConvex, email: string) {
  return t.fetch("/api/auth/sign-in/magic-link", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: SITE },
    body: JSON.stringify({ email, callbackURL: "/" }),
  })
}

/** The link in the last email, as the path + query `t.fetch` takes. */
function lastLinkPath(): string {
  const match = sent.at(-1)?.body.text.match(/https?:\/\/\S+/)
  if (!match) throw new Error("no link in the email")
  const url = new URL(match[0])
  expect(url.origin).toBe(SITE)
  return `${url.pathname}${url.search}`
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

describe("POST /api/auth/sign-in/magic-link", () => {
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

  test("sends a link to a @cam.ac.uk address; the link signs in as cam-verified", async () => {
    await withEnv(ENV, async () => {
      const t = newTest()
      expect((await t.query(api.auth.getSignInOptions, {})).camEmail).toBe(true)

      const response = await requestLink(t, "AB123@cam.ac.uk")
      expect(response.status).toBe(200)
      expect(sent).toHaveLength(1)
      expect(sent[0].body.to).toEqual(["ab123@cam.ac.uk"])
      expect(sent[0].body.from).toBe(ENV.RESEND_FROM)
      expect(sent[0].headers.get("Authorization")).toBe(`Bearer ${ENV.RESEND_API_KEY}`)

      const verify = await t.fetch(lastLinkPath(), { headers: { Origin: SITE } })
      expect(verify.status).toBe(302)
      expect(verify.headers.get("location")).toBe(`${SITE}/`)
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

      // A link works once.
      const again = await t.fetch(lastLinkPath(), { headers: { Origin: SITE } })
      expect(again.headers.get("location")).toContain("error=INVALID_TOKEN")
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

  test("reports a Resend failure as 502 without leaking the key or the link", async () => {
    await withEnv(ENV, async () => {
      globalThis.fetch = (async () =>
        Response.json({ name: "validation_error" }, { status: 422 })) as unknown as typeof fetch
      const logged = spyOn(console, "error").mockImplementation(() => {})
      try {
        const response = await requestLink(newTest(), "ab123@cam.ac.uk")
        expect(response.status).toBe(502)
        const text = await response.text()
        expect(text).not.toContain(ENV.RESEND_API_KEY)
        expect(text).not.toContain("token=")
        // The deployment log names the failure, never the key or the link.
        const log = JSON.stringify(logged.mock.calls)
        expect(log).toContain("HTTP 422: validation_error")
        expect(log).not.toContain(ENV.RESEND_API_KEY)
        expect(log).not.toContain("token=")
      } finally {
        logged.mockRestore()
      }
    })
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

  test("escapes the link in the HTML part", () => {
    const email = buildSignInEmail("a@b.c", "ab123@cam.ac.uk", 'https://x.test/?a=1&b="2"')
    expect(email.html).toContain("https://x.test/?a=1&amp;b=&quot;2&quot;")
    expect(email.text).toContain('https://x.test/?a=1&b="2"')
  })
})
