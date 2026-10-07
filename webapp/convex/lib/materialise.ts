import { orgSlugFromKey } from "../../lib/keys"
import { type EntityType, REGISTRATION_BODIES } from "../../lib/vocab"
import {
  classifyEmail,
  deriveOrgStatus,
  missingFields,
  orgSearchText,
  type TermDates,
  termWeekLabel,
} from "./derived"
import { type ApplicabilityContext, FIELD_SPECS, type FieldSpec } from "./fields"
import { type FieldMeta, hasClaimEvidence, type Resolution, unclaimedMeta } from "./resolve"

/**
 * From per-field resolutions to the row an entity table stores: plain values
 * (dotted sub-fields assembled into their objects), the `meta` map, structural
 * defaults and the derived fields. Pure; convex/ingest/claims.ts and
 * convex/derive.ts call it and write what it returns.
 *
 * `existing` supplies the values of fields not re-resolved in this pass, so a
 * batch that touches one field never has to re-read every other field's claims.
 */

type Row = Record<string, unknown>

/** What derivation needs from outside the row. */
export type DeriveContext = {
  now: number
  /** For events' `termWeekLabel`. */
  terms: readonly TermDates[]
  /** For organisations: start of the latest past event it organised or co-hosted. */
  latestEventAt?: number
}

/** Fields that are not claims but are never left absent on creation. */
const EVENT_DEFAULTS: Row = {
  allDay: false,
  cancelled: false,
  status: "confirmed",
  eventType: "other",
}

/** Reads a (possibly dotted) field from a stored row. */
export function readField(row: Row | null, field: string): unknown {
  if (!row) return undefined
  const [head, sub] = field.split(".")
  const value = row[head]
  if (sub === undefined) return value
  return value && typeof value === "object" ? (value as Row)[sub] : undefined
}

export function applicabilityOf(values: Row): ApplicabilityContext {
  return {
    orgType: values.orgType as string | undefined,
    level: values.level as string | undefined,
    categories: (values.categories as string[] | undefined) ?? [],
    isCounterpart: values.isCounterpart === true,
  }
}

/**
 * The full set of fields to write for an entity. `key` is the entity's key;
 * `touched` maps re-resolved fields to their resolution.
 */
export function materialise(
  entityType: EntityType,
  key: string,
  existing: Row | null,
  touched: Record<string, Resolution>,
  context: DeriveContext,
): Row {
  const specs = FIELD_SPECS[entityType]
  const flat: Row = {}
  for (const [field, spec] of Object.entries(specs)) {
    const resolution = touched[field]
    let value = resolution ? resolution.value : readField(existing, field)
    // A display field never goes blank once set: keep the last value, and
    // let meta say the sources no longer support it.
    if (value === undefined && spec.requiredOnCreate) value = readField(existing, field)
    if (value === undefined && spec.merge === "union") value = []
    flat[field] = value
  }

  const row = assemble(entityType, flat, existing)
  const meta = mergeMeta(specs, (existing?.meta as Record<string, FieldMeta>) ?? {}, touched, row)
  row.meta = meta
  return { ...row, ...derive(entityType, key, row, meta, context) }
}

/** Dotted sub-fields → nested objects; event defaults; non-claimable carry-overs. */
function assemble(entityType: EntityType, flat: Row, existing: Row | null): Row {
  const row: Row = {}
  for (const [field, value] of Object.entries(flat)) {
    if (!field.includes(".")) row[field] = value
  }
  if (entityType === "organisation") {
    const registrations: Row = {}
    for (const body of REGISTRATION_BODIES) {
      const value = flat[`registrations.${body}`]
      if (value !== undefined) registrations[body] = value
    }
    row.registrations = registrations
    const sportEntries = Object.entries(flat).filter(
      ([field, value]) =>
        field.startsWith("sport.") &&
        value !== undefined &&
        !(Array.isArray(value) && value.length === 0),
    )
    row.sport =
      sportEntries.length === 0
        ? undefined
        : {
            ...Object.fromEntries(
              sportEntries.map(([field, value]) => [field.slice("sport.".length), value]),
            ),
            genderCategories: flat["sport.genderCategories"] ?? [],
          }
    row.isCounterpart = row.isCounterpart ?? false
  }
  if (entityType === "event") {
    for (const [field, fallback] of Object.entries(EVENT_DEFAULTS)) {
      row[field] = row[field] ?? fallback
    }
    row.speakers = row.speakers ?? []
    for (const field of ["organiserKeys", "coHostKeys", "sponsorKeys"]) {
      row[field] = (existing?.[field] as string[] | undefined) ?? []
    }
  }
  return row
}

/** Touched fields take their new meta; unclaimed fields follow applicability. */
function mergeMeta(
  specs: Record<string, FieldSpec>,
  previous: Record<string, FieldMeta>,
  touched: Record<string, Resolution>,
  row: Row,
): Record<string, FieldMeta> {
  const context = applicabilityOf(row)
  const meta: Record<string, FieldMeta> = {}
  for (const [field, spec] of Object.entries(specs)) {
    const resolution = touched[field]
    if (resolution && hasClaimEvidence(resolution.meta)) {
      meta[field] = resolution.meta
    } else if (!resolution && hasClaimEvidence(previous[field])) {
      meta[field] = previous[field]
    } else {
      meta[field] = unclaimedMeta(spec.applies ? spec.applies(context) : true)
    }
  }
  return meta
}

function derive(
  entityType: EntityType,
  key: string,
  row: Row,
  meta: Record<string, FieldMeta>,
  context: DeriveContext,
): Row {
  if (entityType === "organisation") {
    const claimed = row.lastActiveAt as number | undefined
    const latest =
      context.latestEventAt === undefined
        ? claimed
        : Math.max(claimed ?? Number.NEGATIVE_INFINITY, context.latestEventAt)
    const values = { ...row, lastActiveAt: latest }
    return {
      slug: orgSlugFromKey(key),
      lastActiveAt: latest,
      emailType: typeof row.email === "string" ? classifyEmail(row.email) : undefined,
      status: deriveOrgStatus(
        values as Parameters<typeof deriveOrgStatus>[0] & { meta: Record<string, FieldMeta> },
        context.now,
      ),
      searchText: orgSearchText(values as unknown as Parameters<typeof orgSearchText>[0]),
      missingFields: missingFields(FIELD_SPECS.organisation, meta, applicabilityOf(row)),
    }
  }
  if (entityType === "event") {
    const confidences = [meta.title?.confidence, meta.startsAt?.confidence].filter(
      (value): value is number => value !== undefined,
    )
    const seen = Object.values(meta)
      .map((entry) => entry.retrievedAt)
      .filter((value): value is number => value !== undefined)
    return {
      termWeekLabel: termWeekLabel(row.startsAt as number, context.terms),
      confidence: confidences.length > 0 ? Math.min(...confidences) : 0.5,
      lastSeenAt: seen.length > 0 ? Math.max(...seen) : context.now,
    }
  }
  return {}
}

/** Fields that must be resolvable from the incoming claims to create a row. */
export function requiredFields(entityType: EntityType): string[] {
  return Object.entries(FIELD_SPECS[entityType])
    .filter(([, spec]) => spec.requiredOnCreate)
    .map(([field]) => field)
}
