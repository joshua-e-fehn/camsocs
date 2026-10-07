/**
 * Coverage of the directory — what the broker overview and the missing-data
 * report show. Pure, over the rows `api.broker.orgs.page` returns (the
 * dashboard loads every page; there are about a thousand organisations).
 */

/** What coverage needs from a broker organisation row (structural). */
export type CoverageRow = {
  level?: string
  status: string
  isCounterpart: boolean
  hidden: boolean
  has: { email: boolean; website: boolean; instagram: boolean; description: boolean }
  missingFields: readonly string[]
}

export const COVERAGE_FIELDS = ["email", "website", "instagram", "description"] as const
export type CoverageField = (typeof COVERAGE_FIELDS)[number]

export type CoverageStats = {
  /** Listed organisations (counterparts are never listed). */
  total: number
  hidden: number
  counterparts: number
  byLevel: Record<string, number>
  byStatus: Record<string, number>
  /** level → status → count. */
  byLevelStatus: Record<string, Record<string, number>>
  /** Share of listed organisations holding each field, 0..1 (0 when none). */
  share: Record<CoverageField, number>
  /** Tracked fields by how many listed organisations miss them, most first. */
  missingTop: [field: string, count: number][]
}

const UNKNOWN = "unknown"

function bump(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1
}

export function coverageStats(rows: readonly CoverageRow[]): CoverageStats {
  const listed = rows.filter((row) => !row.isCounterpart)
  const byLevel: Record<string, number> = {}
  const byStatus: Record<string, number> = {}
  const byLevelStatus: Record<string, Record<string, number>> = {}
  const held: Record<CoverageField, number> = { email: 0, website: 0, instagram: 0, description: 0 }
  const missing: Record<string, number> = {}
  for (const row of listed) {
    const level = row.level ?? UNKNOWN
    bump(byLevel, level)
    bump(byStatus, row.status)
    byLevelStatus[level] ??= {}
    bump(byLevelStatus[level], row.status)
    for (const field of COVERAGE_FIELDS) if (row.has[field]) held[field]++
    for (const field of row.missingFields) bump(missing, field)
  }
  const share = Object.fromEntries(
    COVERAGE_FIELDS.map((field) => [field, listed.length ? held[field] / listed.length : 0]),
  ) as Record<CoverageField, number>
  return {
    total: listed.length,
    hidden: listed.filter((row) => row.hidden).length,
    counterparts: rows.length - listed.length,
    byLevel,
    byStatus,
    byLevelStatus,
    share,
    missingTop: Object.entries(missing).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  }
}
