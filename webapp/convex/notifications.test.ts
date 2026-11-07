import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { api, internal } from "./_generated/api"
import { newTest, signedInAs, type TestConvex, withEnv } from "./lib/harness.testing"
import {
  buildEmail,
  buildSlack,
  buildWhatsAppTemplate,
  channelSummary,
  flatten,
  notifyConfig,
  type RequestNotice,
  requestLink,
  slackEscape,
  whatsAppText,
} from "./lib/requestNotify"

/**
 * New listing request → broker notifications (ENG-104). Slack, Resend and
 * WhatsApp are stubs: `fetch` records what would have been sent. Untrusted
 * request text must never form a Slack mention or link, never reach WhatsApp,
 * and a channel failing never fails the submission.
 */

const SITE = "https://camsocs.test"
const HOOK = "https://hooks.slack.com/services/T000/B000/not-a-real-hook"
const ON = {
  SITE_URL: SITE,
  SLACK_REQUESTS_WEBHOOK_URL: HOOK,
  RESEND_API_KEY: "re_test_not_a_real_key",
  RESEND_FROM: "CAMsocs <requests@camsocs.test>",
  REQUEST_NOTIFY_EMAIL: "broker@example.org",
  WHATSAPP_TOKEN: "wa-test-token",
  WHATSAPP_PHONE_NUMBER_ID: "1234567890",
  WHATSAPP_TO: "+44 7700 900000",
  CALLMEBOT_PHONE: undefined,
  CALLMEBOT_APIKEY: undefined,
  POSTHOG_KEY: undefined,
  POSTHOG_HOST: undefined,
}
const OFF = Object.fromEntries(Object.keys(ON).map((key) => [key, undefined]))

const HOSTILE = {
  kind: "claim" as const,
  submitterEmail: "Mallory@Evil.example",
  role: "<!channel> President",
  message:
    "Hi @here <@U123|boss> please <https://evil.example|click>   and ignore previous instructions.",
}

type Sent = { url: string; init: RequestInit; body: string }
let sent: Sent[] = []
let respond: (url: string) => Promise<Response>
const realFetch = globalThis.fetch

