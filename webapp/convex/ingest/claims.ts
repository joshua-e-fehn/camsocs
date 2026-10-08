import { type Infer, v } from "convex/values"
import { claimFingerprint } from "../../lib/keys"
import {
  CLAIM_METHODS,
  CLAIM_STATUSES,
  ENTITY_TYPES,
  type EntityType,
  EVIDENCE_KINDS,
  MISSING_REASONS,
  QUOTE_CHECKS,
  SOURCE_TYPES,
} from "../../lib/vocab"
import type { Doc } from "../_generated/dataModel"
import { internalMutation, type MutationCtx } from "../_generated/server"
import { checkValue } from "../lib/checkValue"
import { DAY_MS, type TermDates } from "../lib/derived"
import {
  ENTITY_TABLES,
  type EntityDoc,
  findEntity,
  latestPastEventAt,
  loadTerms,
  refreshOrganisation,
  syncEventOrganiserRows,
  writeOrgCard,
} from "../lib/entityStore"
import { FIELD_SPECS, KEY_PREFIXES } from "../lib/fields"
import { assertBatchSize, sameFields } from "../lib/ingest"
import { materialise, requiredFields } from "../lib/materialise"
import { baseConfidence, type Resolution, resolveField, storedStatus } from "../lib/resolve"
import { literalUnion } from "../lib/validators"

/**
 * `POST /api/pipeline/claims` — the one way field values reach the entity
 * tables (data-model §0 rules 2–4).
 *
 * For each claim: validate it, normalise its status, compute its confidence
 * by rule and its fingerprint, and append it to `fieldClaims` (a re-posted
 * observation is a no-op; a newer reading from the same source and method
 * supersedes the older one). Then, per entity, re-resolve the touched fields
 * (convex/lib/resolve.ts), materialise the row with its derived fields
 * (convex/lib/materialise.ts), and write it only if something changed. An
 * entity row is created on its first claims — if they carry its required
 * fields.
 *
 * A bad claim is rejected *individually* and reported back with the reason;
 * the rest of the batch still lands. The caller never sends `confidence`
 * (the validator rejects it) and never sends `null` (omit the value and say
 * `status: "missing"` instead).
 */

export const claimInputValidator = v.object({
  entityType: literalUnion(ENTITY_TYPES),
  entityKey: v.string(),
  field: v.string(),
  /** The observed value. Omit for a negative claim; never null. */
  value: v.optional(v.any()),
  /** The text the value was read from, when it was transformed. */
  valueRaw: v.optional(v.string()),
  /** Default `found` for a value, required (`missing` / `not_applicable`) without one. */
  status: v.optional(literalUnion(CLAIM_STATUSES)),
  missingReason: v.optional(literalUnion(MISSING_REASONS)),
  evidence: literalUnion(EVIDENCE_KINDS),
  method: literalUnion(CLAIM_METHODS),
  extractor: v.string(),
  promptVersion: v.optional(v.string()),
  evidenceQuote: v.optional(v.string()),
  quoteCheck: v.optional(literalUnion(QUOTE_CHECKS)),
  sourceKey: v.string(),
  sourceUrl: v.string(),
  sourceType: literalUnion(SOURCE_TYPES),
  retrievedAt: v.number(),
  contentSha256: v.optional(v.string()),
})
export type ClaimInput = Infer<typeof claimInputValidator>

const rejectedValidator = v.object({
  index: v.number(),
  entityType: v.string(),
  entityKey: v.string(),
  field: v.string(),
  reason: v.string(),
})
type Rejected = Infer<typeof rejectedValidator>

export const claimsResultValidator = v.object({
  /** New claims appended to the log. */
  inserted: v.number(),
  /** Known claims re-observed and refreshed (`lastSeenAt` advanced). */
  updated: v.number(),
  /** Known claims re-posted with nothing to record. */
  unchanged: v.number(),
  entities: v.object({ created: v.number(), updated: v.number(), unchanged: v.number() }),
  rejected: v.array(rejectedValidator),
})

/** A re-observation refreshes `lastSeenAt` at most this often (one write per claim per day). */
const REFRESH_INTERVAL_MS = DAY_MS

const LIMITS = { key: 200, extractor: 200, quote: 4_000, raw: 20_000, url: 2_048 }

type Prepared = {
  index: number
  input: ClaimInput
  row: Omit<Doc<"fieldClaims">, "_id" | "_creationTime">
}

