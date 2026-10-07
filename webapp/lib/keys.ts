import { sha1Hex, sha256Hex } from "./hash"

/**
 * Key minting, shared by Convex and mirrored byte for byte by the pipeline
 * (`pipeline/src/camsocs_pipeline/keys.py`). Cross-language fixtures in
 * `lib/keys.fixtures.json` are asserted by both test suites, so a change here
 * without the same change in keys.py fails CI on one side.
 *
 * Every entity is addressed by a minted string key, never a Convex `_id`
 * (data-model §0 rule 1). The shapes:
 *
 *   organisation  org-<slug>                       org-cu-german-society
 *   venue         ven-<slug>                       ven-west-road-concert-hall
 *   team          team-<org slug>--<team slug>     team-cuafc--blues
 *   session       ses-<sha1(orgKey:titleSlug:day:start)>
 *   event         evt-<sha1(source:externalId)>
 *   relationship  rel-<sha1(fromKey:type:toKey)>
 *   source        src-<sha1(url)>
 *   person        per-<sha1(orgKey:nameSlug)>    (broker table only)
 *
 * `--` separates parts because a slug never contains two hyphens in a row.
 *
 * ## slugify
 *
 *  1. Unicode NFKD (ligatures and full-width forms become ASCII, accents split off);
 *  2. a fixed transliteration for letters NFKD leaves alone (ß→ss, æ→ae, ø→o,
 *     œ→oe, ł→l, đ/ð→d, þ→th, ı→i, and their capitals);
 *  3. drop combining marks (general category M);
 *  4. `&` → ` and `; apostrophes (' ’ ʼ) are deleted, so "Queens'" → "queens";
 *  5. ASCII A–Z lowercased (only ASCII: the two languages' `lower()` differ);
 *  6. every run of characters outside [a-z0-9] → `-`; leading/trailing `-` trimmed;
 *  7. cut to 80 characters, trailing `-` trimmed again.
 *
 * A name with no ASCII letters or digits left is an error, not an empty slug.
 */

export const SLUG_MAX_LENGTH = 80

const TRANSLITERATION: Record<string, string> = {
  ß: "ss",
  æ: "ae",
  Æ: "ae",
  ø: "o",
  Ø: "o",
  œ: "oe",
  Œ: "oe",
  ł: "l",
  Ł: "l",
  đ: "d",
  Đ: "d",
  ð: "d",
  Ð: "d",
  þ: "th",
  Þ: "th",
  ı: "i",
}

const APOSTROPHES = /['’ʼ]/g
const COMBINING_MARKS = /\p{M}/gu

export function slugify(text: string): string {
  let out = text.normalize("NFKD")
  out = Array.from(out, (char) => TRANSLITERATION[char] ?? char).join("")
  out = out.replace(COMBINING_MARKS, "")
  out = out.replace(/&/g, " and ").replace(APOSTROPHES, "")
  out = out.replace(/[A-Z]/g, (char) => char.toLowerCase())
  out = out.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  out = out.slice(0, SLUG_MAX_LENGTH).replace(/-+$/g, "")
  if (out === "") throw new Error(`Cannot slugify ${JSON.stringify(text)}: nothing ASCII is left`)
  return out
}

export function orgKey(name: string): string {
  return `org-${slugify(name)}`
}

/** `org-cu-german-society` → `cu-german-society`. Throws on a non-org key. */
export function orgSlugFromKey(key: string): string {
  if (!key.startsWith("org-") || key.length <= 4) throw new Error(`Not an organisation key: ${key}`)
  return key.slice(4)
}

export function venueKey(name: string): string {
  return `ven-${slugify(name)}`
}

export function teamKey(organisationKey: string, teamName: string): string {
  return `team-${orgSlugFromKey(organisationKey)}--${slugify(teamName)}`
}

export function sessionKey(
  organisationKey: string,
  title: string,
  dayOfWeek?: number,
  startTime?: string,
): string {
  const parts = [organisationKey, slugify(title), dayOfWeek ?? "", startTime ?? ""]
  return `ses-${sha1Hex(parts.join(":"))}`
}

export function eventKey(source: string, externalId: string): string {
  return `evt-${sha1Hex(`${source}:${externalId}`)}`
}

export function relationshipKey(fromKey: string, type: string, toKey: string): string {
  return `rel-${sha1Hex(`${fromKey}:${type}:${toKey}`)}`
}

export function sourceKey(url: string): string {
  return `src-${sha1Hex(url)}`
}

export function personKey(organisationKey: string, name: string): string {
  return `per-${sha1Hex(`${organisationKey}:${slugify(name)}`)}`
}

/**
 * JSON with object keys sorted at every level and no whitespace — the
 * `json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`
 * of the Python side, except that Python must print integral floats as ints
 * (JS has one number type). `undefined` members are skipped, as in
 * `JSON.stringify`.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`
  const record = value as Record<string, unknown>
  const members = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
  return `{${members.join(",")}}`
}

/** What makes two claims the same observation (`fieldClaims.fingerprint`). */
export type FingerprintInput = {
  entityType: string
  entityKey: string
  field: string
  /** Absent for a negative claim (missing / not_applicable). */
  value?: unknown
  status: string
  missingReason?: string
  sourceUrl: string
  contentSha256?: string
  method: string
}

/**
 * sha256 over six newline-joined lines:
 *
 *   <entityType>:<entityKey>
 *   <field>
 *   <canonicalJson(value)>      or, for a negative claim, !<status>:<missingReason>
 *   <sourceUrl>
 *   <contentSha256 or "">
 *   <method>
 *
 * Re-posting the same observation of the same page content is a no-op; a
 * changed page (new content hash) or a changed value is a new claim.
 */
export function claimFingerprint(input: FingerprintInput): string {
  const valueLine =
    input.value === undefined
      ? `!${input.status}:${input.missingReason ?? ""}`
      : canonicalJson(input.value)
  return sha256Hex(
    [
      `${input.entityType}:${input.entityKey}`,
      input.field,
      valueLine,
      input.sourceUrl,
      input.contentSha256 ?? "",
      input.method,
    ].join("\n"),
  )
}
