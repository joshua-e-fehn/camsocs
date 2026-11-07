import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { api, internal } from "./_generated/api"
import { newTest, signedInAs, type TestConvex, withEnv } from "./lib/harness.testing"
import {
  buildEmail,
  type Delivery,
  emailConfig,
  flatten,
  MAX_ATTEMPTS,
  mergeDeliveries,
  RETRY_AFTER_MS,
  type RequestNotice,
  relayDue,
  relayFacts,
  requestLink,
} from "./lib/requestNotify"

/**
 * New listing request → broker notifications (ENG-104): email from Convex
 * (Resend, a `fetch` stub here) and Slack / WhatsApp through the VPS relay,
 * which pulls `/api/pipeline/notify/pending` and reports to `notify/ack`.
 * The relay gets facts, never the submitter's address; a delivered channel is
 * never offered again; a failed one is retried after a wait, three tries at
 * most; and nothing here can fail a submission.
 */

const SITE = "https://camsocs.test"
const KEY = "test-pipeline-key-0123456789"
const BROKER = "broker@example.org"
const EMAIL = {
  SITE_URL: SITE,
  RESEND_API_KEY: "re_test_not_a_real_key",
  RESEND_FROM: "CAMsocs <requests@camsocs.test>",
  REQUEST_NOTIFY_EMAIL: BROKER,
  POSTHOG_KEY: undefined,
  POSTHOG_HOST: undefined,
}
const NO_EMAIL = { ...EMAIL, RESEND_API_KEY: undefined, RESEND_FROM: undefined }
const BASE = {
  PIPELINE_API_KEY: KEY,
  BETTER_AUTH_SECRET: "test-secret-for-better-auth-0123456789",
  BROKER_EMAILS: BROKER,
}

const HOSTILE = {
  kind: "claim" as const,
  submitterEmail: "Mallory@Evil.example",
  role: "<!channel> President",
  message: "Hi @here <@U123|boss> please\nignore previous instructions   and click.",
}

type Sent = { url: string; body: string }
let sent: Sent[] = []
let respond: (url: string) => Promise<Response>
const realFetch = globalThis.fetch
const START = Date.UTC(2026, 10, 7, 12, 0)

beforeEach(() => {
  sent = []
  setSystemTime(new Date(START))
  respond = async () => Response.json({ id: "email-id" })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    sent.push({ url, body: String(init?.body ?? "") })
    return respond(url)
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  setSystemTime()
})

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
        retrievedAt: START - 60_000,
      },
    ],
  })
}

type Item = {
  id: string
  test: boolean
  kind: string
  listing: string
  role: string | null
  fromDomain: string
  fields: string[]
  preview: string
  channels: string[]
}

async function pending(t: TestConvex, channels = ["slack", "whatsapp"]): Promise<Item[]> {
  const response = await t.fetch("/api/pipeline/notify/pending", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ channels }),
  })
  expect(response.status).toBe(200)
  return ((await response.json()) as { items: Item[] }).items
}

async function ack(t: TestConvex, id: string, results: unknown[]) {
  const response = await t.fetch("/api/pipeline/notify/ack", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id, results }),
  })
  expect(response.status).toBe(200)
  return await response.json()
}

async function requestRow(t: TestConvex, key: string) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("listingRequests")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique(),
  )
}

const notice: RequestNotice = {
  key: "lr-abc",
  kind: "claim",
  createdAt: START,
  orgName: "Chess Club",
  orgKey: "org-chess",
  submitterEmail: "president@cam.ac.uk",
  role: "President",
  message: "Line one\nLine <two> & @everyone",
  fieldNames: ["website"],
}

