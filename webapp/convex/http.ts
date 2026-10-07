import { type FunctionArgs, type FunctionReference, httpRouter } from "convex/server"
import { internal } from "./_generated/api"
import { type ActionCtx, httpAction } from "./_generated/server"
import { authComponent, createAuth } from "./betterAuth/auth"

/**
 * HTTP surface: Better Auth's own routes, plus the pipeline ingestion API.
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

async function authorized(request: Request): Promise<boolean> {
  const expected = process.env.PIPELINE_API_KEY
  // An unset key denies rather than allows. Convex env vars are per deployment,
  // so forgetting it on production is a live possibility and the failure has to
  // be a locked door, not an open one.
  if (!expected) return false
  const header = request.headers.get("Authorization") ?? ""
  if (!header.startsWith("Bearer ")) return false
  return await secretEquals(header.slice("Bearer ".length), expected)
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

// The run log first: every pipeline run opens a row before it writes data and
// closes it with per-stage results. See convex/runs.ts.
ingestionRoute("runs/start", internal.runs.start)
ingestionRoute("runs/finish", internal.runs.finish)

export default http
