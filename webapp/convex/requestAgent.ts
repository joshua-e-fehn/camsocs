import { v } from "convex/values"
import { isOwnerField, OWNER_FIELDS } from "../lib/owner-corrections"
import type { Doc } from "./_generated/dataModel"
import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server"
import { readField } from "./lib/materialise"
import {
  AGENT_REMOVAL_SCOPES,
  AGENT_STALE_MS,
  type AgentReply,
  buildDraft,
  DRAFT_KINDS,
  DRAFT_MAX_ATTEMPTS,
  DRAFT_RETRY_AFTER_MS,
  DRAFT_WINDOW_MS,
  displayValue,
  fieldGuide,
  hideContacts,
  MESSAGE_MAX,
  maskContacts,
  senderChecks,
} from "./lib/requestDraft"

/**
 * The request agent's two routes (ENG-126; convex/lib/requestDraft.ts says
 * what a draft is and what is checked). The agent on the VPS (pipeline
 * `request_agent.py`, systemd `camsocs-request-agent.timer`, every minute)
 * calls `POST /api/pipeline/requests/pending` and gets the open requests that
 * still need a draft, masked; it asks the model, then posts each reply (or
 * its failure) to `POST /api/pipeline/requests/draft`. Convex is never
 * reached the other way round. The agent changes nothing on the listing: the
 * broker confirms the draft in the dashboard.
 */

const AGENT_NAME = "request-agent"
/** Requests one call gets at most (each is one model request). */
const BATCH = 3

const listingValidator = v.object({
  key: v.string(),
  name: v.string(),
  /** Correctable fields the listing has, as the editor writes them. */
  current: v.record(v.string(), v.string()),
})

const itemValidator = v.object({
  key: v.string(),
  kind: v.string(),
  role: v.union(v.null(), v.string()),
  fromDomain: v.string(),
  checks: v.object({
    cam: v.boolean(),
    listed: v.boolean(),
    siteDomain: v.boolean(),
  }),
  listing: v.union(v.null(), listingValidator),
  eventKey: v.union(v.null(), v.string()),
  /** The message with addresses and phone numbers masked. */
  message: v.string(),
  /** Proposed values from the form, masked the same way. */
  fields: v.record(v.string(), v.string()),
  /** The address tokens the message and fields use. */
  tokens: v.array(v.string()),
})

async function findOrg(ctx: { db: QueryCtx["db"] }, key: string | undefined) {
  if (!key) return null
  return await ctx.db
    .query("organisations")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique()
}

/** The request's texts in one order, so masking is the same on both routes. */
function requestTexts(row: Doc<"listingRequests">): { names: string[]; texts: string[] } {
  const entries = Object.entries(row.fields ?? {})
  return {
    names: entries.map(([name]) => name),
    texts: [row.message.slice(0, MESSAGE_MAX), ...entries.map(([, value]) => value)],
  }
}

function due(row: Doc<"listingRequests">, now: number): boolean {
  if (row.purgedAt !== undefined) return false
  if (!(DRAFT_KINDS as readonly string[]).includes(row.kind)) return false
  if ((row.kind === "claim" || row.kind === "correct") && !row.orgKey) return false
  const draft = row.draft
  if (!draft) return true
  return (
    draft.state === "failed" &&
    draft.attempts < DRAFT_MAX_ATTEMPTS &&
    now - draft.at >= DRAFT_RETRY_AFTER_MS
  )
}

async function heartbeat(ctx: MutationCtx, now: number) {
  const row = await ctx.db
    .query("notifyRelays")
    .withIndex("by_name", (q) => q.eq("name", AGENT_NAME))
    .unique()
  if (row) await ctx.db.patch("notifyRelays", row._id, { lastSeenAt: now })
  else await ctx.db.insert("notifyRelays", { name: AGENT_NAME, channels: [], lastSeenAt: now })
}

/**
 * `POST /api/pipeline/requests/pending` `{}` → `{ items, fieldGuide,
 * removalScopes }`: the open requests that need a draft now, oldest first, at
 * most `BATCH`. A mutation, because the call is also the agent's heartbeat.
 */
