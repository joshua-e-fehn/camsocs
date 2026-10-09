/**
 * The page numbers a pager shows: the first and last page, the current one
 * and its neighbours, with a gap marker where pages are skipped —
 * `[1, "gap", 4, 5, 6, "gap", 34]`. A gap that would hide a single page shows
 * that page instead.
 */
export function pageNumbers(current: number, total: number): (number | "gap")[] {
  if (total <= 1) return [1]
  const wanted = new Set([1, total, current - 1, current, current + 1])
  const pages = [...wanted].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b)
  const out: (number | "gap")[] = []
  for (const page of pages) {
    const previous = out[out.length - 1]
    if (typeof previous === "number" && page - previous === 2) out.push(previous + 1)
    else if (typeof previous === "number" && page - previous > 2) out.push("gap")
    out.push(page)
  }
  return out
}
