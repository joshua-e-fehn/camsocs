import { afterEach, describe, expect, test } from "bun:test"
import { bytesToBase64 } from "../lib/inbound-email"
import { internal } from "./_generated/api"
import { newTest, type TestConvex, withEnv } from "./lib/harness.testing"

/**
 * `POST /api/inbound/email` (both senders), `/api/pipeline/inbound/file` and
 * `/api/pipeline/worklist`, through the real router (`t.fetch`). Resend's API
 * is replaced by a stub of `globalThis.fetch`; `t.fetch` does not use it.
 */

const PIPELINE_KEY = "test-pipeline-key-0123456789"
const INBOUND_SECRET = "test-inbound-secret-0123456789"
// base64 of 24 bytes, as Resend's `whsec_…` secrets are.
const WEBHOOK_SECRET = `whsec_${btoa("0123456789abcdef01234567")}`
const ENV = {
  PIPELINE_API_KEY: PIPELINE_KEY,
  INBOUND_EMAIL_SECRET: INBOUND_SECRET,
  RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET,
  RESEND_API_KEY: "re_test_key",
  INBOUND_EMAIL_RECIPIENTS: undefined,
  BETTER_AUTH_SECRET: "test-secret-for-better-auth-0123456789",
}

// A 1×1 PNG.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="

const GENERIC = {
  messageId: "<weekly-1@lists.cam.ac.uk>",
  from: '"ZZ Test Society" <events@zz-test.example.org>',
  to: ["inbox@in.example.org"],
  subject: "This week at ZZ",
  text: "Pub quiz on Wednesday of Week 3 at 7pm in the Old Library.",
  html: "<p>Pub quiz on <b>Wednesday of Week 3</b> at 7pm in the Old Library.</p>",
  headers: { "List-Id": '"ZZ Test" <soc-zztest.lists.cam.ac.uk>' },
  attachments: [{ filename: "termcard.png", contentType: "image/png", contentBase64: PNG }],
}