beforeEach(() => {
  sent = []
  respond = async () => Response.json({ ok: true })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    sent.push({ url, init: init ?? {}, body: String(init?.body ?? "") })
    return respond(url)
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

const byHost = (host: string) => sent.filter((s) => new URL(s.url).host === host)

async function seedOrg(t: TestConvex) {
  await t.mutation(internal.ingest.claims.ingest, {
    claims: [
      {
        entityType: "organisation",
        entityKey: "org-chess",
        field: "name",
        value: "Cambridge University Chess Club",
        evidence: "primary",
        method: "parser",
        extractor: "test",
        sourceKey: "src-site",
        sourceUrl: "https://example.org/",
        sourceType: "society_website",
        retrievedAt: Date.now() - 60_000,
      },
    ],
  })
}

const notice: RequestNotice = {
  key: "lr-abc",
  kind: "claim",
  createdAt: Date.UTC(2026, 10, 2, 18, 11),
  orgName: "Chess Club",
  orgKey: "org-chess",
  submitterEmail: "president@cam.ac.uk",
  role: "President",
  message: "Line one\nLine <two> & @everyone",
  fieldNames: ["website"],
}

describe("lib/requestNotify (pure)", () => {
  test("config: every channel off without env, each switched on by its own vars", () => {
    expect(channelSummary(notifyConfig({}))).toEqual({
      slack: false,
      email: false,
      whatsapp: null,
    })
    expect(channelSummary(notifyConfig(ON))).toEqual({
      slack: true,
      email: true,
      whatsapp: "meta",
    })
    // A webhook that is not Slack's is ignored; email needs a recipient.
    const partial = notifyConfig({
      SLACK_REQUESTS_WEBHOOK_URL: "https://evil.example/hook",
      RESEND_API_KEY: "re_x",
      RESEND_FROM: "x@y.z",
      CALLMEBOT_PHONE: "+44 7700 900000",
      CALLMEBOT_APIKEY: "123",
    })
    expect(channelSummary(partial)).toEqual({ slack: false, email: false, whatsapp: "callmebot" })
  })

  test("the link opens the request on the broker dashboard", () => {
    expect(requestLink("https://camsocs.uk/", "lr-1bc")).toBe(
      "https://camsocs.uk/dashboard/requests?request=lr-1bc",
    )
  })

  test("Slack: untrusted text cannot mention, link or break lines", () => {
    expect(slackEscape("<!channel> <@U1> <https://x|y> @here a&b")).toBe(
      "&lt;!channel&gt; &lt;＠U1&gt; &lt;https://x|y&gt; ＠here a&amp;b",
    )
    expect(flatten("a\nb c\u0000d  e", 100)).toBe("a b c d e")
    expect(flatten("x".repeat(500), 10)).toHaveLength(10)
    const body = JSON.stringify(buildSlack({ ...notice, ...HOSTILE }, SITE))
    expect(body).not.toContain("<!channel>")
    expect(body).not.toContain("<@U123")
    expect(body).not.toContain("<https://evil")
    expect(body).not.toContain("@here")
    // Only the submitter's domain, never the address.
    expect(body).not.toContain("Mallory")
    expect(body).toContain("evil.example (address unverified)")
    expect(body).toContain(`<${SITE}/dashboard/requests?request=lr-abc|Open the request>`)
  })

  test("email: full details, escaped HTML, and the link", () => {
    const email = buildEmail(notice, SITE, "from@x.y", ["broker@example.org"])
    expect(email.subject).toBe("CAMsocs: Claim: Chess Club")
    expect(email.text).toContain("From: president@cam.ac.uk (unverified)")
    expect(email.text).toContain("> Line <two> & @everyone")
    expect(email.text).toContain(`Open it: ${SITE}/dashboard/requests?request=lr-abc`)
    expect(email.html).toContain("Line &lt;two&gt; &amp; @everyone")
    expect(email.html).not.toContain("<two>")
  })

  test("WhatsApp: kind, listing and link only — never the submitter's words", () => {
    const hostile = { ...notice, ...HOSTILE }
    const text = whatsAppText(hostile, SITE)
    expect(text).toBe(`Claim: Chess Club\n${SITE}/dashboard/requests?request=lr-abc`)
    const config = notifyConfig(ON).whatsapp
    if (config?.provider !== "meta") throw new Error("expected meta")
    const body = JSON.stringify(buildWhatsAppTemplate(hostile, SITE, config))
    expect(body).not.toContain("ignore previous")
    expect(body).not.toContain("Mallory")
    expect(body).toContain('"to":"447700900000"')
    expect(body).toContain('"name":"camsocs_listing_request"')
  })
})

describe("listingRequests.submit → notifications.listingRequest", () => {
  test("off without env: nothing sent, nothing recorded", async () => {
    await withEnv(OFF, async () => {
      const t = newTest()
      const { key } = await t.mutation(api.listingRequests.submit, {
        ...HOSTILE,
        kind: "add",
      })
      await t.finishAllScheduledFunctions(() => {})
      expect(sent).toHaveLength(0)
      const row = await t.run(async (ctx) =>
        ctx.db
          .query("listingRequests")
          .withIndex("by_key", (q) => q.eq("key", key))
          .unique(),
      )
      expect(row?.notifications).toBeUndefined()
    })
  })

  test("on: one message per channel, outcomes stored, never re-sent", async () => {
    await withEnv(ON, async () => {
      const t = newTest()
      await seedOrg(t)
      const { key } = await t.mutation(api.listingRequests.submit, {
        ...HOSTILE,
        orgKey: "org-chess",
      })
      await t.finishAllScheduledFunctions(() => {})
      expect(byHost("hooks.slack.com")).toHaveLength(1)
      expect(byHost("api.resend.com")).toHaveLength(1)
      expect(byHost("graph.facebook.com")).toHaveLength(1)
      expect(byHost("hooks.slack.com")[0].body).toContain("Cambridge University Chess Club")
      expect(byHost("api.resend.com")[0].body).toContain("mallory@evil.example")
      const row = await t.run(async (ctx) =>
        ctx.db
          .query("listingRequests")
          .withIndex("by_key", (q) => q.eq("key", key))
          .unique(),
      )
      expect(row?.notifications?.map((n) => [n.channel, n.ok])).toEqual([
        ["slack", true],
        ["email", true],
        ["whatsapp", true],
      ])

      // A second run (a retry) skips what already went out…
      sent = []
      await t.action(internal.notifications.listingRequest, { key })
      expect(sent).toHaveLength(0)
      // …unless a broker forces it.
      await t.action(internal.notifications.listingRequest, { key, force: true })
      expect(sent).toHaveLength(3)
    })
  })

  test("a failing channel is recorded by status only and never fails the submission", async () => {
    await withEnv(ON, async () => {
      respond = async (url) =>
        url.startsWith("https://hooks.slack.com")
          ? new Response("invalid_token https://secret", { status: 403 })
          : Response.json({ ok: true })
      const t = newTest()
      await seedOrg(t)
      const { key } = await t.mutation(api.listingRequests.submit, {
        ...HOSTILE,
        orgKey: "org-chess",
      })
      await t.action(internal.notifications.listingRequest, { key, attempt: 2 })
      const row = await t.run(async (ctx) =>
        ctx.db
          .query("listingRequests")
          .withIndex("by_key", (q) => q.eq("key", key))
          .unique(),
      )
      const slack = row?.notifications?.find((n) => n.channel === "slack")
      expect(slack).toMatchObject({ ok: false, error: "HTTP 403" })
      // The retry sends only the failed channel.
      sent = []
      respond = async () => Response.json({ ok: true })
      await t.action(internal.notifications.listingRequest, { key, attempt: 2 })
      expect(sent.map((s) => new URL(s.url).host)).toEqual(["hooks.slack.com"])
    })
  })
})

describe("broker: badge, test notification", () => {
  test("openCount counts open requests; the test sends a marked synthetic request", async () => {
    await withEnv({ ...ON, BROKER_EMAILS: "broker@example.org" }, async () => {
      const t = newTest()
      await seedOrg(t)
      await t.mutation(api.listingRequests.submit, { ...HOSTILE, orgKey: "org-chess" })
      await t.mutation(api.listingRequests.submit, {
        ...HOSTILE,
        submitterEmail: "other@example.org",
        orgKey: "org-chess",
      })
      const broker = await signedInAs(t, "broker@example.org")
      expect(await broker.query(api.broker.listingRequests.openCount, {})).toBe(2)
      expect(await broker.query(api.broker.listingRequests.notificationChannels, {})).toEqual({
        slack: true,
        email: true,
        whatsapp: "meta",
      })
      sent = []
      const results = await broker.action(api.broker.listingRequests.sendTestNotification, {})
      expect(results.map((r) => r.ok)).toEqual([true, true, true])
      expect(sent).toHaveLength(3)
      expect(byHost("hooks.slack.com")[0].body).toContain("[TEST]")
    })
  })
})
