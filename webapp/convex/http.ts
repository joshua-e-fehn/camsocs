import { type FunctionArgs, type FunctionReference, httpRouter } from "convex/server"
import { Base64 } from "convex/values"
import {
  bytesToBase64,
  INBOUND_LIMITS,
  type InboundMessage,
  parseGenericPayload,
  parseResendWebhook,
  recipientAllowed,
  resendMessage,
  svixHeaders,
  verifySvixSignature,
} from "../lib/inbound-email"
import { fetchReceivedAttachments, fetchReceivedEmail, ResendError } from "../lib/resend-inbound"
import { internal } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import { type ActionCtx, httpAction } from "./_generated/server"
import { authComponent, createAuth } from "./betterAuth/auth"
import { ALLOWED_CONTENT_TYPES, MAX_FILE_BYTES, sniffContentType } from "./ingest/files"

/**
 * HTTP surface: Better Auth's own routes, the pipeline ingestion API, and the
 * inbound-mail webhook (`POST /api/inbound/email`, at the end of this file).
 *
 * Copied from Bundestracker convex/http.ts. The ingestion API exists because
 * the harvesting pipeline is Python and there is no Convex client for Python,
 * so it reaches the deployment over HTTP and authenticates with a shared key in
 * an `Authorization: Bearer` header — a second mechanism beside Better Auth on
 * purpose, because a session is a thing only a browser can obtain.
 *
 * This file is transport only: key check, parsing, status codes. What the key
 * may *reach* is the `internal.*` functions registered below and nothing else —
 * `ingestionRoute` only accepts internal references.
 */

const http = httpRouter()

// Registered first: `registerRoutes` builds a Better Auth instance, so a
// deployment missing BETTER_AUTH_SECRET fails this whole module — the pipeline
// routes included. CORS is on because the browser calls this from the Vercel
// domain; the allowed origins come from `trustedOrigins` in betterAuth/auth.ts.
authComponent.registerRoutes(http, createAuth, { cors: true })

// --- auth -----------------------------------------------------------------

/**
 * Compares two secrets without leaking their contents through timing.
 *
 * Digests first so the loop bound is fixed and the supplied key's length is not
 * observable either. `crypto.subtle` is ambient in Convex's V8 runtime;
 * `node:crypto` would force `"use node"`, which an httpAction cannot use.
 */
async function secretEquals(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ])
  const bytesA = new Uint8Array(digestA)
  const bytesB = new Uint8Array(digestB)
  let diff = 0
  for (let i = 0; i < bytesA.length; i++) {
    diff |= bytesA[i] ^ bytesB[i]
  }
  return diff === 0
}

/** Whether the request carries `Authorization: Bearer <expected>`. */
async function bearerMatches(request: Request, expected: string | undefined): Promise<boolean> {
  // An unset key denies rather than allows. Convex env vars are per deployment,
  // so forgetting it on production is a live possibility and the failure has to
  // be a locked door, not an open one.
  if (!expected) return false
  const header = request.headers.get("Authorization") ?? ""
  if (!header.startsWith("Bearer ")) return false
  return await secretEquals(header.slice("Bearer ".length), expected)
}

async function authorized(request: Request): Promise<boolean> {
  return await bearerMatches(request, process.env.PIPELINE_API_KEY)
}

// --- request / response plumbing -----------------------------------------

function json(body: unknown, status: number): Response {
  return Response.json(body, { status })
}

/**
 * Maps a thrown error to a response: 404 when the message says "not found",
 * otherwise 400 with the message passed through. Everything reachable from
 * here is an internal function whose throws are precondition failures — the
 * caller's fault — and a pipeline told *why* can log something useful, where
 * an opaque 500 just gets retried. `not found` is matched anywhere because a
 * throw crossing the Convex boundary arrives wrapped as `"Uncaught Error: …"`.
 */
function errorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error)
  return json({ error: message }, /not found/i.test(message) ? 404 : 400)
}

type PipelineHandler = (ctx: ActionCtx, request: Request) => Promise<Response>

/**
 * Wraps a handler with the key check and error mapping. A combinator rather
 * than a copied preamble, so a route added later cannot ship without the check.
 */
function pipelineRoute(handler: PipelineHandler) {
  return httpAction(async (ctx, request) => {
    if (!(await authorized(request))) {
      return json({ error: "Unauthorized" }, 401)
    }
    try {
      return await handler(ctx, request)
    } catch (error) {
      // An argument-validator rejection arrives here as a thrown error; without
      // the catch it would be a 500 that the pipeline retries pointlessly.
      return errorResponse(error)
    }
  })
}