export const pending = internalMutation({
  args: {},
  returns: v.object({
    items: v.array(itemValidator),
    fieldGuide: v.array(v.object({ field: v.string(), label: v.string(), format: v.string() })),
    removalScopes: v.array(v.string()),
  }),
  handler: async (ctx) => {
    const now = Date.now()
    await heartbeat(ctx, now)
    const open = await ctx.db
      .query("listingRequests")
      .withIndex("by_status_createdAt", (q) =>
        q.eq("status", "open").gt("createdAt", now - DRAFT_WINDOW_MS),
      )
      .take(100)
    const items = []
    for (const row of open) {
      if (items.length >= BATCH) break
      if (!due(row, now)) continue
      const org = await findOrg(ctx, row.orgKey)
      const { names, texts } = requestTexts(row)
      const masked = maskContacts(texts, row.submitterEmail)
      const current: Record<string, string> = {}
      if (org) {
        for (const field of OWNER_FIELDS) {
          const shown = displayValue(field, readField(org as Record<string, unknown>, field))
          if (shown !== undefined) current[field] = hideContacts(shown)
        }
      }
      const checks = senderChecks(row.submitterEmail, org)
      items.push({
        key: row.key,
        kind: row.kind,
        role: row.role ?? null,
        fromDomain: checks.domain,
        checks: { cam: checks.cam, listed: checks.listed, siteDomain: checks.siteDomain },
        listing: org ? { key: org.key, name: org.name, current } : null,
        eventKey: row.eventKey ?? null,
        message: masked.texts[0],
        fields: Object.fromEntries(names.map((name, index) => [name, masked.texts[index + 1]])),
        tokens: Object.keys(masked.addresses),
      })
    }
    return { items, fieldGuide: fieldGuide(), removalScopes: [...AGENT_REMOVAL_SCOPES] }
  },
})

const replyValidator = v.object({
  summary: v.string(),
  action: v.union(v.literal("corrections"), v.literal("removal"), v.literal("none")),
  corrections: v.array(
    v.object({ field: v.string(), value: v.string(), reason: v.optional(v.string()) }),
  ),
  removal: v.union(
    v.null(),
    v.object({
      scope: v.string(),
      fields: v.optional(v.array(v.string())),
      address: v.optional(v.string()),
      name: v.optional(v.string()),
      eventKeys: v.optional(v.array(v.string())),
    }),
  ),
  concerns: v.array(v.string()),
  reply: v.string(),
})

/**
 * `POST /api/pipeline/requests/draft` `{ key, ok, model?, promptVersion?,
 * error?, reply? }` → `{ ok }`: stores the agent's draft for one request
 * (or its failure). A request that is no longer open, or was purged, is left
 * alone.
 */
export const saveDraft = internalMutation({
  args: {
    key: v.string(),
    ok: v.boolean(),
    model: v.optional(v.string()),
    promptVersion: v.optional(v.string()),
    error: v.optional(v.string()),
    reply: v.optional(replyValidator),
  },
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("listingRequests")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique()
    if (!row || row.status !== "open" || row.purgedAt !== undefined) return { ok: false }
    const now = Date.now()
    const attempts = (row.draft?.attempts ?? 0) + 1
    const meta = {
      at: now,
      attempts,
      ...(args.model ? { model: args.model.slice(0, 80) } : {}),
      ...(args.promptVersion ? { promptVersion: args.promptVersion.slice(0, 80) } : {}),
    }
    if (!args.ok || !args.reply) {
      const error = (args.error ?? "no reply").replace(/[^\w .:-]/g, "").slice(0, 80)
      await ctx.db.patch("listingRequests", row._id, {
        draft: { state: "failed", ...meta, error },
      })
      return { ok: true }
    }
    const org = await findOrg(ctx, row.orgKey)
    const { texts } = requestTexts(row)
    const masked = maskContacts(texts, row.submitterEmail)
    const body = buildDraft(args.reply as AgentReply, {
      kind: row.kind,
      addresses: masked.addresses,
      requestText: texts.join("\n"),
      message: row.message,
      eventKey: row.eventKey,
      current: (field) =>
        isOwnerField(field) ? readField(org as Record<string, unknown> | null, field) : undefined,
    })
    await ctx.db.patch("listingRequests", row._id, {
      draft: {
        state: "ready",
        ...meta,
        summary: body.summary,
        concerns: body.concerns,
        checks: senderChecks(row.submitterEmail, org),
        corrections: body.corrections,
        ...(body.removal ? { removal: body.removal } : {}),
        dropped: body.dropped,
        reply: body.reply,
      },
    })
    return { ok: true }
  },
})

/** The agent's state for the dashboard, or null when it never called. */
export async function agentState(ctx: { db: QueryCtx["db"] }) {
  const row = await ctx.db
    .query("notifyRelays")
    .withIndex("by_name", (q) => q.eq("name", AGENT_NAME))
    .unique()
  if (!row) return null
  return { lastSeenAt: row.lastSeenAt, stale: Date.now() - row.lastSeenAt > AGENT_STALE_MS }
}