function postGeneric(t: TestConvex, body: unknown, secret = INBOUND_SECRET) {
  return t.fetch("/api/inbound/email", {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function svixSign(secret: string, id: string, timestamp: string, body: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(atob(secret.slice("whsec_".length)), (char) => char.charCodeAt(0)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`),
  )
  return `v1,${bytesToBase64(new Uint8Array(signature))}`
}

async function postResend(t: TestConvex, event: unknown, options: { secret?: string } = {}) {
  const body = JSON.stringify(event)
  const id = "msg_test_1"
  const timestamp = String(Math.floor(Date.now() / 1000))
  return t.fetch("/api/inbound/email", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": await svixSign(options.secret ?? WEBHOOK_SECRET, id, timestamp, body),
    },
    body,
  })
}

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function stubResend(routes: Record<string, () => Response>, calls: string[] = []) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    calls.push(url)
    const route = routes[url]
    if (!route) throw new Error(`unexpected fetch ${url}`)
    return route()
  }) as typeof fetch
}

async function inbox(t: TestConvex) {
  return await t.run(async (ctx) => await ctx.db.query("inboundEmails").take(50))
}

describe("POST /api/inbound/email — provider-agnostic JSON", () => {
  test("stores the mail as pending with its HTML and kept attachments, once", async () => {
    await withEnv(ENV, async () => {
      const t = newTest()
      const first = await postGeneric(t, GENERIC)
      expect(first.status).toBe(200)
      expect(await first.json()).toEqual({ stored: true })
      const again = await postGeneric(t, GENERIC)
      expect(await again.json()).toEqual({ duplicate: true })

      const rows = await inbox(t)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        messageId: GENERIC.messageId,
        listId: "soc-zztest.lists.cam.ac.uk",
        listName: "ZZ Test",
        subject: GENERIC.subject,
        text: GENERIC.text,
        extraction: "pending",
        extractedEventKeys: [],
      })
      expect(rows[0].htmlStorageId).toBeDefined()
      expect(rows[0].attachments).toMatchObject([
        { filename: "termcard.png", contentType: "image/png" },
      ])
      // The duplicate's uploads were removed: one HTML body + one attachment.
      const files = await t.run(async (ctx) => await ctx.db.system.query("_storage").take(50))
      expect(files).toHaveLength(2)
    })
  })

  test("denies a wrong secret, and everyone when INBOUND_EMAIL_SECRET is unset", async () => {
    await withEnv(ENV, async () => {
      const t = newTest()
      expect((await postGeneric(t, GENERIC, "wrong")).status).toBe(401)
      expect(await inbox(t)).toHaveLength(0)
    })
    await withEnv({ ...ENV, INBOUND_EMAIL_SECRET: undefined }, async () => {
      const t = newTest()
      expect((await postGeneric(t, GENERIC, "")).status).toBe(401)
      expect((await postGeneric(t, GENERIC, INBOUND_SECRET)).status).toBe(401)
    })
  })

  test("the pipeline key does not open the inbound route", async () => {
    await withEnv(ENV, async () => {
      expect((await postGeneric(newTest(), GENERIC, PIPELINE_KEY)).status).toBe(401)
    })
  })

  test("400 for a malformed body; recipients filter when configured", async () => {
    await withEnv(ENV, async () => {
      const t = newTest()
      expect((await postGeneric(t, { ...GENERIC, messageId: undefined })).status).toBe(400)
    })
    await withEnv({ ...ENV, INBOUND_EMAIL_RECIPIENTS: "secret-7f@in.example.org" }, async () => {
      const t = newTest()
      const response = await postGeneric(t, GENERIC)
      expect(await response.json()).toEqual({ ignored: "recipient" })
      expect(await inbox(t)).toHaveLength(0)
      const addressed = await postGeneric(t, { ...GENERIC, to: ["Secret-7F@in.example.org"] })
      expect(await addressed.json()).toEqual({ stored: true })
    })
  })

  test("413 for a declared body over the limit", async () => {
    await withEnv(ENV, async () => {
      const response = await newTest().fetch("/api/inbound/email", {
        method: "POST",
        headers: { Authorization: `Bearer ${INBOUND_SECRET}`, "Content-Length": "999999999" },
        body: "{}",
      })
      expect(response.status).toBe(413)
    })
  })
})

describe("POST /api/inbound/email — Resend", () => {
  const EMAIL_ID = "56761188-7520-42d8-8898-ff6fc54ce618"
  const event = {
    type: "email.received",
    created_at: "2026-10-07T11:00:00.000Z",
    data: {
      email_id: EMAIL_ID,
      created_at: "2026-10-07T11:00:00.000Z",
      from: "sender@example.org",
      to: ["inbox@in.example.org"],
      message_id: "<resend-1@example.org>",
      subject: "Weekly",
      attachments: [{ id: "a1", filename: "poster.png", content_type: "image/png" }],
    },
  }
  const routes = {
    [`https://api.resend.com/emails/receiving/${EMAIL_ID}?html_format=cid`]: () =>
      Response.json({
        html: "<p>Talk on Thursday</p>",
        text: "Talk on Thursday",
        headers: { "list-id": "<soc-zz.lists.cam.ac.uk>", from: '"ZZ" <sender@example.org>' },
      }),
    [`https://api.resend.com/emails/receiving/${EMAIL_ID}/attachments`]: () =>
      Response.json({
        data: [
          {
            filename: "poster.png",
            size: 68,
            content_type: "image/png",
            download_url: "https://inbound-cdn.resend.com/a1",
          },
        ],
      }),
    "https://inbound-cdn.resend.com/a1": () =>
      new Response(Uint8Array.from(atob(PNG), (char) => char.charCodeAt(0))),
  }

  test("a signed email.received is fetched from the Receiving API and stored", async () => {
    await withEnv(ENV, async () => {
      const calls: string[] = []
      stubResend(routes, calls)
      const t = newTest()
      const response = await postResend(t, event)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ stored: true })
      const rows = await inbox(t)
      expect(rows[0]).toMatchObject({
        messageId: "<resend-1@example.org>",
        from: '"ZZ" <sender@example.org>',
        listId: "soc-zz.lists.cam.ac.uk",
        text: "Talk on Thursday",
      })
      expect(rows[0].attachments).toHaveLength(1)
      // A retry is acknowledged without calling Resend again.
      const retry = await postResend(t, event)
      expect(await retry.json()).toEqual({ duplicate: true })
      expect(calls).toHaveLength(3)
    })
  })

  test("a bad signature or unset secret is 401 and never reaches Resend", async () => {
    await withEnv(ENV, async () => {
      stubResend({})
      const t = newTest()
      const forged = await postResend(t, event, {
        secret: `whsec_${btoa("another-secret-entirely!")}`,
      })
      expect(forged.status).toBe(401)
    })
    await withEnv({ ...ENV, RESEND_WEBHOOK_SECRET: undefined }, async () => {
      stubResend({})
      expect((await postResend(newTest(), event)).status).toBe(401)
    })
  })

  test("other event types are acknowledged and ignored", async () => {
    await withEnv(ENV, async () => {
      stubResend({})
      const response = await postResend(newTest(), { ...event, type: "email.delivered" })
      expect(await response.json()).toEqual({ ignored: "event type" })
    })
  })

  test("503 without an API key and 502 when Resend fails, so Resend retries", async () => {
    await withEnv({ ...ENV, RESEND_API_KEY: undefined }, async () => {
      stubResend({})
      expect((await postResend(newTest(), event)).status).toBe(503)
    })
    await withEnv(ENV, async () => {
      stubResend({
        [`https://api.resend.com/emails/receiving/${EMAIL_ID}?html_format=cid`]: () =>
          new Response("down", { status: 500 }),
      })
      const t = newTest()
      expect((await postResend(t, event)).status).toBe(502)
      expect(await inbox(t)).toHaveLength(0)
    })
  })
})

