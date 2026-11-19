import { WEALTH_PATH, WEALTH_REGISTER_CHECK } from "@/lib/college-wealth"
import { loadWealthView } from "@/lib/college-wealth-data"
import { wealthCsv } from "@/lib/college-wealth-view"
import { pageId } from "@/lib/structured-data"

/**
 * `/colleges/wealth.csv`: the ranking /colleges/wealth shows, as CSV (the
 * Dataset's `distribution` in its JSON-LD). Static and revalidated like the
 * page (lib/public-data.ts PUBLIC_DATA_REVALIDATE), from the same view, so
 * the two never disagree; without Convex it is the verified year.
 */
export const revalidate = 300

export async function GET() {
  const view = await loadWealthView()
  return new Response(wealthCsv(view, WEALTH_REGISTER_CHECK.licence, pageId(WEALTH_PATH)), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `inline; filename="cambridge-college-endowments-${view.financialYear}.csv"`,
    },
  })
}
