import { CAMBRIDGE } from "./campus"
import { isMemberEmail, MAX_EMAIL_LENGTH, normaliseEmail } from "./campus/member-email"

/**
 * Which addresses unlock the Cambridge-only tier — the pure half of the
 * decision, shared by the server and the sign-in form. Cambridge's wrappers
 * over the campus rule (lib/campus/member-email.ts, decision D8), with the
 * same behaviour as before.
 *
 *  - Server: the email sign-in link is refused for any other address
 *    (convex/betterAuth/auth.ts), and `getViewer` reads `isCamVerified` from
 *    the same rule on a *verified* address (convex/lib/viewer.ts); both ask
 *    the deployment's campus (`deploymentProfile()`), which is Cambridge
 *    unless `CAMSOCS_CAMPUS` says otherwise.
 *  - Client: the form validates as you type, so the refusal is rarely seen.
 *
 * Exactly `@cam.ac.uk`, case-insensitive. Subdomains (`@srcf.cam.ac.uk`,
 * `@hermes.cam.ac.uk`, college domains) do not count: the University's mail
 * system is `@cam.ac.uk`, and a subdomain mailbox is not proof of membership.
 *
 * No server imports, so `bun test` and the client bundle can both use it.
 */

/** The longest address the form accepts (RFC 5321 path limit). */
export { MAX_EMAIL_LENGTH }

/** The canonical form of an address: trimmed and lowercased. */
export function normaliseCamEmail(email: string): string {
  return normaliseEmail(email)
}

/** Whether `email` is an `@cam.ac.uk` address (one `@`, no whitespace). */
export function isCamEmail(email: string): boolean {
  return isMemberEmail(email, CAMBRIDGE)
}
