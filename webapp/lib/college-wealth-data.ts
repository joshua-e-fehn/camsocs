import { unstable_rethrow } from "next/navigation"
import { cache } from "react"
import { api } from "@/convex/_generated/api"
import { resolveWealthYear } from "@/lib/college-finances"
import { VERIFIED_WEALTH, type WealthView, wealthView } from "@/lib/college-wealth-view"
import { publicQuery } from "@/lib/public-data"

/**
 * /colleges/wealth's view (lib/college-wealth-view.ts), read once per render
 * and shared by the page, its metadata, the CSV, the share card and the
 * college hubs. The register history comes from Convex anonymously and
 * cached (lib/public-data.ts), so the pages stay static and revalidate. When
 * Convex cannot be read, or holds no rows yet, the view is the verified
 * dataset's year alone: the page never depends on Convex to render.
 */
export const loadWealthView = cache(async (): Promise<WealthView> => {
  try {
    const [history, meta] = await Promise.all([
      publicQuery(api.collegeFinances.history, {}),
      publicQuery(api.collegeFinances.latestCompleteYear, {}),
    ])
    return wealthView(resolveWealthYear(VERIFIED_WEALTH, history), meta)
  } catch (error) {
    // Next signals "this render is dynamic" by throwing; that must pass.
    unstable_rethrow(error)
    console.error("collegeFinances failed; /colleges/wealth from the verified dataset", error)
    return wealthView(resolveWealthYear(VERIFIED_WEALTH, null))
  }
})
