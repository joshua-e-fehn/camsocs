import { sha1Hex, sha256Hex } from "../../lib/hash"
import type { EntityType, SuppressionScope } from "../../lib/vocab"
import type { QueryCtx } from "../_generated/server"

/**
 * The suppression list (retention.md R8, DPIA R-8): what accepted removals and
 * objections took off the site, so no later harvest brings it back.
 *
 * Four scopes:
 *
 *  - `organisation` — the whole listing. It is hidden (no directory card, so
 *    no public query lists, names or links it) and no claim about it is
 *    recorded again, so even a deleted row cannot be re-created.
 *  - `field` — one field of one listing. Its value claims are refused; the
 *    field reads `missing` / `not_published`.
 *  - `contact` — one address, stored only as the sha256 of its normalised form
 *    (`contactHash`). A claim whose value carries it is refused, for every
 *    listing; the pipeline cuts it out of free text before loading.
 *  - `person` — one named person in the private broker tables, by key.
 *
 * Three layers enforce it: the pipeline filters before it loads (it reads
 * this list through `POST /api/pipeline/suppressions`), the ingestion
 * mutations refuse what slips through (`suppressedClaim` and friends), and
 * accepting a suppression cleans up what is already stored
 * (convex/broker/listingRequests.ts).
 */

/** Suppressions read per check. Each is one small row; thousands are far off. */
export const MAX_SUPPRESSIONS = 5_000

/** The normalised form an address is hashed in: trimmed, lower-cased. */
export function normaliseAddress(address: string): string {
  return address.trim().toLowerCase()
}

/** sha256 of the normalised address — how a contact suppression stores it. */
export function contactHash(address: string): string {
  return sha256Hex(normaliseAddress(address))
}

export type SuppressionTarget = {
  scope: SuppressionScope
  orgKey?: string
  field?: string
  valueHash?: string
  personKey?: string
}

/** `sup-<sha1(scope:orgKey:field:valueHash:personKey)>`: the same target is one row. */
export function suppressionKey(target: SuppressionTarget): string {
  const parts = [
    target.scope,
    target.orgKey ?? "",
    target.field ?? "",
    target.valueHash ?? "",
    target.personKey ?? "",
  ]
  return `sup-${sha1Hex(parts.join(":"))}`
}

/** The suppression list as sets, for checking many claims at once. */
export type SuppressionIndex = {
  organisations: Set<string>
  /** `${orgKey}\u0000${field}`. */
  fields: Set<string>
  contacts: Set<string>
  people: Set<string>
}

export function emptySuppressionIndex(): SuppressionIndex {
  return { organisations: new Set(), fields: new Set(), contacts: new Set(), people: new Set() }
}

export function indexSuppressions(rows: readonly SuppressionTarget[]): SuppressionIndex {
  const index = emptySuppressionIndex()
  for (const row of rows) {
    if (row.scope === "organisation" && row.orgKey) index.organisations.add(row.orgKey)
    if (row.scope === "field" && row.orgKey && row.field) {
      index.fields.add(`${row.orgKey}\u0000${row.field}`)
    }
    if (row.scope === "contact" && row.valueHash) index.contacts.add(row.valueHash)
    if (row.scope === "person" && row.personKey) index.people.add(row.personKey)
  }
  return index
}

export async function loadSuppressionIndex(ctx: QueryCtx): Promise<SuppressionIndex> {
  return indexSuppressions(await ctx.db.query("suppressions").take(MAX_SUPPRESSIONS))
}

const ADDRESS = /[^\s@<>()[\]\\,;:"'`]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi

/** Every email-shaped token anywhere in a claim value (strings, arrays,
 * objects): an `email`, the `roleEmails` entries, a mailing list's address,
 * an address quoted in a description. Normalised. */
export function addressesIn(value: unknown): string[] {
  const found = new Set<string>()
  const walk = (item: unknown): void => {
    if (typeof item === "string") {
      for (const match of item.matchAll(ADDRESS)) found.add(normaliseAddress(match[0]))
    } else if (Array.isArray(item)) {
      for (const entry of item) walk(entry)
    } else if (item !== null && typeof item === "object") {
      for (const entry of Object.values(item)) walk(entry)
    }
  }
  walk(value)
  return [...found]
}

/** `text` with every address whose hash is in `contacts` replaced. */
export function redactAddresses(
  text: string,
  contacts: ReadonlySet<string>,
  replacement = "[address removed]",
): string {
  if (contacts.size === 0) return text
  return text.replace(ADDRESS, (match) => (contacts.has(contactHash(match)) ? replacement : match))
}

/** Whether `value` carries an address whose hash is suppressed. */
export function carriesSuppressedAddress(value: unknown, contacts: ReadonlySet<string>): boolean {
  if (contacts.size === 0 || value === undefined) return false
  return addressesIn(value).some((address) => contacts.has(contactHash(address)))
}

/** The part of a claim the suppression check reads. */
export type CheckedClaim = {
  entityType: EntityType
  entityKey: string
  field: string
  value?: unknown
}

/**
 * Why a claim may not be recorded under the suppression list, or null.
 *
 * - Nothing about a suppressed organisation, nor a team or session that would
 *   belong to one.
 * - No value for a suppressed field (a negative claim is fine: it is how the
 *   field comes to read `not_published`).
 * - No value carrying a suppressed address.
 */
export function suppressedClaim(claim: CheckedClaim, index: SuppressionIndex): string | null {
  if (claim.entityType === "organisation" && index.organisations.has(claim.entityKey)) {
    return "suppressed: this listing was removed on request"
  }
  if (claim.value === undefined) return null
  if (
    (claim.entityType === "team" || claim.entityType === "session") &&
    claim.field === "orgKey" &&
    typeof claim.value === "string" &&
    index.organisations.has(claim.value)
  ) {
    return "suppressed: its organisation was removed on request"
  }
  if (
    claim.entityType === "organisation" &&
    index.fields.has(`${claim.entityKey}\u0000${claim.field}`)
  ) {
    return `suppressed: ${claim.field} was removed from this listing on request`
  }
  if (carriesSuppressedAddress(claim.value, index.contacts)) {
    return "suppressed: the value carries a contact address removed on request"
  }
  return null
}

/** The internal URI a suppression's own claims are attributed to (never shown). */
export function suppressionSourceUrl(key: string): string {
  return `suppression:${key}`
}
