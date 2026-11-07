import { v } from "convex/values"
import { deploymentProfile } from "../lib/campus/deployment"
import { sha1Hex } from "../lib/hash"
import { internal } from "./_generated/api"
import type { Doc } from "./_generated/dataModel"
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server"
import {
  type Delivery,
  emailConfig,
  MAX_ATTEMPTS,
  mergeDeliveries,
  RELAY_CHANNELS,
  RELAY_WINDOW_MS,
  RETRY_AFTER_MS,
  type RelayChannel,
  type RequestNotice,
  relayDue,
  relayFacts,
  sendEmail,
} from "./lib/requestNotify"
import { literalUnion } from "./lib/validators"

/**
 * New listing request → the broker (ENG-104); lib/requestNotify.ts says what
 * goes where.
 *
 * **Email** (Convex → Resend): `listingRequests.submit` schedules
 * `listingRequest` with the insert, so a refused request never notifies and a
 * failure never fails the submission; a failed send is tried again after
 * `RETRY_AFTER_MS`, up to `MAX_ATTEMPTS` tries.
 *
 * **Slack and WhatsApp** (the VPS relay, through Mya): the relay calls
 * `relayPending` every minute with the channels it serves and gets the open
 * requests (and broker tests) still owed on one of them; it sends, then
 * reports each channel's outcome to `relayAck`. A channel that delivered is
 * never offered again; a failed one is offered again after `RETRY_AFTER_MS`,
 * up to `MAX_ATTEMPTS` tries. Outcomes are stored on the request
 * (`notifications`) and shown on its card.
 *
 * "Notify again" (`resend`) clears a request's outcomes, so every channel
 * sends it once more. "Send test notification" (`startTest`) stores a
 * synthetic request in `notificationTests` that goes the same ways.
 */

/** Items one relay call gets at most. */
const RELAY_BATCH = 10
/** Broker tests older than this are no longer offered. */
const TEST_WINDOW_MS = 60 * 60 * 1000
/** Test rows kept (the newest). */
const TESTS_KEPT = 20
const RELAY_NAME = "vps"

const channelValidator = literalUnion(["slack", "email", "whatsapp"] as const)
const relayChannelValidator = literalUnion(RELAY_CHANNELS)

function siteOrigin(): string {
  return (process.env.SITE_URL?.trim() || deploymentProfile().origin).replace(/\/+$/, "")
}

/** The synthetic request a broker's test sends. */
function testNotice(key: string, createdAt: number): RequestNotice {
  return {
    key,
    kind: "claim",
    createdAt,
    orgName: "Test Society (not a real request)",
    submitterEmail: "someone@example.org",
    role: "President",
    message: "This is a test notification sent from the broker dashboard. Nothing was submitted.",
    fieldNames: ["website"],
    test: true,
  }
}

async function requestNotice(
  ctx: { db: QueryCtx["db"] },
  row: Doc<"listingRequests">,
): Promise<RequestNotice> {
  const org = row.orgKey
    ? await ctx.db
        .query("organisations")
        .withIndex("by_key", (q) => q.eq("key", row.orgKey as string))
        .unique()
    : null
  return {
    key: row.key,
    kind: row.kind,
    createdAt: row.createdAt,
    orgName: org?.name,
    orgKey: row.orgKey,
    eventKey: row.eventKey,
    role: row.role,
    submitterEmail: row.submitterEmail,
    message: row.message,
    fieldNames: Object.keys(row.fields ?? {}),
  }
}

// --- lookups --------------------------------------------------------------------------

async function findRequest(ctx: { db: QueryCtx["db"] }, key: string) {
  return await ctx.db
    .query("listingRequests")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique()
}

async function findTest(ctx: { db: QueryCtx["db"] }, key: string) {
  return await ctx.db
    .query("notificationTests")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique()
}

// --- email (Convex → Resend) ------------------------------------------------------------

/** The notice for `key` (a request or a test) and its deliveries, or null. */
export const emailNotice = internalQuery({
  args: { key: v.string() },
  returns: v.union(
    v.null(),
    v.object({ notice: v.any(), delivered: v.boolean(), attempts: v.number() }),
  ),
  handler: async (ctx, { key }) => {
    let notice: RequestNotice
    let deliveries: Delivery[]
    if (key.startsWith("nt-")) {
      const test = await findTest(ctx, key)
      if (!test) return null
      notice = testNotice(test.key, test.createdAt)
      deliveries = test.notifications
    } else {
      const row = await findRequest(ctx, key)
      if (!row || row.purgedAt !== undefined) return null
      notice = await requestNotice(ctx, row)
      deliveries = row.notifications ?? []
    }
    const email = deliveries.find((d) => d.channel === "email")
    return { notice, delivered: email?.ok === true, attempts: email?.attempts ?? 0 }
  },
})

async function record(
  ctx: MutationCtx,
  key: string,
  results: { channel: "slack" | "email" | "whatsapp"; ok: boolean; error?: string }[],
): Promise<boolean> {
  const now = Date.now()
  if (key.startsWith("nt-")) {
    const test = await findTest(ctx, key)
    if (!test) return false
    await ctx.db.patch("notificationTests", test._id, {
      notifications: mergeDeliveries(test.notifications, results, now),
    })
    return true
  }
  const row = await findRequest(ctx, key)
  if (!row) return false
  await ctx.db.patch("listingRequests", row._id, {
    notifications: mergeDeliveries(row.notifications ?? [], results, now),
  })
  return true
}

const resultValidator = v.object({
  channel: channelValidator,
  ok: v.boolean(),
  error: v.optional(v.string()),
})

