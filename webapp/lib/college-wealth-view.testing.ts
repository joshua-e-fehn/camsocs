import type { CollegeHistory } from "@/lib/college-finances"
import { COLLEGE_WEALTH } from "@/lib/college-wealth"
import type { RegisterMeta } from "@/lib/college-wealth-view"

/** Test fixtures for lib/college-wealth-view.ts and the page's render test. */

/** One year on: every college filed 2025-26 with 10% more invested, plus
 * a register 2022-23 for all but one. Synthetic, never real register rows. */
export function registerYearHistory(options: { complete: boolean }): CollegeHistory[] {
  return COLLEGE_WEALTH.map((row, index) => {
    const [year, month, day] = row.financialYearEnd.split("-")
    const next = `${Number(year) + 1}-${month}-${day}`
    const older = `${Number(year) - 2}-${month}-${day}`
    const periods: CollegeHistory["periods"] = []
    if (index !== 0) {
      periods.push({
        periodEnd: older,
        endowmentGbp: Math.round(row.endowmentPrevGbp * 0.95),
        netAssetsGbp: row.netAssetsGbp,
        incomeGbp: row.incomeGbp,
        status: "register",
      })
    }
    if (options.complete || index % 2 === 0) {
      periods.push({
        periodEnd: next,
        endowmentGbp: Math.round(row.endowmentGbp * 1.1),
        netAssetsGbp: Math.round(row.netAssetsGbp * 1.05),
        incomeGbp: row.incomeGbp,
        status: index === 1 ? "override" : "register",
      })
    }
    return { collegeKey: `org-${row.slug}`, periods, needsReview: 0 }
  })
}

/** When the synthetic register year last changed and was read. */
export const REGISTER_META: RegisterMeta = {
  updatedAt: Date.UTC(2027, 4, 20, 9),
  retrievedAt: Date.UTC(2027, 4, 24, 4),
}
