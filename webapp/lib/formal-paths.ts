/**
 * Where the formals pages live (ENG-272, formals SEO audit 2026-11-19).
 * Pure strings, so both server pages and client organisms can link them.
 */

export const FORMALS_PATH = "/formals"
export const FORMAL_TRACKER_PATH = "/formals/tracker"

/** A college's own formal hall page, `/formals/<college slug>`. */
export function formalCollegePath(slug: string): string {
  return `${FORMALS_PATH}/${slug}`
}