/** Bodies go straight to Convex argument validators, which reject unknown and
 * mistyped fields — so this only has to guarantee an object. Malformed JSON
 * throws here and becomes a 400. */
async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json()
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("Request body must be a JSON object")
  }
  return body as Record<string, unknown>
}

/** Asserts a request body into the argument type of the function it is passed
 * to. Nothing is checked here and nothing can be; the function's own argument
 * validator is the check, and its rejection becomes a 400 naming the field. */
function asArgs<T>(body: Record<string, unknown>): T {
  return body as unknown as T
}

// --- pipeline -------------------------------------------------------------

/**
 * `GET /api/pipeline/health` — does this key still open the door?
 *
 * The pipeline calls this before a long run so a rotated or missing
 * `PIPELINE_API_KEY` surfaces as one clean 401 at the start rather than as
 * thousands of them an hour in.
 */
http.route({
  path: "/api/pipeline/health",
  method: "GET",
  handler: pipelineRoute(async () => json({ ok: true }, 200)),
})

/**
 * Registers `POST /api/pipeline/<path>` as the front door to one internal
 * mutation. A table of one-liners rather than repeated `http.route` blocks,
 * which is how a key check ends up on twelve routes out of thirteen. 200, not
 * 201: an upsert is not a creation.
 */
function ingestionRoute<Ref extends FunctionReference<"mutation", "internal">>(
  path: string,
  mutation: Ref,
): void {
  http.route({
    path: `/api/pipeline/${path}`,
    method: "POST",
    handler: pipelineRoute(async (ctx, request) => {
      const body = await readJsonBody(request)
      return json(await ctx.runMutation(mutation, asArgs<FunctionArgs<Ref>>(body)), 200)
    }),
  })
}

/**
 * Registers `POST /api/pipeline/<path>` as the front door to one internal
 * *query* — the read routes the pipeline needs (pending inbound mail).
 */
function readRoute<Ref extends FunctionReference<"query", "internal">>(
  path: string,
  queryRef: Ref,
): void {
  http.route({
    path: `/api/pipeline/${path}`,
    method: "POST",
    handler: pipelineRoute(async (ctx, request) => {
      const body = await readJsonBody(request)
      return json(await ctx.runQuery(queryRef, asArgs<FunctionArgs<Ref>>(body)), 200)
    }),
  })
}

// The run log first: every pipeline run opens a row before it writes data and
// closes it with per-stage results. See convex/runs.ts.
ingestionRoute("runs/start", internal.runs.start)
ingestionRoute("runs/finish", internal.runs.finish)

// Field claims → resolved entities (convex/ingest/claims.ts).
ingestionRoute("claims", internal.ingest.claims.ingest)
// Keyed side tables.
ingestionRoute("sources", internal.ingest.sources.upsert)
ingestionRoute("orgInternal", internal.ingest.orgInternal.patch)
ingestionRoute("relationships", internal.ingest.relationships.upsert)
ingestionRoute("eventOrganisers", internal.ingest.relationships.setEventOrganisers)
ingestionRoute("brokerInferences", internal.ingest.broker.ingest)
ingestionRoute("termDates", internal.ingest.termDates.upsert)
// The mailing-list inbox (source-research §16).
readRoute("inbound/pending", internal.ingest.inbound.pending)
ingestionRoute("inbound/mark", internal.ingest.inbound.mark)
// The mailing-list sign-up worklist (`camsocs worklist`).
readRoute("worklist", internal.ingest.orgInternal.worklistPage)
// Maintenance: re-derive everything now; reset the dev deployment.
ingestionRoute("derive", internal.derive.daily)
ingestionRoute("purge", internal.ingest.purge.purge)

/**
 * `POST /api/pipeline/files` — `{ data: <base64>, contentType }` → the
 * `storageId` of our own copy (logos, event images, termcards: never
 * hotlinked). At most 2 MB; raster images and PDF only, and the bytes must
 * look like the type they claim. Identical bytes are stored once
 * (convex/ingest/files.ts).
 */
