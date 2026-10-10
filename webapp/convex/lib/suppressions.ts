import { sha1Hex, sha256Hex } from "../../lib/hash"
import type { EntityType, SuppressionScope } from "../../lib/vocab"
import type { QueryCtx } from "../_generated/server"

/**
 * The suppression list (retention.md R8, DPIA R-8): what accepted removals and
 * objections took off the site, so no later harvest brings it back.
 *
 * Six scopes:
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
 *  - `event` — one event, by key: deleted, and never recorded again.
 *  - `name` — a person's name (two words or more), stored only as the sha256
 *    of its normalised form (`nameHash`). A claim whose value names them is
 *    refused, on every listing, event and session; the pipeline cuts the name
 *    out of every public text before loading, and the projections do too.
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
  eventKey?: string
}

/** `sup-<sha1(scope:orgKey:field:valueHash:personKey[:eventKey])>`: the same
 * target is one row (an event key is appended only when there is one, so
 * older keys stay what they were). */
export function suppressionKey(target: SuppressionTarget): string {
  const parts = [
    target.scope,
    target.orgKey ?? "",
    target.field ?? "",
    target.valueHash ?? "",
    target.personKey ?? "",
    ...(target.eventKey ? [target.eventKey] : []),
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
  events: Set<string>
  /** `nameHash` of each name. */
  names: Set<string>
}

export function emptySuppressionIndex(): SuppressionIndex {
  return {
    organisations: new Set(),
    fields: new Set(),
    contacts: new Set(),
    people: new Set(),
    events: new Set(),
    names: new Set(),
  }
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
    if (row.scope === "event" && row.eventKey) index.events.add(row.eventKey)
    if (row.scope === "name" && row.valueHash) index.names.add(row.valueHash)
  }
  return index
}

// --- names --------------------------------------------------------------------------------------

/** A run of letters: a name's words, and the words of a text (shared with
 * pipeline/.../suppressions.py). */
const NAME_WORD = /\p{L}+/gu

/** A word as names are compared: accents dropped, lower case, letters a–z. */
function foldWord(word: string): string {
  return word
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "")
}

/** The words of a name as compared ("Anna-Lena O'Brien" → anna lena o brien). */
export function nameWords(name: string): string[] {
  return [...name.matchAll(NAME_WORD)].map((m) => foldWord(m[0])).filter(Boolean)
}

/** sha256 of a name's normalised words — how a name suppression stores it. */
export function nameHash(name: string): string {
  return sha256Hex(nameWords(name).join(" "))
}

/** Words in a suppressed name: a name is two words or more, at most this many. */
export const MAX_NAME_WORDS = 5

/**
 * The spans of `text` that spell a suppressed name (`names`: `nameHash`es):
 * runs of two to `MAX_NAME_WORDS` words that begin and end with a capital
 * (a name as written: "Anna Smith", "Anna van der Berg", "ANNA SMITH").
 */
export function nameSpans(text: string, names: ReadonlySet<string>): [number, number][] {
  if (names.size === 0) return []
  const words = [...text.matchAll(NAME_WORD)].map((m) => ({
    word: foldWord(m[0]),
    capital: m[0][0] !== m[0][0].toLowerCase(),
    start: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length,
  }))
  const spans: [number, number][] = []
  for (let first = 0; first < words.length; first++) {
    if (!words[first].capital) continue
    for (let size = 2; size <= MAX_NAME_WORDS && first + size <= words.length; size++) {
      const run = words.slice(first, first + size)
      if (!run[run.length - 1].capital) continue
      if (names.has(sha256Hex(run.map((w) => w.word).join(" ")))) {
        spans.push([run[0].start, run[run.length - 1].end])
      }
    }
  }
  return spans
}

/** `text` with every suppressed name replaced. */
export function redactNames(
  text: string,
  names: ReadonlySet<string>,
  replacement = "[name removed]",
): string {
  const spans = nameSpans(text, names)
  if (spans.length === 0) return text
  let out = ""
  let position = 0
  for (const [start, end] of spans.sort((a, b) => a[0] - b[0])) {
    if (start < position) continue
    out += text.slice(position, start) + replacement
    position = end
  }
  return out + text.slice(position)
}

