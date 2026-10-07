import { v } from "convex/values"
import { TERMS } from "../lib/vocab"
import { query } from "./_generated/server"
import { literalUnion } from "./lib/validators"

const TERM_ORDER = { michaelmas: 0, lent: 1, easter: 2 } as const

/** Full Term dates, in calendar order, with the official page they came from
 * (public; for the calendar's term-week view). */
export const list = query({
  args: {},
  returns: v.array(
    v.object({
      academicYear: v.string(),
      term: literalUnion(TERMS),
      fullTermStart: v.string(),
      fullTermEnd: v.string(),
      sourceUrl: v.string(),
    }),
  ),
  handler: async (ctx) => {
    const rows = await ctx.db.query("termDates").take(100)
    return rows
      .sort(
        (a, b) =>
          a.academicYear.localeCompare(b.academicYear) || TERM_ORDER[a.term] - TERM_ORDER[b.term],
      )
      .map(({ academicYear, term, fullTermStart, fullTermEnd, sourceUrl }) => ({
        academicYear,
        term,
        fullTermStart,
        fullTermEnd,
        sourceUrl,
      }))
  },
})