http.route({
  path: "/api/pipeline/files",
  method: "POST",
  handler: pipelineRoute(async (ctx, request) => {
    const body = await readJsonBody(request)
    const { data, contentType } = body
    if (typeof data !== "string" || typeof contentType !== "string") {
      throw new Error("Body must be { data: base64 string, contentType: string }")
    }
    if (!(ALLOWED_CONTENT_TYPES as readonly string[]).includes(contentType)) {
      throw new Error(`Content type ${contentType} is not accepted`)
    }
    if (data.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 + 4) {
      throw new Error(`File too large: the limit is ${MAX_FILE_BYTES} bytes`)
    }
    // Copied into a fresh ArrayBuffer-backed view: Web Crypto and Blob reject
    // views typed over a possibly-shared buffer.
    const bytes = new Uint8Array(Base64.toByteArray(data))
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_FILE_BYTES) {
      throw new Error(`File must be 1..${MAX_FILE_BYTES} bytes`)
    }
    if (sniffContentType(bytes) !== contentType) {
      throw new Error(`The bytes are not ${contentType}`)
    }
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
    const sha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")

    const known = await ctx.runQuery(internal.ingest.files.findBySha256, { sha256 })
    if (known) return json({ storageId: known, sha256, inserted: 0, updated: 0, unchanged: 1 }, 200)
    const storageId = await ctx.storage.store(new Blob([bytes], { type: contentType }))
    const recorded = await ctx.runMutation(internal.ingest.files.record, {
      sha256,
      storageId,
      contentType,
      size: bytes.byteLength,
    })
    return json(
      {
        storageId: recorded.storageId,
        sha256,
        inserted: recorded.deduplicated ? 0 : 1,
        updated: 0,
        unchanged: recorded.deduplicated ? 1 : 0,
      },
      200,
    )
  }),
})

/**
 * `POST /api/pipeline/inbound/file` — `{ messageId, storageId }` → `{ data:
 * <base64>, contentType, filename }`: one attachment (or the HTML body) of a
 * forwarded list mail, for the pipeline's poster and termcard extraction. Only
 * files belonging to that mail are served (`fileOf`).
 */
http.route({
  path: "/api/pipeline/inbound/file",
  method: "POST",
  handler: pipelineRoute(async (ctx, request) => {
    const body = await readJsonBody(request)
    const { messageId, storageId } = body
    if (typeof messageId !== "string" || typeof storageId !== "string") {
      throw new Error("Body must be { messageId: string, storageId: string }")
    }
    const file = await ctx.runQuery(internal.ingest.inbound.fileOf, {
      messageId,
      storageId: storageId as Id<"_storage">,
    })
    if (!file) return json({ error: "File not found for this message" }, 404)
    const blob = await ctx.storage.get(file.storageId)
    if (!blob) return json({ error: "Stored file not found" }, 404)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    return json(
      { data: bytesToBase64(bytes), contentType: file.contentType, filename: file.filename },
      200,
    )
  }),
})

// --- inbound mail (source-research §16) -----------------------------------------------------

/**
 * `POST /api/inbound/email` — forwarded society list mail lands here and is
 * stored in the internal `inboundEmails` table as `pending`; the pipeline's
 * `inbox` stage extracts events from it. Nothing here is ever public.
 *
 * Two senders, told apart by the Svix headers:
 *
 *  - **Resend** (`email.received`, signed with Svix): verified with
 *    `RESEND_WEBHOOK_SECRET` (the endpoint's `whsec_…` signing secret); the
 *    body, headers and attachments are then fetched from Resend's Receiving API
 *    with `RESEND_INBOUND_API_KEY` (or `RESEND_API_KEY`), which needs full
 *    access. Other event types are acknowledged and ignored.
 *  - **Anything else** posts the provider-agnostic JSON (lib/inbound-email.ts)
 *    with `Authorization: Bearer $INBOUND_EMAIL_SECRET`.
 *
 * Either secret unset → 401 for that sender: deny-all. Optional
 * `INBOUND_EMAIL_RECIPIENTS` (comma-separated) drops mail not addressed to one
 * of those addresses. Answers: 200 `{stored}` / `{duplicate}` / `{ignored}`;
 * 401 bad signature or secret; 400 malformed; 413 too large; 502/503 when
 * Resend's API failed or is not configured yet — Resend retries those for about
 * a day, and the `messageId` dedupe makes every retry safe.
 */
