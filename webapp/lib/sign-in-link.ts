/**
 * The emailed sign-in link goes to a confirm page, not to Better Auth's verify
 * endpoint (found 2026-11-08 on the first production link to an @cam.ac.uk inbox).
 *
 * Exchange Online's Safe Links, which every @cam.ac.uk mailbox has, opens each
 * link in incoming mail to scan it. A link to `/api/auth/magic-link/verify`
 * spends the one-time token on that scan, and the member then gets "expired or
 * already used". So the email carries `/sign-in/confirm#<verify query>`:
 *
 *  - the fragment never reaches a server, so a scanner fetching the page holds
 *    nothing it can spend;
 *  - the page turns the fragment back into the verify path only when the person
 *    presses Sign in, which a scanner does not do.
 *
 * Pure (no Convex, no DOM) so the backend (convex/betterAuth/auth.ts) and the
 * page share it and `bun test` covers it.
 */

export const CONFIRM_PATH = "/sign-in/confirm"
export const VERIFY_PATH = "/api/auth/magic-link/verify"

/** Query keys Better Auth's magic-link verify understands; nothing else passes. */
const ALLOWED = ["token", "callbackURL", "errorCallbackURL", "newUserCallbackURL"] as const
const TOKEN = /^[A-Za-z0-9_-]{16,256}$/

/** A same-origin path: starts with one slash, never `//` or `/\`. */
function samePath(value: string): boolean {
  return /^\/(?![/\\])/.test(value)
}

/** Better Auth's verify URL (`url` in `sendMagicLink`) → the confirm-page link. */
export function confirmLinkFor(verifyUrl: string): string {
  const url = new URL(verifyUrl)
  return `${url.origin}${CONFIRM_PATH}#${url.search.replace(/^\?/, "")}`
}

/**
 * The confirm page's fragment → the same-origin verify path to open, or null
 * when it is not a sign-in link (missing or malformed token, a foreign key, or a
 * callback that leaves the site).
 */
export function verifyPathFromFragment(fragment: string): string | null {
  const params = new URLSearchParams(fragment.replace(/^#/, ""))
  const token = params.get("token")
  if (!token || !TOKEN.test(token)) return null
  const out = new URLSearchParams()
  for (const [key, value] of params) {
    if (!(ALLOWED as readonly string[]).includes(key)) return null
    if (key !== "token" && !samePath(value)) return null
    if (out.has(key)) return null
    out.set(key, value)
  }
  return `${VERIFY_PATH}?${out.toString()}`
}
