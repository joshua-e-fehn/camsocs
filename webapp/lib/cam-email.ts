/**
 * Which addresses unlock the Cambridge-only tier — the pure half of the
 * decision, shared by the server and the sign-in form.
 *
 *  - Server: the email sign-in link is refused for any other address
 *    (convex/betterAuth/auth.ts), and `getViewer` reads `isCamVerified` from
 *    the same rule on a *verified* address (convex/lib/viewer.ts).
 *  - Client: the form validates as you type, so the refusal is rarely seen.
 *
 * Exactly `@cam.ac.uk`, case-insensitive. Subdomains (`@srcf.cam.ac.uk`,
 * `@hermes.cam.ac.uk`, college domains) do not count: the University's mail
 * system is `@cam.ac.uk`, and a subdomain mailbox is not proof of membership.
 *
 * No server imports, so `bun test` and the client bundle can both use it.
 */

/** The longest address the form accepts (RFC 5321 path limit). */
export const MAX_EMAIL_LENGTH = 254

/** The canonical form of an address: trimmed and lowercased. */
export function normaliseCamEmail(email: string): string {
  return email.trim().toLowerCase()
}

/** Whether `email` is an `@cam.ac.uk` address (one `@`, no whitespace). */
export function isCamEmail(email: string): boolean {
  const address = normaliseCamEmail(email)
  return address.length <= MAX_EMAIL_LENGTH && /^[^@\s]+@cam\.ac\.uk$/.test(address)
}