http.route({
  path: "/api/inbound/email",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const declared = Number(request.headers.get("Content-Length") ?? "0")
    if (declared > INBOUND_LIMITS.maxRequestBytes) return json({ error: "Too large" }, 413)
    const raw = await request.text()
    if (raw.length > INBOUND_LIMITS.maxRequestBytes) return json({ error: "Too large" }, 413)
    const now = Date.now()

    const svix = svixHeaders((name) => request.headers.get(name))
    if (svix) {
      const verified = await verifySvixSignature(
        svix,
        raw,
        process.env.RESEND_WEBHOOK_SECRET,
        Math.floor(now / 1000),
      )
      if (!verified) return json({ error: "Unauthorized" }, 401)
      return await receiveResend(ctx, raw, now)
    }

    if (!(await bearerMatches(request, process.env.INBOUND_EMAIL_SECRET))) {
      return json({ error: "Unauthorized" }, 401)
    }
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      return json({ error: "Body must be JSON" }, 400)
    }
    const parsed = parseGenericPayload(body, now)
    if (!parsed.ok) return json({ error: parsed.error }, 400)
    if (!recipientAllowed(process.env.INBOUND_EMAIL_RECIPIENTS, parsed.value.to)) {
      return json({ ignored: "recipient" }, 200)
    }
    return await storeInbound(ctx, parsed.value)
  }),
})

async function receiveResend(ctx: ActionCtx, raw: string, now: number): Promise<Response> {
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return json({ error: "Body must be JSON" }, 400)
  }
  const parsed = parseResendWebhook(body)
  if (!parsed.ok) return json({ error: parsed.error }, 400)
  const received = parsed.value
  if (received === null) return json({ ignored: "event type" }, 200)
  if (!recipientAllowed(process.env.INBOUND_EMAIL_RECIPIENTS, received.to)) {
    return json({ ignored: "recipient" }, 200)
  }
  if (
    received.messageId &&
    (await ctx.runQuery(internal.ingest.inbound.hasMessage, { messageId: received.messageId }))
  ) {
    return json({ duplicate: true }, 200)
  }
  const apiKey = process.env.RESEND_INBOUND_API_KEY || process.env.RESEND_API_KEY
  if (!apiKey) return json({ error: "Resend API key not configured" }, 503)
  try {
    const email = await fetchReceivedEmail(fetch, apiKey, received.emailId)
    const message = resendMessage(received, email, now)
    if (received.attachmentCount > 0) {
      const files = await fetchReceivedAttachments(fetch, apiKey, received.emailId)
      message.attachments = files.attachments
      message.skipped = files.skipped
    }
    return await storeInbound(ctx, message)
  } catch (error) {
    if (error instanceof ResendError) return json({ error: error.message }, 502)
    throw error
  }
}

/** Stores the HTML and attachments, then the row; undoes the uploads when the
 * row turns out to be a duplicate (a concurrent retry won the race). */
async function storeInbound(ctx: ActionCtx, message: InboundMessage): Promise<Response> {
  if (await ctx.runQuery(internal.ingest.inbound.hasMessage, { messageId: message.messageId })) {
    return json({ duplicate: true }, 200)
  }
  const uploaded: Id<"_storage">[] = []
  const notes = [...message.skipped]
  let htmlStorageId: Id<"_storage"> | undefined
  if (message.html) {
    const bytes = new TextEncoder().encode(message.html)
    if (bytes.byteLength <= INBOUND_LIMITS.maxHtmlBytes) {
      htmlStorageId = await ctx.storage.store(new Blob([bytes], { type: "text/html" }))
      uploaded.push(htmlStorageId)
    } else {
      notes.push(`html body not kept: ${bytes.byteLength} bytes`)
    }
  }
  const attachments = []
  for (const file of message.attachments) {
    const storageId = await ctx.storage.store(
      new Blob([new Uint8Array(file.bytes)], { type: file.contentType }),
    )
    uploaded.push(storageId)
    attachments.push({ storageId, filename: file.filename, contentType: file.contentType })
  }
  const { stored } = await ctx.runMutation(internal.ingest.inbound.receive, {
    messageId: message.messageId,
    receivedAt: message.receivedAt,
    from: message.from,
    listId: message.listId,
    listName: message.listName,
    subject: message.subject,
    text: message.text,
    htmlStorageId,
    attachments,
    note: notes.length ? `skipped: ${notes.join("; ")}` : undefined,
  })
  if (!stored) {
    for (const storageId of uploaded) await ctx.storage.delete(storageId)
    return json({ duplicate: true }, 200)
  }
  return json({ stored: true }, 200)
}

export default http
