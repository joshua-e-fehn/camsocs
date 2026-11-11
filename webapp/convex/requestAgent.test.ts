import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { api, internal } from "./_generated/api"
import { newTest, signedInAs, type TestConvex, withEnv } from "./lib/harness.testing"
import {
  type AgentReply,
  buildDraft,
  DRAFT_RETRY_AFTER_MS,
  eventsSourceFrom,
  JOB_STALE_MS,
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
        promptVersion: "request_draft_v2",
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

/**
 * ENG-158: a request that says where the society lists its events becomes a
 * plan. The draft names the events page, the agent's site check shows what
 * the scraper would find, the confirm keeps the website for the scraper and
 * queues a job, and the job's outcome is on the request.
 */
describe("the events page of a request (ENG-158)", () => {
  const EVENTS = "https://www.quokkas.example.org/events"
  const MESSAGE = `Can we publicise our events on your page? They are on ${EVENTS}`
  const PLAN: AgentReply = {
    summary: "The president asks for the society's events to be listed.",
    action: "corrections",
    corrections: [],
    removal: null,
    concerns: [],
    reply: "Thank you. Your events now appear on CAMsocs.",
    eventsUrl: EVENTS,
  }
  const context = {
    kind: "claim",
    addresses: {},
    requestText: MESSAGE,
    message: MESSAGE,
    current: () => undefined,
  }

  test("the link must be the request's; the home page is derived by code", () => {
    expect(eventsSourceFrom(EVENTS, MESSAGE)).toEqual({
      source: { url: EVENTS, website: "https://www.quokkas.example.org/" },
    })
    expect(eventsSourceFrom("", MESSAGE)).toBeNull()
    expect(eventsSourceFrom(undefined, MESSAGE)).toBeNull()
    const invented = eventsSourceFrom("https://made-up.example.org/events", MESSAGE)
    expect(invented && "refused" in invented).toBe(true)
    // The link is the request's own whole link, not a tail or head of another.
    for (const [link, text] of [
      ["https://evil.org/events", "see https://notevil.org/events"],
      ["https://quokkas.example.org/events", "see https://quokkas.example.org/events-archive"],
      ["https://quokkas.example.org/events", "write to me@quokkas.example.org/events"],
    ]) {
      const found = eventsSourceFrom(link, text)
      expect(found && "refused" in found).toBe(true)
    }
    for (const refused of [
      "http:evil.org",
      "http:\\\\evil.org/events",
      "https://quokkas.example.org:8443/events",
      "https://talks.cam.ac.uk./show/index/1",
      "https://93.184.216.34/events",
      "javascript:alert(1)",
      "not a link",
      "https://www.instagram.com/quokkas",
      "https://talks.cam.ac.uk/show/index/1",
      "https://user:pw@quokkas.example.org/events",
    ]) {
      const found = eventsSourceFrom(refused, `${MESSAGE} ${refused}`)
      expect(found && "refused" in found).toBe(true)
    }

    const draft = buildDraft(PLAN, context)
    expect(draft.eventsSource).toEqual({
      url: EVENTS,
      website: "https://www.quokkas.example.org/",
    })
    // The listing shows no website on that host: the home page is proposed.
    expect(draft.corrections).toEqual([
      {
        field: "website",
        text: "https://www.quokkas.example.org/",
        reason: "the home page of the events link in the request",
      },
    ])
    // It already shows that site: nothing to correct, the plan stays.
    const same = buildDraft(PLAN, { ...context, current: () => "https://quokkas.example.org" })
    expect(same.corrections).toEqual([])
    expect(same.eventsSource?.url).toBe(EVENTS)
    // A removal has no events page; a platform is refused with the reason.
    expect(buildDraft(PLAN, { ...context, kind: "remove" }).eventsSource).toBeUndefined()
    const platform = "https://www.eventbrite.co.uk/o/quokkas-123"
    const refused = buildDraft(
      { ...PLAN, eventsUrl: platform },
      { ...context, requestText: platform },
    )
    expect(refused.eventsSource).toBeUndefined()
    expect(refused.dropped[0].field).toBe("events page")
  })

  test("check, confirm, job and result, end to end", async () => {
    await withEnv(ENV, async () => {
      const t = newTest()
      await seedOrg(t)
      const key = await insertRequest(t, { kind: "claim", message: MESSAGE, fields: {} })
      await post(t, "requests/draft", { key, ok: true, reply: PLAN })
      const draft = (await row(t, key))?.draft
      expect(draft?.eventsSource).toEqual({
        url: EVENTS,
        website: "https://www.quokkas.example.org/",
      })
      expect(draft?.corrections?.map((c) => [c.field, c.text])).toEqual([
        ["website", "https://www.quokkas.example.org/"],
      ])

      // The agent is offered the site to read, once.
      const work = await post(t, "requests/pending", {})
      expect(work.items).toEqual([])
      expect(work.checks).toEqual([
        {
          key,
          orgKey: "org-chess",
          name: "Cambridge University Chess Club",
          aliases: [],
          website: "https://www.quokkas.example.org/",
          eventsUrl: EVENTS,
          socials: [],
        },
      ])
      // A check of another site (the draft changed meanwhile) is not kept.
      expect(
        (await post(t, "requests/check", { key, website: "https://other.example.org/", ok: true }))
          .ok,
      ).toBe(false)
      await post(t, "requests/check", {
        key,
        website: "https://www.quokkas.example.org/",
        ok: true,
        ownSite: true,
        tiedBy: "links the listing's instagram.com account",
        pages: 1,
        eventCount: 1,
        events: [{ title: "  Quokka   Quiz ", startsAt: START + 86_400_000, venue: "Old Library" }],
        notes: [],
      })
      const check = (await row(t, key))?.draft?.eventsSource?.check
      expect(check).toMatchObject({ state: "ok", attempts: 1, ownSite: true, eventCount: 1 })
      expect(check?.events?.[0].title).toBe("Quokka Quiz")
      expect((await post(t, "requests/pending", {})).checks).toEqual([])

      // Nothing is queued or kept before the broker confirms.
      expect((await post(t, "requests/jobs/next", { claim: false })).job).toBeNull()
      expect((await post(t, "requests/websites", {})).websites).toEqual([])

      const broker = await signedInAs(t, BROKER)
      await broker.mutation(api.broker.listingRequests.acceptCorrections, {
        key,
        corrections: [{ field: "website", value: "https://www.quokkas.example.org/" }],
        readEvents: true,
      })
      // In progress, not accepted: it stays on the inbox until it is closed.
      const accepted = await row(t, key)
      expect(accepted?.status).toBe("in_progress")
      expect(accepted?.resolvedAt).toBeUndefined()
      const inbox = await broker.query(api.broker.listingRequests.list, { active: true })
      expect(inbox.map((item) => [item.key, item.status])).toEqual([[key, "in_progress"]])
      expect(await broker.query(api.broker.listingRequests.openCount, {})).toBe(1)
      expect(await broker.query(api.broker.listingRequests.list, { status: "open" })).toEqual([])
      expect(accepted?.outcome?.eventsWebsite).toBe("https://www.quokkas.example.org/")
      expect(accepted?.job).toMatchObject({ state: "queued", attempts: 0 })
      expect((await post(t, "requests/websites", {})).websites).toEqual([
        { orgKey: "org-chess", url: "https://www.quokkas.example.org/", eventsUrl: EVENTS },
      ])

      // Peeking counts no try; claiming does.
      const job = { key, orgKey: "org-chess", website: "https://www.quokkas.example.org/" }
      expect((await post(t, "requests/jobs/next", { claim: false })).job).toEqual(job)
      expect((await row(t, key))?.job?.state).toBe("queued")
      expect((await post(t, "requests/jobs/next", { claim: true })).job).toEqual(job)
      expect((await row(t, key))?.job).toMatchObject({ state: "running", attempts: 1 })
      expect((await post(t, "requests/jobs/next", { claim: true })).job).toBeNull()
      // A second confirm, of this or another request for the listing, cannot
      // replace a job that is under way.
      const second = await insertRequest(t, {
        key: "lr-eeeeeeeeeeeeeeeeeeee",
        kind: "claim",
        message: MESSAGE,
        fields: {},
      })
      await expect(
        broker.mutation(api.broker.listingRequests.acceptCorrections, {
          key: second,
          corrections: [],
          readEvents: true,
        }),
      ).rejects.toThrow()
      await expect(
        broker.mutation(api.broker.listingRequests.acceptCorrections, {
          key,
          corrections: [],
          readEvents: true,
        }),
      ).rejects.toThrow()

      // A failed run is queued again; the third failure is final.
      await post(t, "requests/job", { key, ok: false, error: "stage load failed <x>" })
      expect((await row(t, key))?.job).toMatchObject({
        state: "queued",
        error: "stage load failed x",
      })
      await post(t, "requests/jobs/next", { claim: true })
      await post(t, "requests/job", {
        key,
        ok: true,
        eventCount: 1,
        events: [{ title: "Quokka Quiz", startsAt: START + 86_400_000 }],
      })
      const done = (await row(t, key))?.job
      // The run staged one event; the result is what the listing shows (the
      // test loads none, so none).
      expect(done).toMatchObject({ state: "done", attempts: 2, readCount: 1, eventCount: 0 })
      expect(done?.error).toBeUndefined()
      // The site read is the one the agent checked, and a second confirm
      // cannot replace a job that is under way.
      expect(done?.website).toBe("https://www.quokkas.example.org/")
      // A late report changes nothing.
      expect((await post(t, "requests/job", { key, ok: false, error: "late" })).ok).toBe(false)

      // Closing it is what moves it off the inbox, to Accepted.
      expect((await row(t, key))?.status).toBe("in_progress")
      await broker.mutation(api.broker.listingRequests.setStatus, { key, status: "accepted" })
      const closed = await row(t, key)
      expect(closed?.status).toBe("accepted")
      expect(closed?.resolvedAt).toBeDefined()
      // Only the other, still open, request is left on the inbox.
      const left = await broker.query(api.broker.listingRequests.list, { active: true })
      expect(left.map((item) => item.key)).toEqual([second])
      expect(await broker.query(api.broker.listingRequests.openCount, {})).toBe(1)
    })
  })

  test("a job that died is offered again, then given up; the broker can retry", async () => {
    await withEnv(ENV, async () => {
      const t = newTest()
      await seedOrg(t)
      const key = await insertRequest(t, { kind: "claim", message: MESSAGE, fields: {} })
      const broker = await signedInAs(t, BROKER)
      // The listing has a website already: reading its events is the whole plan.
      await broker.mutation(api.broker.listingRequests.acceptCorrections, {
        key,
        corrections: [],
        readEvents: true,
      })
      expect((await row(t, key))?.job?.website).toBe("https://chess.example.org/")
      for (let attempt = 1; attempt <= 3; attempt++) {
        expect((await post(t, "requests/jobs/next", { claim: true })).job).not.toBeNull()
        expect((await post(t, "requests/jobs/next", { claim: true })).job).toBeNull()
        setSystemTime(new Date(START + attempt * (JOB_STALE_MS + 1)))
      }
      expect((await post(t, "requests/jobs/next", { claim: true })).job).toBeNull()
      expect((await row(t, key))?.job).toMatchObject({ state: "failed", attempts: 3 })
      setSystemTime(new Date(START))
      await broker.mutation(api.broker.listingRequests.retryJob, { key })
      expect((await row(t, key))?.job).toMatchObject({ state: "queued", attempts: 0 })
      // A request confirmed before `in_progress` existed (accepted, its job
      // running) is put on the inbox by its job's report.
      await post(t, "requests/jobs/next", { claim: true })
      await t.run(async (ctx) => {
        const legacy = await ctx.db
          .query("listingRequests")
          .withIndex("by_key", (q) => q.eq("key", key))
          .unique()
        if (legacy) await ctx.db.patch("listingRequests", legacy._id, { status: "accepted" })
      })
      await post(t, "requests/job", { key, ok: true, eventCount: 0, events: [] })
      expect(await row(t, key)).toMatchObject({ status: "in_progress", job: { state: "done" } })

      // Without a website there is nothing to read; nothing is half applied.
      const other = await insertRequest(t, {
        key: "lr-ffffffffffffffffffff",
        kind: "claim",
        orgKey: "org-none",
        fields: {},
      })
      await expect(
        broker.mutation(api.broker.listingRequests.acceptCorrections, {
          key: other,
          corrections: [],
          readEvents: true,
        }),
      ).rejects.toThrow()
      expect((await row(t, other))?.status).toBe("open")
    })
  })
})
