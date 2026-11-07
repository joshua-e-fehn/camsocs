import type { CampusProfile } from "./profile"

/**
 * A campus's member addresses, as pure functions (decision D8):
 *
 *  - `isMemberEmail`: which addresses unlock the members-only tier
 *    (`cam_only`, "members of this deployment's campus only"): exactly one of
 *    the member domains, never a subdomain, because a subdomain mailbox is no
 *    proof of membership;
 *  - `classifyMemberEmail`: whether an address names one member, the
 *    `personal_crsid` rule of `classifyEmail` (convex/lib/derived.ts), which
 *    the public projection never shows.
 *
 * Cambridge's rules (`strictForeignAcademic: false`) are today's, byte for
 * byte: email-types.fixtures.json and campuses.fixtures.json hold them.
 */

/** The longest address the sign-in form accepts (RFC 5321 path limit). */
export const MAX_EMAIL_LENGTH = 254

/** A name-shaped local part: two or three plain words (`jane.smith`);
 * mirrored in pipeline/.../sources/links.py `_NAME_SHAPED`. */
export const NAME_SHAPED_LOCAL = /^[a-z]+[._-][a-z]+(?:[._-][a-z]+)?$/

/** The canonical form of an address: trimmed and lowercased. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase()
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const memberAddressPatterns = new WeakMap<CampusProfile, RegExp>()

/** `^[^@\s]+@(domain|…)$` over the profile's member domains, built once. */
function memberAddressPattern(profile: CampusProfile): RegExp {
  let pattern = memberAddressPatterns.get(profile)
  if (!pattern) {
    const domains = profile.facts.memberEmail.domains.map(escapeRegExp).join("|")
    pattern = new RegExp(`^[^@\\s]+@(?:${domains})$`)
    memberAddressPatterns.set(profile, pattern)
  }
  return pattern
}

/** Whether `email` unlocks the profile's members-only tier: one `@`, no
 * whitespace, exactly a member domain (Cambridge: `@cam.ac.uk`),
 * case-insensitive, at most `MAX_EMAIL_LENGTH` long. */
export function isMemberEmail(email: string, profile: CampusProfile): boolean {
  const address = normaliseEmail(email)
  return address.length <= MAX_EMAIL_LENGTH && memberAddressPattern(profile).test(address)
}

const idPatterns = new Map<string, RegExp>()

function idPattern(source: string): RegExp {
  let pattern = idPatterns.get(source)
  if (!pattern) {
    pattern = new RegExp(source)
    idPatterns.set(source, pattern)
  }
  return pattern
}

const isAtOrUnder = (domain: string, base: string) => domain === base || domain.endsWith(`.${base}`)

/** Whether `domain` is a member domain or (with `includeSubdomains`) under
 * one, and not one of the excluded list hosts. */
export function isMemberDomain(domain: string, profile: CampusProfile): boolean {
  const rule = profile.facts.memberEmail
  if (rule.excluded.includes(domain)) return false
  return rule.domains.some((base) =>
    rule.includeSubdomains ? isAtOrUnder(domain, base) : domain === base,
  )
}

/** Whether an academic domain is the campus's own or one it knows. */
function isFamiliarDomain(domain: string, profile: CampusProfile): boolean {
  const { facts } = profile
  return (
    [...facts.memberEmail.domains, ...facts.universityDomains].some((base) =>
      isAtOrUnder(domain, base),
    ) ||
    facts.memberEmail.forwarding.includes(domain) ||
    facts.memberEmail.alumni.includes(domain)
  )
}

/**
 * `personal_crsid` when the address names one member, else undefined (the
 * caller goes on to the other kinds). Lowercased `local` and `domain`.
 *
 *  - On a member domain or a forwarding domain, a local part shaped like a
 *    member id names a person (Cambridge's CRSid on cam.ac.uk, its
 *    subdomains, SRCF and cantab). Errs toward hiding a role address like
 *    `jcr1@`.
 *  - A campus without id-shaped addresses (`idPattern: null`): a name-shaped
 *    local part (`jane.doe@`) there names a person.
 *  - `strictForeignAcademic`: any unfamiliar `*.ac.uk` address is a person's,
 *    whatever its shape, until the campus learns that university's rules.
 */
export function classifyMemberEmail(
  local: string,
  domain: string,
  profile: CampusProfile,
): "personal_crsid" | undefined {
  const rule = profile.facts.memberEmail
  const personalShape = rule.idPattern === null ? NAME_SHAPED_LOCAL : idPattern(rule.idPattern)
  if (
    (isMemberDomain(domain, profile) || rule.forwarding.includes(domain)) &&
    personalShape.test(local)
  ) {
    return "personal_crsid"
  }
  if (
    rule.strictForeignAcademic &&
    domain.endsWith(".ac.uk") &&
    !isFamiliarDomain(domain, profile)
  ) {
    return "personal_crsid"
  }
  return undefined
}
