import type { SubmitArgs } from "./listing-request"
import { CONTACT_EMAIL } from "./site"

/**
 * The browser's half of the request form's route (ENG-37): the path, the
 * sentences the form shows, and the sender. Kept apart from the server half
 * (lib/request-submit.ts) because instrumentation-client.ts imports
 * `REQUEST_PATH`, and whatever it imports loads on every page before
 * hydration: nothing here may pull in zod, `convex/values` or other server
 * code (request-client.test.ts checks the imports).
 */

export const REQUEST_PATH = "/api/request"

const OR_WRITE = CONTACT_EMAIL ? `, or write to ${CONTACT_EMAIL}` : ""

export const SEND_FAILED = `Something went wrong sending your request. Please try again in a moment${OR_WRITE}.`
export const BOT_REFUSED = `We could not confirm this request came from a browser. Please reload the page and try again${OR_WRITE}.`

export type SendResult = { ok: true; key: string } | { ok: false; error: string }

/**
 * Posts the form's arguments to `REQUEST_PATH`. `fetch` is read at call time,
 * so it is the one BotID patched in instrumentation-client.ts. Gives up after
 * `timeoutMs` (a challenge script that never loads would otherwise leave the
 * form spinning) and aborts the request then, so a slow route cannot still
 * store a request the visitor was told failed and is about to send again.
 * Never throws.
 */
export async function sendListingRequest(
  args: SubmitArgs,
  { fetch: send = fetch, timeoutMs = 30_000 }: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<SendResult> {
  const abort = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const response = await Promise.race([
      send(REQUEST_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(args),
        signal: abort.signal,
      }),
      // Also rejects on its own: a fetch that ignores the signal still ends here.
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort.abort()
          reject(new Error("timeout"))
        }, timeoutMs)
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
