/** Every tenth page is always linked, so no page of a long list is more than
 * a few clicks from the first (SEO audit 2026-11-02,
 * directory-pagination-search-canonical: with only "next" and the last page
 * linked, page 17 of 34 was 16 hops deep). */
export const PAGE_LANDMARK = 10

/**
 * The page numbers a pager shows: the first and last page, the current one
 * and two on each side, and every tenth page, with a gap marker where pages
 * are skipped — `[1, "gap", 8, 9, 10, 11, 12, "gap", 20, "gap", 30, "gap",
 * 34]`. A gap that would hide a single page shows that page instead.
 */
export function pageNumbers(current: number, total: number): (number | "gap")[] {
  if (total <= 1) return [1]
  const wanted = new Set([1, total])
  for (let page = current - 2; page <= current + 2; page++) wanted.add(page)
  for (let page = PAGE_LANDMARK; page < total; page += PAGE_LANDMARK) wanted.add(page)
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
