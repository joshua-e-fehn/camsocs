import { ConvexError } from "convex/values"
import { z } from "zod"
import type { SubmitArgs } from "./listing-request"
import { CONTACT_EMAIL } from "./site"
import { LISTING_REQUEST_KINDS } from "./vocab"

/**
 * How the public request form reaches Convex (ENG-37): through this site's
 * `POST /api/request` (app/api/request/route.ts), not as a mutation from the
 * browser, so the request passes Vercel BotID's check first.
 *
 *   browser ── fetch (BotID adds its challenge headers) ──▶ /api/request
 *     ──▶ checkBotId() ──▶ listingRequests.submit + formSecret ──▶ Convex
 *
 * BotID runs only on Vercel. Its browser half (`initBotId` in
 * instrumentation-client.ts) patches `fetch` for this path and loads a
 * challenge script from Vercel through next.config's rewrites; its server half
 * (`checkBotId`) asks Vercel whether that challenge was passed. Off Vercel
 * (`next dev`, the e2e suite, CI, `bun test`) neither half runs: the browser
 * would wait on a challenge nobody answers, and the server check needs a
 * Vercel OIDC token. On Vercel the check fails open: if it throws (OIDC off,
 * Vercel's API down) the request goes through and the failure is logged, so a
 * fault in the bot check never costs a society its request; the ENG-35 limits
 * still apply. `REQUEST_BOT_CHECK=off` in Vercel's environment switches the
 * server check off at once, without a build (should it ever turn people away).
 *
 * `formSecret` (`REQUEST_FORM_SECRET`, server-only) is what makes the check
 * mean something: once Convex has it too, `submit` refuses callers without it,
 * so a script cannot go around this route (convex/listingRequests.ts).
 */

export const REQUEST_PATH = "/api/request"

/** A request is at most ~70 KB of text (30 fields of 2,000 characters and a
 * 5,000-character message); anything much bigger is not from the form. */
export const MAX_BODY_BYTES = 128 * 1024

const OR_WRITE = CONTACT_EMAIL ? `, or write to ${CONTACT_EMAIL}` : ""

export const SEND_FAILED = `Something went wrong sending your request. Please try again in a moment${OR_WRITE}.`
export const BOT_REFUSED = `We could not confirm this request came from a browser. Please reload the page and try again${OR_WRITE}.`

/** Whether this server checks requests with BotID: on Vercel, unless switched off. */
export function botCheckEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.VERCEL === "1" && env.REQUEST_BOT_CHECK !== "off"
}

/** The form's arguments as the browser may send them: `listingRequests.submit`'s
 * own, without `formSecret`, which only the server adds. Lengths are Convex's
 * to judge; the body cap bounds them here. */
const SubmitBody = z.strictObject({
  kind: z.enum(LISTING_REQUEST_KINDS),
  orgKey: z.string().optional(),
  submitterEmail: z.string(),
  role: z.string().optional(),
  message: z.string(),
  fields: z.record(z.string(), z.string()).optional(),
  eventKey: z.string().optional(),
})

type Verdict = { isBot: boolean }

export type SubmitDeps = {
  /** BotID's `checkBotId`. */
  checkBot: () => Promise<Verdict>
  /** `listingRequests.submit`. */
  submit: (args: SubmitArgs) => Promise<{ key: string }>
  env: Readonly<Record<string, string | undefined>>
}

function answer(body: { key: string } | { error: string }, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } })
}

/**
 * `POST /api/request`. Answers `{ key }` (200) once stored, or `{ error }`
 * with a sentence the form shows: 400 for a body the form would never send,
 * 403 for a bot, 413 for an oversized body, 422 for a refusal from Convex
 * (validation, the ENG-35 limits; its own words), 502 when Convex could not
 * be reached. Nothing the visitor wrote is ever logged.
 */
export async function handleRequestSubmit(request: Request, deps: SubmitDeps): Promise<Response> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return answer({ error: "That request is too long to send." }, 413)
  }
  const text = await request.text()
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    return answer({ error: "That request is too long to send." }, 413)
  }
  let parsed: z.infer<typeof SubmitBody>
  try {
    parsed = SubmitBody.parse(JSON.parse(text))
  } catch {
    return answer({ error: SEND_FAILED }, 400)
  }

  if (botCheckEnabled(deps.env)) {
    try {
      if ((await deps.checkBot()).isBot) return answer({ error: BOT_REFUSED }, 403)
    } catch (error) {
      console.error(
        `[request] BotID check failed (${error instanceof Error ? error.message : typeof error}); accepting the request`,
      )
    }
  }

  const secret = deps.env.REQUEST_FORM_SECRET
  try {
    const { key } = await deps.submit({ ...parsed, ...(secret ? { formSecret: secret } : {}) })
    return answer({ key }, 200)
  } catch (error) {
    if (error instanceof ConvexError && typeof error.data === "string") {
      return answer({ error: error.data }, 422)
    }
    // The name only: a validator's message would quote the arguments.
    console.error(
      `[request] listingRequests.submit failed: ${error instanceof Error ? error.name : typeof error}`,
    )
    return answer({ error: SEND_FAILED }, 502)
  }
}

export type SendResult = { ok: true; key: string } | { ok: false; error: string }

/**
 * The browser side: posts the form's arguments to `REQUEST_PATH`. `fetch` is
 * read at call time, so it is the one BotID patched in instrumentation-client.ts.
 * Gives up after `timeoutMs` (a challenge script that never loads would
 * otherwise leave the form spinning) and never throws.
 */
export async function sendListingRequest(
  args: SubmitArgs,
  { fetch: send = fetch, timeoutMs = 30_000 }: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<SendResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const response = await Promise.race([
      send(REQUEST_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(args),
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs)
      }),
    ])
    const body: unknown = await response.json().catch(() => null)
    const record = (body ?? {}) as { key?: unknown; error?: unknown }
    if (response.ok && typeof record.key === "string") return { ok: true, key: record.key }
    return { ok: false, error: typeof record.error === "string" ? record.error : SEND_FAILED }
  } catch {
    return { ok: false, error: SEND_FAILED }
  } finally {
    clearTimeout(timer)
  }
}
