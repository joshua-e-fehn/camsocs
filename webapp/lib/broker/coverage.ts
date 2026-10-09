/**
 * Coverage of the directory — what the broker overview, the missing-data
 * report and the pipeline's coverage report show. Pure, so the server
 * (`convex/coverage.ts`, which folds every organisation into a snapshot a page
 * at a time), the pipeline route behind `pixi run harvest` and `bun test` share
 * one definition.
 *
 * The fold is an accumulator — `emptyCoverage` → `addCoverageRow` per row →
 * `finishCoverage` — because no single Convex transaction may read every
 * organisation row (~10 KB each with descriptions and per-field meta): the
 * server walks them in pages and carries the counts from page to page.
 */

/** What coverage needs from one organisation (structural: a broker row or a
 * row the server derives from an organisation document). */
export type CoverageRow = {
  level?: string
  orgType?: string
  status: string
  isCounterpart: boolean
  hidden: boolean
  has: { email: boolean; website: boolean; instagram: boolean; description: boolean }
  /** Fields holding a value (status found / inferred / owner_confirmed /
   * manual / conflicting). */
  heldFields?: readonly string[]
  missingFields: readonly string[]
}

export const COVERAGE_FIELDS = ["email", "website", "instagram", "description"] as const
export type CoverageField = (typeof COVERAGE_FIELDS)[number]

/** The running counts. Plain records of numbers, so the server can pass them
 * from one scheduled page to the next as function arguments. */
export type CoverageCounts = {
  /** Listed organisations (counterparts are never listed). */
  total: number
  hidden: number
  counterparts: number
  byLevel: Record<string, number>
  byStatus: Record<string, number>
  /** level → status → count. */
  byLevelStatus: Record<string, Record<string, number>>
  byOrgType: Record<string, number>
  /** Listed organisations holding each headline field. */
  headline: Record<CoverageField, number>
  /** Field → listed organisations holding a value for it. */
  held: Record<string, number>
  /** Tracked field → listed organisations missing it. */
  missing: Record<string, number>
}

export type CoverageStats = CoverageCounts & {
  /** Share of listed organisations holding each headline field, 0..1 (0 when none). */
  share: Record<CoverageField, number>
  /** Tracked fields by how many listed organisations miss them, most first. */
  missingTop: { field: string; count: number }[]
}

const UNKNOWN = "unknown"

function bump(record: Record<string, number>, key: string, by = 1): void {
  record[key] = (record[key] ?? 0) + by
}

export function emptyCoverage(): CoverageCounts {
  return {
    total: 0,
    hidden: 0,
    counterparts: 0,
    byLevel: {},
    byStatus: {},
    byLevelStatus: {},
    byOrgType: {},
    headline: { email: 0, website: 0, instagram: 0, description: 0 },
    held: {},
    missing: {},
  }
}

/** Adds one organisation to `counts` (in place) and returns it. */
export function addCoverageRow(counts: CoverageCounts, row: CoverageRow): CoverageCounts {
  if (row.isCounterpart) {
    counts.counterparts++
    return counts
  }
  counts.total++
  if (row.hidden) counts.hidden++
  const level = row.level ?? UNKNOWN
  bump(counts.byLevel, level)
  bump(counts.byStatus, row.status)
  counts.byLevelStatus[level] ??= {}
  bump(counts.byLevelStatus[level], row.status)
  bump(counts.byOrgType, row.orgType ?? UNKNOWN)
  for (const field of COVERAGE_FIELDS) if (row.has[field]) counts.headline[field]++
  for (const field of row.heldFields ?? []) bump(counts.held, field)
  for (const field of row.missingFields) bump(counts.missing, field)
  return counts
}

function addRecord(into: Record<string, number>, from: Record<string, number>): void {
  for (const [key, count] of Object.entries(from)) bump(into, key, count)
}

/** `a` + `b`, as new counts (pages folded separately, then combined). */
export function mergeCoverage(a: CoverageCounts, b: CoverageCounts): CoverageCounts {
  const out = emptyCoverage()
  for (const part of [a, b]) {
    out.total += part.total
    out.hidden += part.hidden
    out.counterparts += part.counterparts
    addRecord(out.byLevel, part.byLevel)
    addRecord(out.byStatus, part.byStatus)
    for (const [level, statuses] of Object.entries(part.byLevelStatus)) {
      out.byLevelStatus[level] ??= {}
      addRecord(out.byLevelStatus[level], statuses)
    }
    addRecord(out.byOrgType, part.byOrgType)
    for (const field of COVERAGE_FIELDS) out.headline[field] += part.headline[field]
    addRecord(out.held, part.held)
    addRecord(out.missing, part.missing)
  }
  return out
}

/** The counts plus their shares and the most-missed fields. */
export function finishCoverage(counts: CoverageCounts): CoverageStats {
  const share = Object.fromEntries(
    COVERAGE_FIELDS.map((field) => [
      field,
      counts.total ? counts.headline[field] / counts.total : 0,
    ]),
  ) as Record<CoverageField, number>
  const missingTop = Object.entries(counts.missing)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([field, count]) => ({ field, count }))
  return { ...counts, share, missingTop }
}

export function coverageStats(rows: readonly CoverageRow[]): CoverageStats {
  const counts = emptyCoverage()
  for (const row of rows) addCoverageRow(counts, row)
  return finishCoverage(counts)
}
