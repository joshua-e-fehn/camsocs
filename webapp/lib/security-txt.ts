import { SECURITY_CONTACT_EMAIL, SECURITY_TXT_EXPIRES } from "@/lib/site"

/** The production origin, written out: the file is static, so it names the
 * live site whatever `NEXT_PUBLIC_SITE_URL` a build or test runs with. */
const ORIGIN = "https://camsocs.uk"

/**
 * The body of `/.well-known/security.txt` (RFC 9116): where to report a
 * security problem or a personal data breach, and until when this file holds.
 * What happens to a report: docs/compliance/breach-procedure.md.
 *
 * It is served as the static file `public/.well-known/security.txt` (no
 * dynamic render for a path researchers probe, SEO audit
 * manifest-security-txt-hsts); `lib/security-txt.test.ts` holds that file
 * equal to this, so the constants in lib/site.ts stay the one source: after
 * changing one, write the test's expected text into the file.
 */
export function securityTxt(): string {
  return [
    "# CAMsocs, an independent, unofficial directory of Cambridge student societies.",
    "# Report a security problem, or personal data from CAMsocs where it should not",
    "# be, to the address below; please do not test against other people's accounts",
    '# or data. RFC 9116. Renew "Expires" before it passes, keeping it under a year',
    "# ahead (RFC 9116 section 2.5.5).",
    `Contact: mailto:${SECURITY_CONTACT_EMAIL}`,
    `Expires: ${SECURITY_TXT_EXPIRES}`,
    "Preferred-Languages: en",
    `Canonical: ${ORIGIN}/.well-known/security.txt`,
    `Policy: ${ORIGIN}/about#security`,
    "",
  ].join("\n")
}
