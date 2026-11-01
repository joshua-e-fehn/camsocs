/**
 * The orders the /societies directory offers (`?sort=`), shared by the URL
 * state (lib/url-state.ts) and `orgs.list` (convex/orgs.ts). Pure constants:
 * safe to import on the client and in Convex.
 *
 *  - `relevance`: search rank for a text query; A–Z without one.
 *  - `name`: A–Z by name, also for a text query.
 *  - `active`: most events this term first (convex/lib/orgActivity.ts), then
 *    the relevance order.
 */
export const ORG_SORTS = ["relevance", "name", "active"] as const
export type OrgSort = (typeof ORG_SORTS)[number]

export const ORG_SORT_LABELS: Record<OrgSort, string> = {
  relevance: "Best match",
  name: "A–Z",
  active: "Active this term",
}
