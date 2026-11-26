/** Where the recurring event series pages live (ENG-282); no imports, so the
 * sitemap route and client code can use it. */
export const SERIES_INDEX_PATH = "/events/series"

export function seriesPath(slug: string): string {
  return `${SERIES_INDEX_PATH}/${slug}`
}
