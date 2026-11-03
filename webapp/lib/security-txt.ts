import { SECURITY_CONTACT_EMAIL, SECURITY_TXT_EXPIRES, SITE_URL } from "@/lib/site"

/**
 * The body of `/.well-known/security.txt` (RFC 9116), served by
 * app/.well-known/security.txt/route.ts: where to report a security problem
 * or a personal data breach, and until when this file holds. What happens to
 * a report: docs/compliance/breach-procedure.md.
 */
export function securityTxt(): string {
  return [
    `Contact: mailto:${SECURITY_CONTACT_EMAIL}`,
    `Expires: ${SECURITY_TXT_EXPIRES}`,
    "Preferred-Languages: en",
    `Canonical: ${SITE_URL}/.well-known/security.txt`,
    `Policy: ${SITE_URL}/about#security`,
    "",
  ].join("\n")
}