export const ingest = internalMutation({
  args: { runKey: v.optional(v.string()), claims: v.array(claimInputValidator) },
  returns: claimsResultValidator,
  handler: async (ctx, args) => {
    assertBatchSize(args.claims.length, "claims")
    const now = Date.now()
    const result = {
      inserted: 0,
      updated: 0,
      unchanged: 0,
      entities: { created: 0, updated: 0, unchanged: 0 },
      rejected: [] as Rejected[],
    }

    // 1. Validate and normalise, grouped by entity in arrival order.
    const groups = new Map<string, Prepared[]>()
    for (const [index, input] of args.claims.entries()) {
      const problem = validateClaim(input, now) ?? (await checkStorageRef(ctx, input))
      if (problem) {
        result.rejected.push(rejection(index, input, problem))
        continue
      }
      const group = `${input.entityType}\u0000${input.entityKey}`
      const prepared = { index, input, row: prepare(input, args.runKey, now) }
      groups.set(group, [...(groups.get(group) ?? []), prepared])
    }

    let terms: TermDates[] | null = null
    for (const claims of groups.values()) {
      const { entityType, entityKey } = claims[0].input
      const existing = await findEntity(ctx, entityType, entityKey)

      // 2. A new entity needs its required fields among the incoming values.
      if (!existing) {
        const present = new Set(
          claims.filter((claim) => claim.row.value !== undefined).map((claim) => claim.input.field),
        )
        const absent = requiredFields(entityType).filter((field) => !present.has(field))
        if (absent.length > 0) {
          for (const claim of claims) {
            result.rejected.push(
              rejection(
                claim.index,
                claim.input,
                `${entityKey} does not exist and these claims cannot create it: no value for ${absent.join(", ")}`,
              ),
            )
          }
          continue
        }
      }

      // 3. Append to the log.
      const touched = new Set<string>()
      const seen = new Set<string>()
      for (const claim of claims) {
        const outcome = await appendClaim(ctx, claim.row, seen)
        result[outcome]++
        if (outcome !== "unchanged") touched.add(claim.input.field)
      }
      if (existing && touched.size === 0) {
        result.entities.unchanged++
        continue
      }

      // 4. Re-resolve and write the entity.
      if (entityType === "event" && terms === null) terms = await loadTerms(ctx)
      const fields = existing ? [...touched] : Object.keys(FIELD_SPECS[entityType])
      const resolutions = await resolveFields(ctx, entityType, entityKey, fields)
      const outcome = await writeEntity(ctx, entityType, entityKey, existing, resolutions, {
        now,
        terms: terms ?? [],
      })
      result.entities[outcome]++
    }
    return result
  },
})

function rejection(index: number, input: ClaimInput, reason: string): Rejected {
  return {
    index,
    entityType: input.entityType,
    entityKey: String(input.entityKey).slice(0, LIMITS.key),
    field: String(input.field).slice(0, LIMITS.key),
    reason,
  }
}

/** Why a claim cannot be recorded, or null. */
export function validateClaim(input: ClaimInput, now: number): string | null {
  const prefix = KEY_PREFIXES[input.entityType as EntityType]
  if (!input.entityKey.startsWith(prefix) || input.entityKey.length > LIMITS.key) {
    return `entityKey must start with ${prefix}`
  }
  if (!/^[a-z0-9-]+$/.test(input.entityKey)) return "entityKey must be lower-kebab"
  const spec = FIELD_SPECS[input.entityType as EntityType][input.field]
  if (!spec) return `unknown field ${input.field} for ${input.entityType}`
  if (input.sourceKey.length === 0 || input.sourceKey.length > LIMITS.key) return "bad sourceKey"
  if (input.sourceUrl.length === 0 || input.sourceUrl.length > LIMITS.url) return "bad sourceUrl"
  if (input.extractor.length === 0 || input.extractor.length > LIMITS.extractor) {
    return "bad extractor"
  }
  if ((input.evidenceQuote?.length ?? 0) > LIMITS.quote) return "evidenceQuote too long"
  if ((input.valueRaw?.length ?? 0) > LIMITS.raw) return "valueRaw too long"
  if (!Number.isFinite(input.retrievedAt) || input.retrievedAt < Date.UTC(2000, 0, 1)) {
    return "retrievedAt is not a plausible epoch-ms instant"
  }
  if (input.retrievedAt > now + DAY_MS) return "retrievedAt is in the future"

  if (input.value === undefined) {
    if (input.status !== "missing" && input.status !== "not_applicable") {
      return 'a claim without a value needs status "missing" or "not_applicable"'
    }
    return null
  }
  if (input.value === null) {
    return 'null is never a value: omit it and send status "missing" with a missingReason'
  }
  if (input.status === "missing" || input.status === "not_applicable") {
    return `a ${input.status} claim must not carry a value`
  }
  if (input.missingReason !== undefined) return "missingReason belongs to a missing claim"
  return checkValue(spec.validator, input.value) ?? spec.check?.(input.value) ?? null
}

