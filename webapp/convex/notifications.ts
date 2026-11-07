import { v } from "convex/values"
import { deploymentProfile } from "../lib/campus/deployment"
import { internal } from "./_generated/api"
import { internalAction, internalMutation, internalQuery } from "./_generated/server"
import {
  type DeliveryResult,
  NOTIFY_CHANNELS,
  type NotifyChannel,
  notifyConfig,
  type RequestNotice,
  sendOn,
} from "./lib/requestNotify"
import { requestNotificationValidator } from "./schema"

/**
 * New listing request → the broker on Slack, email and WhatsApp (ENG-104).
 *
 * `listingRequests.submit` schedules `listingRequest` with the insert, so a
 * refused request never notifies and a failed notification can never fail
 * the submission. The action reads the request, sends it on every configured
 * channel (lib/requestNotify.ts says what each one carries and which env vars
 * switch it on), and stores each channel's outcome on the request
 * (`notifications`). A channel that failed is tried once more after
 * `RETRY_DELAY_MS`; one that already delivered is never sent again unless a
 * broker asks (`force`, the inbox's "Notify again").
 *
 * The broker's "Send test notification" (`test`) sends a synthetic request
 * that is never stored.
 */

export const RETRY_DELAY_MS = 2 * 60 * 1000
const MAX_ATTEMPTS = 2

function siteOrigin(): string {
  return (process.env.SITE_URL?.trim() || deploymentProfile().origin).replace(/\/+$/, "")
}

const noticeValidator = v.object({
  key: v.string(),
  kind: v.string(),
  createdAt: v.number(),
  orgName: v.optional(v.string()),
  orgKey: v.optional(v.string()),
  eventKey: v.optional(v.string()),
  role: v.optional(v.string()),
  submitterEmail: v.string(),
  message: v.string(),
  fieldNames: v.array(v.string()),
  test: v.optional(v.boolean()),
  /** Channels that already delivered this request. */
  delivered: v.array(v.string()),
})

/** The request as a notification says it, or null when it is gone or purged. */
export const notice = internalQuery({
  args: { key: v.string() },
  returns: v.union(v.null(), noticeValidator),
  handler: async (ctx, { key }) => {
    const row = await ctx.db
      .query("listingRequests")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique()
    if (!row || row.purgedAt !== undefined) return null
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
      delivered: (row.notifications ?? []).filter((n) => n.ok).map((n) => n.channel),
    }
  },
})

/** Stores each channel's latest outcome on the request. */
export const record = internalMutation({
  args: { key: v.string(), results: v.array(requestNotificationValidator) },
  returns: v.null(),
  handler: async (ctx, { key, results }) => {
    const row = await ctx.db
      .query("listingRequests")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique()
    if (!row) return null
    const byChannel = new Map((row.notifications ?? []).map((n) => [n.channel, n]))
    for (const result of results) byChannel.set(result.channel, result)
    await ctx.db.patch("listingRequests", row._id, {
      notifications: NOTIFY_CHANNELS.flatMap((channel) => {
        const entry = byChannel.get(channel)
        return entry ? [entry] : []
      }),
    })
    return null
  },
})

async function sendAll(
  notice: RequestNotice,
  skip: ReadonlySet<string>,
): Promise<DeliveryResult[]> {
  const config = notifyConfig()
  const site = siteOrigin()
  const results = await Promise.all(
    NOTIFY_CHANNELS.filter((channel) => !skip.has(channel)).map((channel) =>
      sendOn(channel, config, notice, site),
    ),
  )
  const sent = results.filter((result): result is DeliveryResult => result !== null)
  for (const result of sent) {
    if (!result.ok)
      console.error(`Request notification: ${result.channel} failed (${result.error})`)
  }
  return sent
}

export const listingRequest = internalAction({
  args: { key: v.string(), force: v.optional(v.boolean()), attempt: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { key, force, attempt = 1 }) => {
    const found = await ctx.runQuery(internal.notifications.notice, { key })
    if (!found) return null
    const { delivered, ...notice } = found
    const results = await sendAll(notice, new Set(force ? [] : delivered))
    if (results.length === 0) return null
    const at = Date.now()
    await ctx.runMutation(internal.notifications.record, {
      key,
      results: results.map((result) => ({ ...result, at })),
    })
    if (results.some((result) => !result.ok) && attempt < MAX_ATTEMPTS) {
      await ctx.scheduler.runAfter(RETRY_DELAY_MS, internal.notifications.listingRequest, {
        key,
        attempt: attempt + 1,
      })
    }
    return null
  },
})

/** A synthetic request on every configured channel; nothing is stored. */
export const test = internalAction({
  args: {},
  returns: v.array(
    v.object({
      channel: v.union(v.literal("slack"), v.literal("email"), v.literal("whatsapp")),
      ok: v.boolean(),
      error: v.optional(v.string()),
    }),
  ),
  handler: async () => {
    const results = await sendAll(
      {
        key: "lr-test-notification",
        kind: "claim",
        createdAt: Date.now(),
        orgName: "Test Society (not a real request)",
        submitterEmail: "someone@example.org",
        role: "President",
        message:
          "This is a test notification sent from the broker dashboard. Nothing was submitted.",
        fieldNames: ["website"],
        test: true,
      },
      new Set(),
    )
    return results.map(({ channel, ok, error }) => ({
      channel: channel as NotifyChannel,
      ok,
      ...(error ? { error } : {}),
    }))
  },
})
