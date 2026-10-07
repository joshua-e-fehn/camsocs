/**
 * The `@cam.ac.uk` sign-in link email, sent through Resend's HTTP API.
 *
 * Called from Better Auth's magic-link plugin (convex/betterAuth/auth.ts),
 * which runs inside the `/api/auth/*` HTTP action — a Convex action, so
 * `fetch` is available and the link (which carries a one-time token) never
 * passes through a scheduled function's stored arguments.
 *
 * Off until both env vars are set on the deployment; nothing else is needed:
 *
 *   bunx convex env set RESEND_API_KEY re_…
 *   bunx convex env set RESEND_FROM "camsocs <sign-in@<your verified domain>>"
 *
 * Unset, the plugin is not registered at all (the endpoint answers 404) and
 * `auth.getSignInOptions` tells the sign-in page to show the option as off.
 *
 * ⚠ Never log the link or the token: either is a session for its address.
 */

export const RESEND_ENDPOINT = "https://api.resend.com/emails"

/** How long a link works. Better Auth's default is 5 minutes; mail to
 * @cam.ac.uk (Exchange Online, with its scanning) can take a few. */
export const SIGN_IN_LINK_TTL_SECONDS = 10 * 60

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
export function buildSignInEmail(from: string, to: string, url: string): SignInEmail {
  const minutes = SIGN_IN_LINK_TTL_SECONDS / 60
  const lines = [
    "Sign in to camsocs with this link:",
    "",
    url,
    "",
    `It works once and expires in ${minutes} minutes. If you did not ask for it, ignore this email: nobody can sign in without the link.`,
    "",
    "camsocs is an unofficial directory of Cambridge student societies. It is not affiliated with the University of Cambridge or Cambridge SU.",
  ]
  const href = escapeHtml(url)
  const html = [
    '<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1f1d24">',
    "<p>Sign in to camsocs with this link:</p>",
    `<p><a href="${href}" style="display:inline-block;padding:10px 16px;border-radius:8px;background:#1f1d24;color:#ffffff;text-decoration:none">Sign in to camsocs</a></p>`,
    `<p style="font-size:13px;color:#5f5a66">Or paste this address into your browser:<br><span style="word-break:break-all">${href}</span></p>`,
    `<p style="font-size:13px;color:#5f5a66">It works once and expires in ${minutes} minutes. If you did not ask for it, ignore this email: nobody can sign in without the link.</p>`,
    '<p style="font-size:12px;color:#8a8590">camsocs is an unofficial directory of Cambridge student societies. It is not affiliated with the University of Cambridge or Cambridge SU.</p>',
    "</div>",
  ].join("")
  return { from, to: [to], subject: "Your camsocs sign-in link", text: lines.join("\n"), html }
}

/**
 * Sends the email. Throws a message safe to log (HTTP status and Resend's error
 * name, never the key or the link) when Resend refuses it.
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