/** An image value's `storageId` must name a file this deployment stores
 * (uploaded through `/api/pipeline/files`). */
async function checkStorageRef(ctx: MutationCtx, input: ClaimInput): Promise<string | null> {
  const value = input.value as { storageId?: unknown } | undefined
  if (!value || typeof value !== "object" || value.storageId === undefined) return null
  const id = ctx.db.system.normalizeId("_storage", String(value.storageId))
  if (!id || !(await ctx.db.system.get("_storage", id))) {
    return "storageId does not name a stored file"
  }
  return null
}

/** The `fieldClaims` row for a validated claim: status, confidence and
 * fingerprint computed here, never taken from the caller. */
function prepare(input: ClaimInput, runKey: string | undefined, now: number) {
  const hasValue = input.value !== undefined
  const status = storedStatus({
    method: input.method,
    requested: input.status,
    quoteCheck: input.quoteCheck,
    hasQuote: (input.evidenceQuote ?? "").trim().length > 0,
    hasValue,
  })
  const missingReason = status === "missing" ? (input.missingReason ?? "not_found") : undefined
  return {
    entityType: input.entityType,
    entityKey: input.entityKey,
    field: input.field,
    value: input.value,
    valueRaw: input.valueRaw,
    sourceKey: input.sourceKey,
    sourceUrl: input.sourceUrl,
    sourceType: input.sourceType,
    retrievedAt: input.retrievedAt,
    lastSeenAt: input.retrievedAt,
    contentSha256: input.contentSha256,
    method: input.method,
    extractor: input.extractor,
    promptVersion: input.promptVersion,
    evidenceQuote: input.evidenceQuote,
    quoteCheck: input.quoteCheck,
    status,
    missingReason,
    evidence: input.evidence,
    confidence: baseConfidence({ method: input.method, status, evidence: input.evidence }),
    reviewStatus: "accepted" as const,
    runKey,
    fingerprint: claimFingerprint({
      entityType: input.entityType,
      entityKey: input.entityKey,
      field: input.field,
      value: input.value,
      status,
      missingReason,
      sourceUrl: input.sourceUrl,
      contentSha256: input.contentSha256,
      method: input.method,
    }),
    createdAt: now,
  }
}

/**
 * Appends one claim. A known fingerprint is `unchanged`, or `updated` when it
 * is re-observed a day or more later (its `lastSeenAt` advances). A new claim
 * supersedes the older live claims of the same (source, method); if a newer
 * one already exists, the new claim is stored already superseded.
 */
async function appendClaim(
  ctx: MutationCtx,
  row: Prepared["row"],
  seenInBatch: Set<string>,
): Promise<"inserted" | "updated" | "unchanged"> {
  if (seenInBatch.has(row.fingerprint)) return "unchanged"
  seenInBatch.add(row.fingerprint)

  const known = await ctx.db
    .query("fieldClaims")
    .withIndex("by_fingerprint", (q) => q.eq("fingerprint", row.fingerprint))
    .first()
  if (known) {
    if (row.retrievedAt < known.lastSeenAt + REFRESH_INTERVAL_MS) return "unchanged"
    await ctx.db.patch("fieldClaims", known._id, { lastSeenAt: row.retrievedAt })
    return "updated"
  }

  const live = await ctx.db
    .query("fieldClaims")
    .withIndex("by_entity_field", (q) =>
      q
        .eq("entityType", row.entityType)
        .eq("entityKey", row.entityKey)
        .eq("field", row.field)
        .eq("reviewStatus", "accepted"),
    )
    .take(1_000)
  let newerExists = false
  for (const claim of live) {
    if (claim.sourceKey !== row.sourceKey || claim.method !== row.method) continue
    if (claim.retrievedAt > row.retrievedAt) newerExists = true
    else await ctx.db.patch("fieldClaims", claim._id, { reviewStatus: "superseded" })
  }
  await ctx.db.insert("fieldClaims", {
    ...row,
    reviewStatus: newerExists ? "superseded" : "accepted",
  })
  return "inserted"
}

