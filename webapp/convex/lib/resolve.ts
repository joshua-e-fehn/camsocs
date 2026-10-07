import { canonicalJson } from "../../lib/keys"
import type {
  ClaimMethod,
  ClaimStatus,
  EvidenceKind,
  FieldStatus,
  MissingReason,
  QuoteCheck,
  ReviewStatus,
  SourceType,
} from "../../lib/vocab"
import { type CompareRule, type FieldSpec, hostOf, normaliseUrl } from "./fields"

/**
 * Field resolution: from the claims about one (entity, field) to the value the
 * entity shows and the `FieldMeta` that explains it. docs/data-model.md §1.
 *
 * Pure — no database, no clock — so every rule is unit-tested
 * (resolve.test.ts) and the ingestion mutation only reads claims and writes
 * what this returns.
 *
 * The rules, in the order they apply:
 *
 *  1. **Live claims.** Rejected and superseded claims are ignored. Of the rest,
 *     only the most recent claim per (sourceKey, method) counts: a page that
 *     used to list an email and no longer does has *changed its mind*, and the
 *     newer reading replaces the older (`liveClaims`). A parser and an LLM
 *     reading the same page are separate readings.
 *  2. **Status is normalised on the server** (`storedStatus`): `manual` /
 *     `owner_submitted` claims are `manual` / `owner_confirmed`; an LLM claim
 *     is `found` only with a verbatim quote check of `exact` or `normalised`,
 *     otherwise `inferred` — whatever the caller asked for.
 *  3. **Confidence is computed by rule** (`baseConfidence`, §1.1), never taken
 *     from the caller: parser primary .95, parser secondary .85, LLM with quote
 *     primary .85 / secondary .75, inferred .50, manual / owner 1.00; +.05 per
 *     additional agreeing independent source (distinct host), capped at .99.
 *  4. **Precedence** (§1.2): manual/owner → found+primary → found+secondary →
 *     inferred; ties to the most recent `lastSeenAt` (else `retrievedAt`).
 *  5. **Conflicts**: a value disagreeing with an equal-rank claim makes the
 *     status `conflicting`. The precedence winner stays the displayed value and
 *     every other reading is kept in `meta.conflicts`. Manual claims never
 *     conflict (the latest override wins); `text` fields never conflict.
 *  6. **Missing**: with no live value claim, the field is `missing` — with the
 *     `missingReason` of the best negative claim (a 404 is `not_found`, a 403
 *     `access_restricted`), or `not_attempted` when no source has spoken. A
 *     `not_applicable` claim, or an inapplicable field nobody claimed, is
 *     `not_applicable`. An empty array is not a value: it counts as `not_found`.
 */

export type StoredClaimStatus = Exclude<FieldStatus, "conflicting">

/** The subset of a `fieldClaims` row resolution reads. */
export type ResolvableClaim = {
  value?: unknown
  /** As stored (never `conflicting` in practice; that is a resolution outcome). */
  status: FieldStatus
  evidence: EvidenceKind
  method: ClaimMethod
  quoteCheck?: QuoteCheck
  missingReason?: MissingReason
  sourceKey: string
  sourceUrl: string
  sourceType: SourceType
  retrievedAt: number
  lastSeenAt?: number
  reviewStatus: ReviewStatus
}

export type FieldConflict = {
  value: unknown
  sourceUrl: string
  sourceType: SourceType
  retrievedAt: number
  method: ClaimMethod
}

export type FieldMeta = {
  status: FieldStatus
  evidence?: EvidenceKind
  missingReason?: MissingReason
  confidence?: number
  sourceUrl?: string
  sourceType?: SourceType
  retrievedAt?: number
  method?: ClaimMethod
  claimCount?: number
  conflicts?: FieldConflict[]
}

export type Resolution = {
  /** The value the entity shows; undefined when there is none. */
  value: unknown
  meta: FieldMeta
}

// --- per-claim rules ------------------------------------------------------------------

/**
 * The status a claim is stored with, whatever the caller asked for (rule 2).
 * `hasValue` false means a negative claim (`missing` / `not_applicable`).
 */
