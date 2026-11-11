import { v } from "convex/values"
import { isOwnerField, OWNER_FIELDS } from "../lib/owner-corrections"
import type { Doc } from "./_generated/dataModel"
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server"
import { readField } from "./lib/materialise"
import {
  AGENT_REMOVAL_SCOPES,
  AGENT_STALE_MS,
  type AgentReply,
  buildDraft,
  CHECK_MAX_ATTEMPTS,
  DRAFT_KINDS,
  DRAFT_MAX_ATTEMPTS,
  DRAFT_RETRY_AFTER_MS,
  DRAFT_WINDOW_MS,
  displayValue,
  fieldGuide,
  hideContacts,
  JOB_MAX_ATTEMPTS,
  JOB_STALE_MS,
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
 *
 * ENG-158 adds the plan's other half. When a draft names the society's events
 * page, `pending` also hands out the site to check (`checks`); the agent reads
 * it by the scraper's rules and posts what it found to `requests/check`. Once
 * the broker confirms, the request carries a job: the job runner (pipeline
 * `request_jobs.py`, `camsocs-request-jobs.timer`) takes it with
 * `requests/jobs/next`, reads that one society's site, loads, and reports to
 * `requests/job`. `requests/websites` lists the confirmed websites for the
 * scraper's stages.
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

/** A site the agent should read before the broker confirms (ENG-158). */
const checkValidator = v.object({
  key: v.string(),
  orgKey: v.string(),
  name: v.string(),
  aliases: v.array(v.string()),
  /** The home page to read and the events link the request gives. */
  website: v.string(),
  eventsUrl: v.string(),
  /** The listing's public social links, to tie the site to the listing. */
  socials: v.array(v.string()),
})

const eventValidator = v.object({
  title: v.string(),
  startsAt: v.number(),
  venue: v.optional(v.string()),
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

function checkDue(row: Doc<"listingRequests">, now: number): boolean {
  if (row.purgedAt !== undefined || !row.orgKey) return false
  const source = row.draft?.state === "ready" ? row.draft.eventsSource : undefined
  if (!source) return false
  const check = source.check
  if (!check) return true
  return (
    check.state === "failed" &&
    check.attempts < CHECK_MAX_ATTEMPTS &&
    now - check.at >= DRAFT_RETRY_AFTER_MS
  )
}

function socialLinks(org: Record<string, unknown> | null): string[] {
  const socials = org?.socials
  if (!Array.isArray(socials)) return []
  return socials
    .map((item) => (item && typeof item === "object" ? (item as { url?: unknown }).url : null))
    .filter((url): url is string => typeof url === "string")
    .slice(0, 12)
}

const clean = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max)

async function findRequest(ctx: { db: QueryCtx["db"] }, key: string) {
  return await ctx.db
    .query("listingRequests")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique()
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
    /** Sites to read for a draft that names an events page (ENG-158). */
    checks: v.array(checkValidator),
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
    const siteChecks = []
    for (const row of open) {
      if (siteChecks.length < BATCH && checkDue(row, now)) {
        const org = await findOrg(ctx, row.orgKey)
        const source = row.draft?.eventsSource
        if (org && source) {
          siteChecks.push({
            key: row.key,
            orgKey: org.key,
            name: org.name,
            aliases: Array.isArray(org.aliases) ? org.aliases.slice(0, 12) : [],
            website: source.website,
            eventsUrl: source.url,
            socials: socialLinks(org as Record<string, unknown>),
          })
        }
      }
      if (items.length >= BATCH) continue
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
    return {
      items,
      fieldGuide: fieldGuide(),
      removalScopes: [...AGENT_REMOVAL_SCOPES],
      checks: siteChecks,
    }
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
  eventsUrl: v.optional(v.string()),
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
        ...(body.eventsSource ? { eventsSource: body.eventsSource } : {}),
      },
    })
    return { ok: true }
  },
})

/**
 * `POST /api/pipeline/requests/check` `{ key, ok, error?, ownSite?, tiedBy?,
 * pages?, eventCount?, events?, notes? }` → `{ ok }`: what the agent found on
 * the site a draft's events page is on (ENG-158). Kept on the draft, for the
 * broker to read before confirming. A draft that no longer names that site
 * (redrafted meanwhile) is left alone.
 */
