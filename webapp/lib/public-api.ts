import type { FunctionReturnType } from "convex/server"
import type { api } from "@/convex/_generated/api"

/**
 * The client-side names for the public API's return types (docs/webapp.md
 * "Public API"). They are the `returns` validators of the Convex functions,
 * so nothing here can drift from what the server sends. Types only.
 */

export type OrgCard = FunctionReturnType<typeof api.orgs.list>["page"][number]
export type OrgFacets = FunctionReturnType<typeof api.orgs.facets>
export type OrgRef = FunctionReturnType<typeof api.orgs.colleges>[number]
export type OrgPage = NonNullable<FunctionReturnType<typeof api.orgs.getBySlug>>
export type OrgPublic = OrgPage["org"]
export type TeamPublic = OrgPage["teams"][number]
export type SessionPublic = OrgPage["sessions"][number]
export type RelationshipPublic = OrgPage["relationships"][number]
/** An event in a list or calendar (`events.list`, a profile's upcoming events). */
export type EventListItem = FunctionReturnType<typeof api.events.list>[number]
/** One event with its details and provenance (`events.get`, the details sheet). */
export type EventPublic = NonNullable<FunctionReturnType<typeof api.events.get>>
export type VenuePublic = FunctionReturnType<typeof api.venues.list>[number]