export function storedStatus(input: {
  method: ClaimMethod
  requested?: ClaimStatus
  quoteCheck?: QuoteCheck
  hasQuote: boolean
  hasValue: boolean
}): StoredClaimStatus {
  if (!input.hasValue) return input.requested === "not_applicable" ? "not_applicable" : "missing"
  if (input.method === "manual") return "manual"
  if (input.method === "owner_submitted") return "owner_confirmed"
  if (input.method === "llm") {
    const quoted =
      input.hasQuote && (input.quoteCheck === "exact" || input.quoteCheck === "normalised")
    return quoted && input.requested !== "inferred" ? "found" : "inferred"
  }
  return input.requested === "inferred" ? "inferred" : "found"
}

/** Base confidence by rule (§1.1). Negative claims use the same table: a
 * parser reading "no email on this page" is as reliable as one reading an email. */
export function baseConfidence(claim: {
  method: ClaimMethod
  status: FieldStatus
  evidence: EvidenceKind
}): number {
  if (claim.method === "manual" || claim.method === "owner_submitted") return 1
  if (claim.status === "inferred") return 0.5
  const primary = claim.evidence === "primary"
  if (claim.method === "parser") return primary ? 0.95 : 0.85
  if (claim.status === "missing" || claim.status === "not_applicable") return 0.5
  return primary ? 0.85 : 0.75
}

/** Precedence rank (§1.2): lower wins. Negative claims have no rank. */
export function precedenceTier(claim: ResolvableClaim): number {
  if (claim.status === "manual" || claim.status === "owner_confirmed") return 0
  if (claim.status === "found") return claim.evidence === "primary" ? 1 : 2
  return 3
}

const recency = (claim: ResolvableClaim) => claim.lastSeenAt ?? claim.retrievedAt

/** Rule 1: drop rejected / superseded, keep the newest claim per (sourceKey, method). */
export function liveClaims<C extends ResolvableClaim>(claims: readonly C[]): C[] {
  const latest = new Map<string, C>()
  for (const claim of claims) {
    if (claim.reviewStatus === "rejected" || claim.reviewStatus === "superseded") continue
    const group = `${claim.sourceKey}\u0000${claim.method}`
    const current = latest.get(group)
    if (!current || claim.retrievedAt > current.retrievedAt) latest.set(group, claim)
  }
  return [...latest.values()]
}

function isEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0
}

function hasValue(claim: ResolvableClaim): boolean {
  return claim.value !== undefined && !isEmptyArray(claim.value)
}

/** Comparable form of a value under a compare rule. */
export function comparable(rule: CompareRule, value: unknown): string {
  if (rule === "email" && typeof value === "string") return value.trim().toLowerCase()
  if (rule === "url" && typeof value === "string") return normaliseUrl(value)
  if (typeof value === "string") return JSON.stringify(value.trim())
  return canonicalJson(value)
}

