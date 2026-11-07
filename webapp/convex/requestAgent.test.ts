import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { api, internal } from "./_generated/api"
import { newTest, signedInAs, type TestConvex, withEnv } from "./lib/harness.testing"
import {
  type AgentReply,
  buildDraft,
  DRAFT_RETRY_AFTER_MS,
  maskContacts,
  SENDER_TOKEN,
  senderChecks,
  unmask,
  unsupportedContacts,
} from "./lib/requestDraft"

/**
 * The request agent (ENG-126): the VPS pulls open requests, masked, from
 * `/api/pipeline/requests/pending` and posts the model's draft to
 * `requests/draft`; Convex checks every value and keeps only what the
 * request itself supports; the broker's dialog is pre-filled with it.
 */

const KEY = "test-pipeline-key-0123456789"
const BROKER = "broker@example.org"
const ENV = {
  PIPELINE_API_KEY: KEY,
  BETTER_AUTH_SECRET: "test-secret-for-better-auth-0123456789",
  BROKER_EMAILS: BROKER,
  RESEND_API_KEY: undefined,
  POSTHOG_KEY: undefined,
}
const START = Date.UTC(2026, 10, 7, 12, 0)

beforeEach(() => setSystemTime(new Date(START)))
afterEach(() => setSystemTime())

function claim(field: string, value: unknown) {
  return {
    entityType: "organisation" as const,
    entityKey: "org-chess",
    field,
    value,
    evidence: "primary" as const,
    method: "parser" as const,
    extractor: "test",
    sourceKey: "src-site",
    sourceUrl: "https://chess.example.org/",
    sourceType: "society_website" as const,
    retrievedAt: START - 60_000,
  }
}

async function seedOrg(t: TestConvex) {
  await t.mutation(internal.ingest.claims.ingest, {
    claims: [
      claim("name", "Cambridge University Chess Club"),
      claim("website", "https://chess.example.org/"),
      claim("email", "chess@cam.ac.uk"),
    ],
  })
}

async function insertRequest(
  t: TestConvex,
  extra: Partial<{
    key: string
    kind: "claim" | "correct" | "remove" | "object" | "add"
    orgKey: string
    message: string
    submitterEmail: string
    fields: Record<string, string>
    status: "open" | "accepted"
  }> = {},
) {
  const key = extra.key ?? "lr-0123456789abcdef0123"
  await t.run(async (ctx) => {
    await ctx.db.insert("listingRequests", {
      key,
      orgKey: "org-chess",
      kind: "correct",
      submitterEmail: "president@cam.ac.uk",
      role: "President",
      message:
        "Our new website is https://cuchess.org and the secretary is sec@cuchess.org, call 07700 900123.",
      fields: { website: "https://cuchess.org" },
      status: "open",
      createdAt: START - 60_000,
      ...extra,
    })
  })
  return key
}