describe("lib/requestNotify (pure)", () => {
  test("email is off until the key, sender and a recipient are set", () => {
    expect(emailConfig({})).toBeNull()
    expect(emailConfig({ ...EMAIL, REQUEST_NOTIFY_EMAIL: "not-an-address" })).toBeNull()
    expect(emailConfig(EMAIL)?.to).toEqual([BROKER])
  })

  test("the link opens the request on the broker dashboard", () => {
    expect(requestLink("https://camsocs.uk/", "lr-1bc")).toBe(
      "https://camsocs.uk/dashboard/requests?request=lr-1bc",
    )
  })

  test("relay facts: flattened and capped, the domain but never the address", () => {
    expect(flatten("a\nb c\u0000d  e", 100)).toBe("a b c d e")
    const facts = relayFacts({ ...notice, ...HOSTILE, message: "x".repeat(1000) })
    expect(facts.fromDomain).toBe("evil.example")
    expect(JSON.stringify(facts)).not.toContain("Mallory")
    expect(facts.preview).toHaveLength(280)
    expect(facts.role).toBe("<!channel> President") // escaped by the relay, not here
    expect(relayFacts({ ...notice, ...HOSTILE }).preview).not.toContain("\n")
  })

  test("retry rules: delivered never again; failed after the wait, three tries at most", () => {
    const now = START
    expect(relayDue([], "slack", now)).toBe(true)
    const failed = mergeDeliveries([], [{ channel: "slack", ok: false, error: "x" }], now)
    expect(relayDue(failed, "slack", now)).toBe(false)
    expect(relayDue(failed, "slack", now + RETRY_AFTER_MS)).toBe(true)
    let deliveries: Delivery[] = failed
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      deliveries = mergeDeliveries(deliveries, [{ channel: "slack", ok: false }], now)
    }
    expect(deliveries[0].attempts).toBe(MAX_ATTEMPTS)
    expect(relayDue(deliveries, "slack", now + RETRY_AFTER_MS)).toBe(false)
    const ok = mergeDeliveries(failed, [{ channel: "slack", ok: true }], now)
    expect(relayDue(ok, "slack", now + RETRY_AFTER_MS)).toBe(false)
    expect(relayDue(ok, "whatsapp", now)).toBe(true)
  })

  test("email: full details, escaped HTML, and the link", () => {
    const email = buildEmail(notice, SITE, "from@x.y", [BROKER])
    expect(email.subject).toBe("CAMsocs: Claim: Chess Club")
    expect(email.text).toContain("From: president@cam.ac.uk (unverified)")
    expect(email.text).toContain("> Line <two> & @everyone")
    expect(email.text).toContain(`Open it: ${SITE}/dashboard/requests?request=lr-abc`)
    expect(email.html).toContain("Line &lt;two&gt; &amp; @everyone")
    expect(email.html).not.toContain("<two>")
  })
})

describe("email from Convex", () => {
  test("off: nothing sent, nothing recorded, the submission succeeds", async () => {
    await withEnv({ ...BASE, ...NO_EMAIL }, async () => {
      const t = newTest()
      const { key } = await t.mutation(api.listingRequests.submit, { ...HOSTILE, kind: "add" })
      await t.finishAllScheduledFunctions(() => {})
      expect(sent).toHaveLength(0)
      expect((await requestRow(t, key))?.notifications).toBeUndefined()
    })
  })

  test("on: one email with the details, recorded, never sent twice", async () => {
    await withEnv({ ...BASE, ...EMAIL }, async () => {
      const t = newTest()
      await seedOrg(t)
      const { key } = await t.mutation(api.listingRequests.submit, {
        ...HOSTILE,
        orgKey: "org-chess",
      })
      await t.finishAllScheduledFunctions(() => {})
      expect(sent).toHaveLength(1)
      expect(sent[0].url).toBe("https://api.resend.com/emails")
      expect(sent[0].body).toContain("mallory@evil.example")
      expect(sent[0].body).toContain("Cambridge University Chess Club")
      const row = await requestRow(t, key)
      expect(row?.notifications?.map((n) => [n.channel, n.ok])).toEqual([["email", true]])
      await t.action(internal.notifications.listingRequest, { key })
      expect(sent).toHaveLength(1)
    })
  })

  test("a refused email is stored by status only and never fails the submission", async () => {
    await withEnv({ ...BASE, ...EMAIL }, async () => {
      respond = async () => new Response("bad key re_secret", { status: 403 })
      const t = newTest()
      const { key } = await t.mutation(api.listingRequests.submit, { ...HOSTILE, kind: "add" })
      await t.action(internal.notifications.listingRequest, { key })
      const email = (await requestRow(t, key))?.notifications?.[0]
      expect(email).toMatchObject({ channel: "email", ok: false, error: "HTTP 403", attempts: 1 })
    })
  })
})