function byPrecedence(a: ResolvableClaim, b: ResolvableClaim): number {
  return (
    precedenceTier(a) - precedenceTier(b) ||
    recency(b) - recency(a) ||
    (a.sourceKey < b.sourceKey ? -1 : a.sourceKey > b.sourceKey ? 1 : 0)
  )
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function provenance(claim: ResolvableClaim): Omit<FieldMeta, "status"> {
  return {
    evidence: claim.evidence,
    sourceUrl: claim.sourceUrl,
    sourceType: claim.sourceType,
    retrievedAt: recency(claim),
    method: claim.method,
  }
}

// --- resolution --------------------------------------------------------------------------

/**
 * Resolves one field from all its claims (any review status; rule 1 filters).
 * `applicable` false turns "nobody claimed it" into `not_applicable`.
 */
export function resolveField(
  spec: Pick<FieldSpec, "merge" | "compare" | "itemKey">,
  claims: readonly ResolvableClaim[],
  options: { applicable?: boolean } = {},
): Resolution {
  const live = liveClaims(claims)
  const values = live.filter(hasValue).sort(byPrecedence)
  if (values.length === 0) return resolveAbsent(live, options.applicable ?? true)
  if (spec.merge === "union") return resolveUnion(spec, values)
  if (spec.merge === "max") return resolveMax(values)
  return resolveSingle(spec.compare, values)
}

function resolveAbsent(live: readonly ResolvableClaim[], applicable: boolean): Resolution {
  const negatives = live
    .filter((claim) => !hasValue(claim))
    .sort(
      (a, b) =>
        (a.evidence === "primary" ? 0 : 1) - (b.evidence === "primary" ? 0 : 1) ||
        recency(b) - recency(a),
    )
  const best = negatives[0]
  if (!best) {
    return {
      value: undefined,
      meta: applicable
        ? { status: "missing", missingReason: "not_attempted" }
        : { status: "not_applicable" },
    }
  }
  const status = best.status === "not_applicable" ? "not_applicable" : "missing"
  return {
    value: undefined,
    meta: {
      status,
      ...(status === "missing" ? { missingReason: best.missingReason ?? "not_found" } : {}),
      confidence: baseConfidence(best),
      ...provenance(best),
      claimCount: new Set(negatives.map((claim) => hostOf(claim.sourceUrl))).size,
    },
  }
}

function resolveSingle(rule: CompareRule, values: readonly ResolvableClaim[]): Resolution {
  const winner = values[0]
  const winnerTier = precedenceTier(winner)
  const winnerKey = comparable(rule, winner.value)
  const agreeing = values.filter((claim) => comparable(rule, claim.value) === winnerKey)
  const hosts = new Set(agreeing.map((claim) => hostOf(claim.sourceUrl)))

  const conflicts: FieldConflict[] = []
  if (winnerTier !== 0 && rule !== "text") {
    const seen = new Set([winnerKey])
    for (const claim of values) {
      if (precedenceTier(claim) !== winnerTier) continue
      const key = comparable(rule, claim.value)
      if (seen.has(key)) continue
      seen.add(key)
      conflicts.push({
        value: claim.value,
        sourceUrl: claim.sourceUrl,
        sourceType: claim.sourceType,
        retrievedAt: recency(claim),
        method: claim.method,
      })
    }
  }

  const confidence =
    winnerTier === 0 ? 1 : Math.min(0.99, baseConfidence(winner) + 0.05 * (hosts.size - 1))
  return {
    value: winner.value,
    meta: {
      status: conflicts.length > 0 ? "conflicting" : winner.status,
      confidence: round2(confidence),
      ...provenance(winner),
      claimCount: hosts.size,
      ...(conflicts.length > 0 ? { conflicts } : {}),
    },
  }
}

/**
 * Union fields: an override (manual / owner) replaces everything; otherwise
 * the items of every `found` claim, or of the `inferred` ones when nothing was
 * found. Items keep the order of the claims that contributed them.
 */
function resolveUnion(
  spec: Pick<FieldSpec, "itemKey">,
  values: readonly ResolvableClaim[],
): Resolution {
  const best = values[0]
  const bestTier = precedenceTier(best)
  const contributors =
    bestTier === 0
      ? [best]
      : bestTier < 3
        ? values.filter((claim) => precedenceTier(claim) < 3)
        : values
  const keyOf = spec.itemKey ?? ((item: unknown) => canonicalJson(item))
  const seen = new Set<string>()
  const items: unknown[] = []
  for (const claim of contributors) {
    for (const item of claim.value as unknown[]) {
      const key = keyOf(item)
      if (seen.has(key)) continue
      seen.add(key)
      items.push(item)
    }
  }
  const hosts = new Set(contributors.map((claim) => hostOf(claim.sourceUrl)))
  return {
    value: items,
    meta: {
      status: best.status,
      confidence: round2(bestTier === 0 ? 1 : baseConfidence(best)),
      ...provenance(best),
      claimCount: hosts.size,
    },
  }
}

/** `max` fields: the latest timestamp any live claim reports. */
function resolveMax(values: readonly ResolvableClaim[]): Resolution {
  const winner = [...values].sort(
    (a, b) => (b.value as number) - (a.value as number) || byPrecedence(a, b),
  )[0]
  return {
    value: winner.value,
    meta: {
      status: winner.status,
      confidence: round2(baseConfidence(winner)),
      ...provenance(winner),
      claimCount: 1,
    },
  }
}

/** Whether a meta entry carries claim evidence (vs a placeholder for a field
 * nobody has claimed, whose status depends only on applicability). */
export function hasClaimEvidence(meta: FieldMeta | undefined): boolean {
  return meta?.method !== undefined
}

/** The meta of a field nobody has claimed. */
export function unclaimedMeta(applicable: boolean): FieldMeta {
  return applicable
    ? { status: "missing", missingReason: "not_attempted" }
    : { status: "not_applicable" }
}
