/**
 * Syntax checks shared by the Convex validators (convex/lib/fields.ts, which
 * re-exports them) and the public form's in-browser validation — one
 * definition, so the form never accepts what the server refuses.
 */

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i

/** A plausible email address (syntax only; never a reason to guess one). */
export function isEmail(value: string): boolean {
  return EMAIL.test(value) && value.length <= 254
}

/** Every URL we store may end up as an `href`: http(s) only. */
export function isHttpUrl(value: string): boolean {
  return /^https?:\/\/[^\s/]+\.[^\s]*$/i.test(value) && value.length <= 2048
}