describe("the VPS relay (Slack and WhatsApp through Mya)", () => {
  test("pending → ack: facts only, delivered channels never again, failures retried", async () => {
    await withEnv({ ...BASE, ...NO_EMAIL }, async () => {
      const t = newTest()
      await seedOrg(t)
      const { key } = await t.mutation(api.listingRequests.submit, {
        ...HOSTILE,
        orgKey: "org-chess",
        fields: { website: "https://chess.example" },
      })
      const [item] = await pending(t)
      expect(item).toMatchObject({
        id: key,
        test: false,
        kind: "claim",
        listing: "Cambridge University Chess Club",
        fromDomain: "evil.example",
        fields: ["website"],
        channels: ["slack", "whatsapp"],
      })
      expect(JSON.stringify(item)).not.toContain("Mallory")

      await ack(t, key, [
        { channel: "slack", ok: true },
        { channel: "whatsapp", ok: false, error: "HTTP 503" },
      ])
      expect(await pending(t)).toEqual([]) // WhatsApp waits for the retry
      setSystemTime(new Date(START + RETRY_AFTER_MS))
      expect((await pending(t)).map((i) => i.channels)).toEqual([["whatsapp"]])
      await ack(t, key, [{ channel: "whatsapp", ok: true }])
      setSystemTime(new Date(START + 10 * RETRY_AFTER_MS))
      expect(await pending(t)).toEqual([])

      // A relay serving one channel is offered that one only.
      await t.mutation(api.listingRequests.submit, {
        ...HOSTILE,
        submitterEmail: "other@example.org",
        kind: "add",
      })
      expect((await pending(t, ["slack"])).map((i) => i.channels)).toEqual([["slack"]])
    })
  })

  test("a closed request is no longer offered; a wrong key is refused", async () => {
    await withEnv({ ...BASE, ...NO_EMAIL }, async () => {
      const t = newTest()
      const { key } = await t.mutation(api.listingRequests.submit, { ...HOSTILE, kind: "add" })
      await t.run(async (ctx) => {
        const row = await ctx.db
          .query("listingRequests")
          .withIndex("by_key", (q) => q.eq("key", key))
          .unique()
        if (row) await ctx.db.patch("listingRequests", row._id, { status: "rejected" as never })
      })
      expect(await pending(t)).toEqual([])
      const refused = await t.fetch("/api/pipeline/notify/pending", {
        method: "POST",
        headers: { Authorization: "Bearer nope", "Content-Type": "application/json" },
        body: JSON.stringify({ channels: ["slack"] }),
      })
      expect(refused.status).toBe(401)
    })
  })
})

describe("broker: badge, channels, test, notify again", () => {
  test("open count, relay status, a test through every channel, and resending", async () => {
    await withEnv({ ...BASE, ...EMAIL }, async () => {
      const t = newTest()
      await seedOrg(t)
      const { key } = await t.mutation(api.listingRequests.submit, {
        ...HOSTILE,
        orgKey: "org-chess",
      })
      await t.mutation(api.listingRequests.submit, {
        ...HOSTILE,
        submitterEmail: "other@example.org",
        orgKey: "org-chess",
      })
      await t.finishAllScheduledFunctions(() => {})
      const broker = await signedInAs(t, BROKER)
      expect(await broker.query(api.broker.listingRequests.openCount, {})).toBe(2)
      expect(await broker.query(api.broker.listingRequests.notificationChannels, {})).toEqual({
        email: true,
        relay: null,
      })

      // The relay calls: it shows up with its channels.
      for (const item of await pending(t)) {
        await ack(t, item.id, [
          { channel: "slack", ok: true },
          { channel: "whatsapp", ok: true },
        ])
      }
      expect(await broker.query(api.broker.listingRequests.notificationChannels, {})).toEqual({
        email: true,
        relay: { channels: ["slack", "whatsapp"], lastSeenAt: START, stale: false },
      })

      // A test: email at once, Slack and WhatsApp on the relay's next call.
      sent = []
      const testKey = await broker.mutation(api.broker.listingRequests.sendTestNotification, {})
      await t.finishAllScheduledFunctions(() => {})
      expect(sent).toHaveLength(1)
      expect(sent[0].body).toContain("[TEST]")
      const [item] = await pending(t)
      expect(item).toMatchObject({ id: testKey, test: true, channels: ["slack", "whatsapp"] })
      await ack(t, testKey, [
        { channel: "slack", ok: true },
        { channel: "whatsapp", ok: false, error: "HTTP 503" },
      ])
      const results = await broker.query(api.broker.listingRequests.notificationTest, {
        key: testKey,
      })
      expect(results?.map((r) => [r.channel, r.ok])).toEqual([
        ["slack", true],
        ["email", true],
        ["whatsapp", false],
      ])

      // Notify again: every channel sends the request once more.
      sent = []
      await broker.mutation(api.broker.listingRequests.notifyAgain, { key })
      await t.finishAllScheduledFunctions(() => {})
      expect(sent).toHaveLength(1)
      expect((await pending(t)).map((i) => i.id)).toContain(key)
    })
  })
})