export const saveCheck = internalMutation({
  args: {
    key: v.string(),
    website: v.string(),
    ok: v.boolean(),
    error: v.optional(v.string()),
    ownSite: v.optional(v.boolean()),
    tiedBy: v.optional(v.string()),
    pages: v.optional(v.number()),
    eventCount: v.optional(v.number()),
    events: v.optional(v.array(eventValidator)),
    notes: v.optional(v.array(v.string())),
  },
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx, args) => {
    const row = await findRequest(ctx, args.key)
    const draft = row?.draft
    const source = draft?.state === "ready" ? draft.eventsSource : undefined
    if (!row || !draft || !source || row.status !== "open" || source.website !== args.website) {
      return { ok: false }
    }
    const meta = { at: Date.now(), attempts: (source.check?.attempts ?? 0) + 1 }
    const check = args.ok
      ? {
          state: "ok" as const,
          ...meta,
          ownSite: args.ownSite ?? false,
          ...(args.tiedBy ? { tiedBy: clean(args.tiedBy, 200) } : {}),
          pages: args.pages ?? 0,
          eventCount: args.eventCount ?? args.events?.length ?? 0,
          events: (args.events ?? []).slice(0, 12).map((event) => ({
            title: clean(event.title, 200),
            startsAt: event.startsAt,
            ...(event.venue ? { venue: clean(event.venue, 200) } : {}),
          })),
          notes: (args.notes ?? []).slice(0, 6).map((note) => clean(note, 300)),
        }
      : {
          state: "failed" as const,
          ...meta,
          error: (args.error ?? "error").replace(/[^\w .:-]/g, "").slice(0, 80),
        }
    await ctx.db.patch("listingRequests", row._id, {
      draft: { ...draft, eventsSource: { ...source, check } },
    })
    return { ok: true }
  },
})

const jobValidator = v.object({
  key: v.string(),
  orgKey: v.string(),
  website: v.string(),
})

/**
 * `POST /api/pipeline/requests/jobs/next` `{ claim }` → `{ job }`: the oldest
 * job a confirmed plan queued (ENG-158), or null. With `claim` it is marked
 * running, which counts a try; without, it is only shown, so the runner can
 * take the harvest lock first. A job left `running` for an hour is taken to
 * have died and is offered again; after three tries it is marked failed.
 */
export const nextJob = internalMutation({
  args: { claim: v.boolean() },
  returns: v.object({ job: v.union(v.null(), jobValidator) }),
  handler: async (ctx, args) => {
    const now = Date.now()
    const queued = await ctx.db
      .query("listingRequests")
      .withIndex("by_job_state", (q) => q.eq("job.state", "queued"))
      .take(20)
    const running = await ctx.db
      .query("listingRequests")
      .withIndex("by_job_state", (q) => q.eq("job.state", "running"))
      .take(20)
    const stale = running.filter((row) => now - (row.job?.startedAt ?? 0) > JOB_STALE_MS)
    const rows = [...stale, ...queued].sort(
      (a, b) => (a.job?.queuedAt ?? 0) - (b.job?.queuedAt ?? 0),
    )
    for (const row of rows) {
      const job = row.job
      if (!job || !row.orgKey) continue
      if (job.attempts >= JOB_MAX_ATTEMPTS) {
        await ctx.db.patch("listingRequests", row._id, {
          job: { ...job, state: "failed", finishedAt: now, error: job.error ?? "gave up" },
        })
        continue
      }
      if (args.claim) {
        await ctx.db.patch("listingRequests", row._id, {
          job: { ...job, state: "running", startedAt: now, attempts: job.attempts + 1 },
        })
      }
      return { job: { key: row.key, orgKey: row.orgKey, website: job.website } }
    }
    return { job: null }
  },
})

/**
 * `POST /api/pipeline/requests/job` `{ key, ok, error?, eventCount?, events? }`
 * → `{ ok }`: how a job went. A failed one is queued again while it has tries
 * left.
 */
export const saveJob = internalMutation({
  args: {
    key: v.string(),
    ok: v.boolean(),
    error: v.optional(v.string()),
    eventCount: v.optional(v.number()),
    events: v.optional(v.array(v.object({ title: v.string(), startsAt: v.number() }))),
  },
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx, args) => {
    const row = await findRequest(ctx, args.key)
    const job = row?.job
    if (!row || !job || job.state !== "running") return { ok: false }
    const now = Date.now()
    if (args.ok) {
      const events = (args.events ?? []).slice(0, 12).map((event) => ({
        title: clean(event.title, 200),
        startsAt: event.startsAt,
      }))
      await ctx.db.patch("listingRequests", row._id, {
        job: {
          ...job,
          state: "done",
          finishedAt: now,
          error: undefined,
          eventCount: args.eventCount ?? events.length,
          events,
        },
      })
      return { ok: true }
    }
    const error = (args.error ?? "error").replace(/[^\w .:-]/g, "").slice(0, 80)
    const again = job.attempts < JOB_MAX_ATTEMPTS
    await ctx.db.patch("listingRequests", row._id, {
      job: {
        ...job,
        state: again ? "queued" : "failed",
        error,
        ...(again ? {} : { finishedAt: now }),
      },
    })
    return { ok: true }
  },
})

/**
 * `POST /api/pipeline/requests/websites` `{}` → `{ websites }`: the society
 * websites the broker confirmed (ENG-158), by listing. The scraper reads them
 * next to the register-stated ones: `enrich` weekly, `website_events` daily.
 */
export const websites = internalQuery({
  args: {},
  returns: v.object({
    websites: v.array(v.object({ orgKey: v.string(), url: v.string() })),
  }),
  handler: async (ctx) => {
    const rows = await ctx.db.query("websiteSources").take(2000)
    return { websites: rows.map((row) => ({ orgKey: row.orgKey, url: row.url })) }
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