/** Stores channel outcomes on a request or test. */
export const recordResults = internalMutation({
  args: { key: v.string(), results: v.array(resultValidator) },
  returns: v.null(),
  handler: async (ctx, { key, results }) => {
    await record(ctx, key, results)
    return null
  },
})

/** Emails one request (or test), once: skipped when email is off or it
 * already went out. Retries itself after a failure. */
export const listingRequest = internalAction({
  args: { key: v.string() },
  returns: v.null(),
  handler: async (ctx, { key }) => {
    const config = emailConfig()
    if (!config) return null
    const found = await ctx.runQuery(internal.notifications.emailNotice, { key })
    if (!found || found.delivered || found.attempts >= MAX_ATTEMPTS) return null
    const result = await sendEmail(config, found.notice as RequestNotice, siteOrigin())
    if (!result) return null
    if (!result.ok) console.error(`Request notification: email failed (${result.error})`)
    await ctx.runMutation(internal.notifications.recordResults, { key, results: [result] })
    if (!result.ok && found.attempts + 1 < MAX_ATTEMPTS) {
      await ctx.scheduler.runAfter(RETRY_AFTER_MS, internal.notifications.listingRequest, { key })
    }
    return null
  },
})

// --- the VPS relay (Slack and WhatsApp through Mya) ------------------------------------

const relayItemValidator = v.object({
  id: v.string(),
  test: v.boolean(),
  kind: v.string(),
  listing: v.string(),
  role: v.union(v.null(), v.string()),
  fromDomain: v.string(),
  fields: v.array(v.string()),
  preview: v.string(),
  createdAt: v.number(),
  channels: v.array(relayChannelValidator),
})

/**
 * `POST /api/pipeline/notify/pending` `{ channels }` → `{ items }`: what the
 * relay should send now, at most `RELAY_BATCH` items, oldest first. A
 * mutation, because the call is also the relay's heartbeat.
 */
export const relayPending = internalMutation({
  args: { channels: v.array(relayChannelValidator) },
  returns: v.object({ items: v.array(relayItemValidator) }),
  handler: async (ctx, { channels }) => {
    const now = Date.now()
    const served = RELAY_CHANNELS.filter((channel) => channels.includes(channel))
    const relay = await ctx.db
      .query("notifyRelays")
      .withIndex("by_name", (q) => q.eq("name", RELAY_NAME))
      .unique()
    if (relay) await ctx.db.patch("notifyRelays", relay._id, { channels: served, lastSeenAt: now })
    else
      await ctx.db.insert("notifyRelays", { name: RELAY_NAME, channels: served, lastSeenAt: now })

    const items = []
    const due = (deliveries: readonly Delivery[]) =>
      served.filter((channel: RelayChannel) => relayDue(deliveries, channel, now))

    const tests = await ctx.db
      .query("notificationTests")
      .withIndex("by_createdAt", (q) => q.gt("createdAt", now - TEST_WINDOW_MS))
      .take(RELAY_BATCH)
    for (const test of tests) {
      const owed = due(test.notifications)
      if (owed.length > 0) {
        items.push({ ...relayFacts(testNotice(test.key, test.createdAt)), channels: owed })
      }
    }
    const open = await ctx.db
      .query("listingRequests")
      .withIndex("by_status_createdAt", (q) =>
        q.eq("status", "open").gt("createdAt", now - RELAY_WINDOW_MS),
      )
      .take(100)
    for (const row of open) {
      if (items.length >= RELAY_BATCH) break
      if (row.purgedAt !== undefined) continue
      const owed = due(row.notifications ?? [])
      if (owed.length > 0) {
        items.push({ ...relayFacts(await requestNotice(ctx, row)), channels: owed })
      }
    }
    return { items }
  },
})

/** `POST /api/pipeline/notify/ack` `{ id, results }` → `{ ok }`. */
export const relayAck = internalMutation({
  args: {
    id: v.string(),
    results: v.array(
      v.object({ channel: relayChannelValidator, ok: v.boolean(), error: v.optional(v.string()) }),
    ),
  },
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx, { id, results }) => {
    return { ok: await record(ctx, id, results) }
  },
})

/** The relay's state for the dashboard, or null when it never called. */
export async function relayState(ctx: { db: QueryCtx["db"] }) {
  const relay = await ctx.db
    .query("notifyRelays")
    .withIndex("by_name", (q) => q.eq("name", RELAY_NAME))
    .unique()
  return relay ? { channels: relay.channels, lastSeenAt: relay.lastSeenAt } : null
}

// --- broker actions (called from convex/broker/listingRequests.ts) -----------------------

/** "Notify again": every channel sends the request once more. */
export async function resend(ctx: MutationCtx, row: Doc<"listingRequests">) {
  await ctx.db.patch("listingRequests", row._id, { notifications: [] })
  await ctx.scheduler.runAfter(0, internal.notifications.listingRequest, { key: row.key })
}

/** "Send test notification": a synthetic request for every channel. */
export async function startTest(ctx: MutationCtx): Promise<string> {
  const now = Date.now()
  const key = `nt-${sha1Hex(`test:${now}:${Math.random()}`).slice(0, 20)}`
  await ctx.db.insert("notificationTests", { key, createdAt: now, notifications: [] })
  const old = await ctx.db
    .query("notificationTests")
    .withIndex("by_createdAt")
    .order("desc")
    .take(TESTS_KEPT + 10)
  for (const row of old.slice(TESTS_KEPT)) await ctx.db.delete("notificationTests", row._id)
  await ctx.scheduler.runAfter(0, internal.notifications.listingRequest, { key })
  return key
}
