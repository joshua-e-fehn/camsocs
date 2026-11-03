import { unstable_rethrow } from "next/navigation"
import { cache } from "react"
import { api } from "@/convex/_generated/api"
import { publicQuery } from "@/lib/public-data"
import { type TermClock, termClock } from "@/lib/term-week"

/**
 * The term dates (`termDates.list`), read once per server render: the
 * (site) layout's term clock and the page's own term-week labels share the
 * read (React `cache`), anonymous and cached (lib/public-data.ts) like every
 * public page's reads, so the layout leaves its pages cacheable. Callers keep their own error handling — the dates
 * are decoration, and a page renders without them.
 */
export const fetchTermDates = cache(() => publicQuery(api.termDates.list, {}))

/** The term clock for now and where its dates were read, or null when Convex
 * cannot be read: the layout's footer and the home hero both show it, and
 * both render without it. */
export const loadTermClock = cache(
  async (): Promise<{ clock: TermClock | null; sourceUrl?: string }> => {
    try {
      const rows = await fetchTermDates()
      const clock = termClock(Date.now(), rows)
      const current =
        clock.kind === "term"
          ? rows.find((row) => row.fullTermStart === clock.fullTermStart)
          : rows.find((row) => row.fullTermStart === clock.next?.fullTermStart)
      return { clock: rows.length > 0 ? clock : null, sourceUrl: current?.sourceUrl }
    } catch (error) {
      // Next signals "this render is dynamic" by throwing; that must pass.
      unstable_rethrow(error)
      console.error("termDates.list failed; rendering without the term clock", error)
      return { clock: null }
    }
  },
)
