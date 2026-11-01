import { fetchQuery } from "convex/nextjs"
import { cache } from "react"
import { api } from "@/convex/_generated/api"

/**
 * The term dates (`termDates.list`), read once per server request: the
 * (site) layout's term clock and the page's own term-week labels share the
 * read (React `cache`). Callers keep their own error handling — the dates
 * are decoration, and a page renders without them.
 */
export const fetchTermDates = cache(() => fetchQuery(api.termDates.list, {}))