describe("POST /api/pipeline/inbound/file", () => {
  function postFile(t: TestConvex, body: unknown, key = PIPELINE_KEY) {
    return t.fetch("/api/pipeline/inbound/file", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  }

  test("serves a mail's own attachment to the pipeline key only", async () => {
    await withEnv(ENV, async () => {
      const t = newTest()
      await postGeneric(t, GENERIC)
      const [row] = await inbox(t)
      const storageId = row.attachments[0].storageId
      const response = await postFile(t, { messageId: GENERIC.messageId, storageId })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        data: PNG,
        contentType: "image/png",
        filename: "termcard.png",
      })
      expect((await postFile(t, { messageId: GENERIC.messageId, storageId }, "x")).status).toBe(401)
      // Another mail's id does not unlock this file.
      expect((await postFile(t, { messageId: "<other@x>", storageId })).status).toBe(404)
    })
  })
})

describe("POST /api/pipeline/worklist", () => {
  test("pages organisations with their mailing list, feeds and upcoming event sources", async () => {
    await withEnv(ENV, async () => {
      const t = newTest()
      const claim = (entityKey: string, field: string, value: unknown) => ({
        entityType: "organisation" as const,
        entityKey,
        field,
        value,
        evidence: "primary" as const,
        method: "parser" as const,
        extractor: "test",
        sourceKey: "src-x",
        sourceUrl: "https://example.org/",
        sourceType: "society_website" as const,
        retrievedAt: Date.now() - 1_000,
      })
      await t.mutation(internal.ingest.claims.ingest, {
        claims: [
          claim("org-zz-alpha", "name", "ZZ Alpha Society"),
          claim("org-zz-alpha", "mailingList", {
            platform: "sympa",
            signupUrl: "https://lists.cam.ac.uk/sympa/info/soc-zzalpha",
          }),
          claim("org-zz-beta", "name", "ZZ Beta Society"),
        ],
      })
      await t.mutation(internal.ingest.orgInternal.patch, {
        patches: [
          { orgKey: "org-zz-beta", sympaList: "soc-zzbeta", icsUrls: ["https://x.org/a.ics"] },
        ],
      })
      const response = await t.fetch("/api/pipeline/worklist", {
        method: "POST",
        headers: { Authorization: `Bearer ${PIPELINE_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ paginationOpts: { numItems: 50, cursor: null } }),
      })
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.isDone).toBe(true)
      const byKey = Object.fromEntries(
        (body.page as { key: string }[]).map((row) => [row.key, row]),
      )
      expect(byKey["org-zz-alpha"]).toMatchObject({
        name: "ZZ Alpha Society",
        mailingList: { platform: "sympa" },
        feeds: [],
        upcomingEventSources: [],
      })
      expect(byKey["org-zz-beta"]).toMatchObject({ sympaList: "soc-zzbeta", feeds: ["ics"] })
    })
  })
})