/** Whether any text in `value` names a suppressed person. */
export function carriesSuppressedName(value: unknown, names: ReadonlySet<string>): boolean {
  if (names.size === 0 || value === undefined) return false
  if (typeof value === "string") return nameSpans(value, names).length > 0
  if (Array.isArray(value)) return value.some((item) => carriesSuppressedName(item, names))
  if (value !== null && typeof value === "object") {
    return Object.values(value).some((item) => carriesSuppressedName(item, names))
  }
  return false
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

/**
 * `value` (any public projection: an event, a card, a session, a listing with
 * its `meta`) with every suppressed address cut out of its text, and every
 * other reading in `meta[field].conflicts` that carries one dropped — the
 * backstop for what a contact suppression's walk has not reached yet. A
 * field whose other readings all go is no longer conflicting.
 */
export function scrubAddresses<T>(
  value: T,
  contacts: ReadonlySet<string>,
  names: ReadonlySet<string> = new Set(),
): T {
  if (contacts.size === 0 && names.size === 0) return value
  const walk = (item: unknown, key?: string): unknown => {
    if (typeof item === "string") return redactNames(redactAddresses(item, contacts), names)
    if (Array.isArray(item)) {
      const kept =
        key === "conflicts"
          ? item.filter((reading) => {
              const value = (reading as { value?: unknown })?.value
              return (
                !carriesSuppressedAddress(value, contacts) && !carriesSuppressedName(value, names)
              )
            })
          : key === "speakers"
            ? item.filter((speaker) => !carriesSuppressedName(speaker, names))
            : item
      return kept.map((entry) => walk(entry))
    }
    if (item !== null && typeof item === "object") {
      const out: Record<string, unknown> = {}
      for (const [name, entry] of Object.entries(item)) out[name] = walk(entry, name)
      // A conflict whose other readings all went is no conflict: the shown
      // value's own status, by its confidence band (as publicFieldMeta does).
      const meta = out as { status?: string; conflicts?: unknown[]; confidence?: number }
      if (meta.status === "conflicting" && meta.conflicts?.length === 0) {
        meta.status = (meta.confidence ?? 0) < 0.75 ? "inferred" : "found"
        delete meta.conflicts
      }
      return out
    }
    return item
  }
  return walk(value) as T
}

/** The contact suppressions' address hashes, for the projection backstop. */
export async function loadContactHashes(ctx: QueryCtx): Promise<Set<string>> {
  return await loadHashes(ctx, "contact")
}

/** The name suppressions' hashes, for the projection backstop. */
export async function loadNameHashes(ctx: QueryCtx): Promise<Set<string>> {
  return await loadHashes(ctx, "name")
}

async function loadHashes(ctx: QueryCtx, scope: "contact" | "name"): Promise<Set<string>> {
  const rows = await ctx.db
    .query("suppressions")
    .withIndex("by_scope", (q) => q.eq("scope", scope))
    .take(MAX_SUPPRESSIONS)
  return new Set(rows.flatMap((row) => (row.valueHash ? [row.valueHash] : [])))
}

/** The event suppressions' keys: those events are never shown. */
export async function loadSuppressedEvents(ctx: QueryCtx): Promise<Set<string>> {
  const rows = await ctx.db
    .query("suppressions")
    .withIndex("by_scope", (q) => q.eq("scope", "event"))
    .take(MAX_SUPPRESSIONS)
  return new Set(rows.flatMap((row) => (row.eventKey ? [row.eventKey] : [])))
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
 * - No value carrying a suppressed address, nor naming a person who objected.
 * - Nothing about a suppressed event.
 */
export function suppressedClaim(claim: CheckedClaim, index: SuppressionIndex): string | null {
  if (claim.entityType === "organisation" && index.organisations.has(claim.entityKey)) {
    return "suppressed: this listing was removed on request"
  }
  if (claim.entityType === "event" && index.events.has(claim.entityKey)) {
    return "suppressed: this event was removed on request"
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
  if (carriesSuppressedName(claim.value, index.names)) {
    return "suppressed: the value names a person who objected"
  }
  return null
}

/** The internal URI a suppression's own claims are attributed to (never shown). */
export function suppressionSourceUrl(key: string): string {
  return `suppression:${key}`
}