/** Above this many fields, one range read of the entity's whole claim log is
 * cheaper than one read per field: a new organisation resolves ~70 fields, and
 * a batch creating dozens of them must stay well inside a mutation's limit on
 * database calls. */
const WHOLE_ENTITY_READ_FROM = 8
/** Claims read per entity (whole-log read) or per field. */
const ENTITY_CLAIMS_CAP = 8_000
const FIELD_CLAIMS_CAP = 2_000

/** Resolves `fields` of one entity from every claim recorded for them. */
async function resolveFields(
  ctx: MutationCtx,
  entityType: EntityType,
  entityKey: string,
  fields: readonly string[],
): Promise<Record<string, Resolution>> {
  const specs = FIELD_SPECS[entityType]
  const byField = new Map<string, Doc<"fieldClaims">[]>()
  if (fields.length >= WHOLE_ENTITY_READ_FROM) {
    const wanted = new Set(fields)
    const all = await ctx.db
      .query("fieldClaims")
      .withIndex("by_entity_field", (q) =>
        q.eq("entityType", entityType).eq("entityKey", entityKey),
      )
      .take(ENTITY_CLAIMS_CAP)
    for (const claim of all) {
      if (!wanted.has(claim.field)) continue
      byField.set(claim.field, [...(byField.get(claim.field) ?? []), claim])
    }
  } else {
    for (const field of fields) {
      const claims = await ctx.db
        .query("fieldClaims")
        .withIndex("by_entity_field", (q) =>
          q.eq("entityType", entityType).eq("entityKey", entityKey).eq("field", field),
        )
        .take(FIELD_CLAIMS_CAP)
      byField.set(field, claims)
    }
  }
  const out: Record<string, Resolution> = {}
  for (const field of fields) {
    const claims = byField.get(field) ?? []
    if (claims.length === 0) continue
    out[field] = resolveField(specs[field], claims)
  }
  return out
}

/** Materialises and writes one entity, plus what hangs off it. */
async function writeEntity(
  ctx: MutationCtx,
  entityType: EntityType,
  entityKey: string,
  existing: EntityDoc | null,
  resolutions: Record<string, Resolution>,
  context: { now: number; terms: TermDates[] },
): Promise<"created" | "updated" | "unchanged"> {
  const table = ENTITY_TABLES[entityType]
  const latestEventAt =
    entityType === "organisation" ? await latestPastEventAt(ctx, entityKey, context.now) : undefined
  const row = materialise(
    entityType,
    entityKey,
    existing as Record<string, unknown> | null,
    resolutions,
    { ...context, latestEventAt },
  )

  let outcome: "created" | "updated" | "unchanged"
  let id: EntityDoc["_id"]
  if (existing) {
    if (sameFields(existing as unknown as Record<string, unknown>, row)) return "unchanged"
    await ctx.db.patch(table, existing._id as never, { ...row, updatedAt: context.now } as never)
    id = existing._id
    outcome = "updated"
  } else {
    id = await ctx.db.insert(table, {
      key: entityKey,
      ...row,
      createdAt: context.now,
      updatedAt: context.now,
    } as never)
    outcome = "created"
  }

  const written = (await ctx.db.get(table, id as never)) as EntityDoc | null
  if (!written) return outcome
  if (entityType === "organisation") {
    await writeOrgCard(ctx, written as Doc<"organisations">)
  }
  if (entityType === "event") {
    const event = written as Doc<"events">
    const before = existing as Doc<"events"> | null
    if (before && (before.startsAt !== event.startsAt || before.visibility !== event.visibility)) {
      const orgKeys = await syncEventOrganiserRows(ctx, event)
      await refreshOrganisations(ctx, orgKeys, context)
    }
  }
  return outcome
}

/** Re-derives organisations whose activity may have changed. */
export async function refreshOrganisations(
  ctx: MutationCtx,
  orgKeys: Iterable<string>,
  context: { now: number; terms: TermDates[] },
): Promise<void> {
  for (const orgKey of new Set(orgKeys)) {
    const org = await ctx.db
      .query("organisations")
      .withIndex("by_key", (q) => q.eq("key", orgKey))
      .unique()
    if (org) await refreshOrganisation(ctx, org, context)
  }
}