async function post(t: TestConvex, path: string, body: unknown) {
  const response = await t.fetch(`/api/pipeline/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  expect(response.status).toBe(200)
  return (await response.json()) as Record<string, unknown>
}

async function row(t: TestConvex, key: string) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("listingRequests")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique(),
  )
}

const REPLY: AgentReply = {
  summary: "The president asks to change the website.",
  action: "corrections",
  corrections: [
    { field: "website", value: "https://cuchess.org", reason: "stated in the message" },
    { field: "email", value: "[email 1]", reason: "secretary's address" },
    { field: "joinUrl", value: "https://made-up.example/join" },
    { field: "level", value: "galactic" },
    { field: "logo", value: "x" },
  ],
  removal: null,
  concerns: ["  ", "The sender is not listed on the page."],
  reply: "Thanks, [sender]: done.",
}

describe("lib/requestDraft (pure)", () => {
  test("masking: one token per address, the sender's own, phones but not dates", () => {
    const masked = maskContacts(
      ["Write to A@x.org or me (Me@Cam.ac.uk) or a@x.org; 07700 900123 on 2026-11-07"],
      "me@cam.ac.uk",
    )
    expect(masked.texts[0]).toBe(
      "Write to [email 1] or me ([sender]) or [email 1]; [phone] on 2026-11-07",
    )
    expect(masked.addresses).toEqual({ [SENDER_TOKEN]: "me@cam.ac.uk", "[email 1]": "a@x.org" })
    expect(unmask("to [email 1], [email 9]", masked.addresses)).toBe("to a@x.org, [email 9]")
  })

  test("a link or address the request does not give is unsupported", () => {
    const text = "see www.cuchess.org/join or mail sec@cuchess.org"
    expect(unsupportedContacts("https://cuchess.org/join/", text)).toEqual([])
    expect(unsupportedContacts("https://evil.example/", text)).toEqual(["https://evil.example/"])
    expect(unsupportedContacts("sec@cuchess.org", text)).toEqual([])
    expect(unsupportedContacts("boss@cuchess.org", text)).toEqual(["boss@cuchess.org"])
  })

  test("sender checks come from rules", () => {
    const listing = { email: "chess@cam.ac.uk", website: "https://www.cuchess.org/" }
    expect(senderChecks("Chess@cam.ac.uk", listing)).toEqual({
      domain: "cam.ac.uk",
      cam: true,
      listed: true,
      siteDomain: false,
    })
    expect(senderChecks("x@cuchess.org", listing).siteDomain).toBe(true)
    expect(senderChecks("x@gmail.com", null)).toEqual({
      domain: "gmail.com",
      cam: false,
      listed: false,
      siteDomain: false,
    })
  })

  test("a draft keeps only checked values; a removal only what the request names", () => {
    const masked = maskContacts(["mail sec@cuchess.org, site https://cuchess.org"], "p@cam.ac.uk")
    const context = {
      kind: "correct",
      addresses: masked.addresses,
      requestText: "mail sec@cuchess.org, site https://cuchess.org",
      message: "mail sec@cuchess.org, site https://cuchess.org",
      current: (field: string) => (field === "website" ? "https://old.example/" : undefined),
    }
    const draft = buildDraft(REPLY, context)
    expect(draft.corrections).toEqual([
      {
        field: "website",
        text: "https://cuchess.org",
        current: "https://old.example/",
        reason: "stated in the message",
      },
      { field: "email", text: "sec@cuchess.org", reason: "secretary's address" },
    ])
    expect(draft.dropped.map((item) => item.field)).toEqual(["joinUrl", "level", "logo"])
    expect(draft.concerns).toEqual(["The sender is not listed on the page."])
    expect(draft.reply).toBe("Thanks, p@cam.ac.uk: done.")

    const same = buildDraft(REPLY, { ...context, current: () => "https://cuchess.org" })
    expect(same.dropped[0]).toEqual({ field: "website", reason: "the listing already shows this" })

    const removal = (proposal: AgentReply["removal"], message = "Please remove Jane Doe.") =>
      buildDraft(
        { ...REPLY, action: "removal", corrections: [], removal: proposal },
        { ...context, kind: "remove", message, requestText: message },
      )
    expect(removal({ scope: "organisation" }).removal).toEqual({ scope: "organisation" })
    expect(removal({ scope: "name", name: "Jane Doe" }).removal).toEqual({
      scope: "name",
      name: "Jane Doe",
    })
    expect(removal({ scope: "name", name: "John Roe" }).removal).toBeUndefined()
    expect(removal({ scope: "contact", address: "[email 1]" }).removal).toEqual({
      scope: "contact",
      address: "sec@cuchess.org",
    })
    expect(removal({ scope: "contact", address: "x@y.org" }).removal).toBeUndefined()
    expect(removal({ scope: "person" }).removal).toBeUndefined()
    expect(removal({ scope: "field", fields: ["email", "name"] }).removal).toEqual({
      scope: "field",
      fields: ["email"],
    })
    // A correction request never carries a removal, and the reverse.
    expect(buildDraft({ ...REPLY, removal: { scope: "organisation" } }, context).removal).toBe(
      undefined,
    )
    expect(removal(null).corrections).toEqual([])
  })
})

describe("the agent's routes", () => {
  test("pending: masked, with the listing as it stands; the call is a heartbeat", async () => {
    await withEnv(ENV, async () => {
      const t = newTest()
      await seedOrg(t)
      const key = await insertRequest(t)
      await insertRequest(t, { key: "lr-add", kind: "add" })
      await insertRequest(t, { key: "lr-done", status: "accepted" })
      const out = await post(t, "requests/pending", {})
      const items = out.items as Record<string, unknown>[]
      expect(items.map((item) => item.key)).toEqual([key])
      const item = items[0]
      expect(item.message).toBe(
        "Our new website is https://cuchess.org and the secretary is [email 1], call [phone].",
      )
      expect(JSON.stringify(item)).not.toContain("president@cam.ac.uk")
      expect(JSON.stringify(item)).not.toContain("sec@cuchess.org")
      expect(item.fromDomain).toBe("cam.ac.uk")
      expect(item.listing).toEqual({
        key: "org-chess",
        name: "Cambridge University Chess Club",
        current: {
          name: "Cambridge University Chess Club",
          website: "https://chess.example.org/",
          email: "[listed address]",
        },
      })
      expect((out.fieldGuide as unknown[]).length).toBeGreaterThan(10)
      const broker = await signedInAs(t, BROKER)
      const agent = await broker.query(api.broker.listingRequests.requestAgent, {})
      expect(agent).toEqual({ lastSeenAt: START, stale: false })
    })
  })

  test("draft: stored checked, offered no more; a failure is retried after the wait", async () => {
    await withEnv(ENV, async () => {
      const t = newTest()
      await seedOrg(t)
      const key = await insertRequest(t)
      await post(t, "requests/draft", { key, ok: false, error: "LLMValidationError: <x>" })
      expect((await row(t, key))?.draft).toMatchObject({
        state: "failed",
        attempts: 1,
        error: "LLMValidationError: x",
      })
      expect((await post(t, "requests/pending", {})).items).toEqual([])
      setSystemTime(new Date(START + DRAFT_RETRY_AFTER_MS))
      expect((await post(t, "requests/pending", {})).items).toHaveLength(1)

      await post(t, "requests/draft", {
        key,
        ok: true,
        model: "gpt-6.1-sol",
        promptVersion: "request_draft_v1",
        reply: REPLY,
      })
      const draft = (await row(t, key))?.draft
      expect(draft?.state).toBe("ready")
      expect(draft?.attempts).toBe(2)
      expect(draft?.checks).toEqual({
        domain: "cam.ac.uk",
        cam: true,
        listed: false,
        siteDomain: false,
      })
      expect(draft?.corrections?.map((c) => [c.field, c.text, c.current])).toEqual([
        ["website", "https://cuchess.org", "https://chess.example.org/"],
        ["email", "sec@cuchess.org", "chess@cam.ac.uk"],
      ])
      expect((await post(t, "requests/pending", {})).items).toEqual([])

      // The broker throws it away: drafted again.
      const broker = await signedInAs(t, BROKER)
      await broker.mutation(api.broker.listingRequests.redraft, { key })
      expect((await row(t, key))?.draft).toBeUndefined()
      expect((await post(t, "requests/pending", {})).items).toHaveLength(1)
    })
  })

  test("the confirm applies the draft through the usual acceptance", async () => {
    await withEnv(ENV, async () => {
      const t = newTest()
      await seedOrg(t)
      const key = await insertRequest(t)
      await post(t, "requests/draft", { key, ok: true, reply: REPLY })
      const broker = await signedInAs(t, BROKER)
      const draft = (await row(t, key))?.draft
      const result = await broker.mutation(api.broker.listingRequests.acceptCorrections, {
        key,
        corrections: (draft?.corrections ?? []).map((c) => ({ field: c.field, value: c.text })),
      })
      expect(result.appliedFields).toEqual(["website", "email"])
      const org = await t.run(async (ctx) =>
        ctx.db
          .query("organisations")
          .withIndex("by_key", (q) => q.eq("key", "org-chess"))
          .unique(),
      )
      expect(org?.website).toBe("https://cuchess.org")
      expect(org?.email).toBe("sec@cuchess.org")
      // Not open any more: a late draft is ignored.
      expect((await post(t, "requests/draft", { key, ok: true, reply: REPLY })).ok).toBe(false)
    })
  })

  test("both routes need the pipeline key; the broker functions need a broker", async () => {
    await withEnv(ENV, async () => {
      const t = newTest()
      const response = await t.fetch("/api/pipeline/requests/pending", {
        method: "POST",
        body: "{}",
      })
      expect(response.status).toBe(401)
      await expect(t.query(api.broker.listingRequests.requestAgent, {})).rejects.toThrow()
      await expect(
        t.mutation(api.broker.listingRequests.redraft, { key: "lr-x" }),
      ).rejects.toThrow()
    })
  })
})
