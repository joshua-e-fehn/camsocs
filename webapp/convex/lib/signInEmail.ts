import type { CampusProfile } from "../../lib/campus"
import { deploymentProfile } from "../../lib/campus/deployment"

/**
 * The member sign-in code email (Cambridge: `@cam.ac.uk`), sent through
 * Resend's HTTP API. Its product name and closing disclaimer are the
 * deployment's campus's (lib/campus, decision D8).
 *
 * A code, not a link (2026-11-08): Exchange Online's pre-delivery scanning,
 * which every @cam.ac.uk mailbox has, opened each emailed sign-in link and even
 * pressed the button of a confirm page, so every link was spent (and a session
 * created in the scanner) before the member saw it. A code typed on the page
 * that asked for it cannot be used by a scanner.
 *
 * Called from Better Auth's email-OTP plugin (convex/betterAuth/auth.ts),
 * inside the `/api/auth/*` HTTP action, so `fetch` is available.
 *
 * Off until both env vars are set on the deployment; nothing else is needed:
 *
 *   bunx convex env set RESEND_API_KEY re_…
 *   bunx convex env set RESEND_FROM "CAMsocs <sign-in@mail.camsocs.uk>"   # production (D12)
 *
 * Unset, the plugin is not registered at all (its endpoints answer 404) and
 * `auth.getSignInOptions` tells the sign-in page to show the option as off.
 *
 * ⚠ Never log the code: it is a session for its address.
 */

export const RESEND_ENDPOINT = "https://api.resend.com/emails"

/** How long a code works. Better Auth's default is 5 minutes; mail to
 * @cam.ac.uk (Exchange Online, with its scanning) took 4 on 2026-11-08. */
export const SIGN_IN_CODE_TTL_SECONDS = 10 * 60
/** Wrong guesses allowed per code; a new code needs a new request (throttled). */
export const SIGN_IN_CODE_ATTEMPTS = 5

export type ResendConfig = { apiKey: string; from: string }

/** Both values, or null when the email option is switched off. Read per call
 * so setting the env vars takes effect without a deploy. */
export function resendConfig(env: Record<string, string | undefined> = process.env) {
  const apiKey = env.RESEND_API_KEY?.trim()
  const from = env.RESEND_FROM?.trim()
  return apiKey && from ? ({ apiKey, from } satisfies ResendConfig) : null
}

export type SignInEmail = {
  from: string
  to: string[]
  subject: string
  text: string
  html: string
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** The message, as Resend's `POST /emails` body. Pure. */
export function buildSignInEmail(
  from: string,
  to: string,
  code: string,
  profile: CampusProfile = deploymentProfile(),
): SignInEmail {
  const minutes = SIGN_IN_CODE_TTL_SECONDS / 60
  const product = profile.brand.name
  const disclaimer = profile.brand.emailDisclaimer
  const note = `Type it on the ${product} sign-in page where you asked for it. It works once and expires in ${minutes} minutes. If you did not ask for it, ignore this email: nobody can sign in without the code.`
  const lines = [`Your ${product} sign-in code:`, "", code, "", note, "", disclaimer]
  const html = [
    '<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1f1d24">',
    `<p>Your ${escapeHtml(product)} sign-in code:</p>`,
    `<p style="font-family:ui-monospace,Menlo,monospace;font-size:28px;font-weight:600;letter-spacing:6px;margin:12px 0">${escapeHtml(code)}</p>`,
    `<p style="font-size:13px;color:#5f5a66">${escapeHtml(note)}</p>`,
    `<p style="font-size:12px;color:#8a8590">${escapeHtml(disclaimer)}</p>`,
    "</div>",
  ].join("")
  return {
    from,
    to: [to],
    subject: `${code} is your ${product} sign-in code`,
    text: lines.join("\n"),
    html,
  }
}

/**
 * Sends the email. Throws a message safe to log (HTTP status and Resend's error
 * name, never the key or the code) when Resend refuses it.
 */
export async function sendSignInEmail(
  config: ResendConfig,
  message: SignInEmail,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(message),
  })
  if (response.ok) return
  let name = ""
  try {
    const body = (await response.json()) as { name?: unknown }
    if (typeof body.name === "string") name = `: ${body.name.slice(0, 80)}`
  } catch {
    // Not JSON; the status alone is the message.
  }
  throw new Error(`Resend refused the sign-in email (HTTP ${response.status}${name})`)
}
