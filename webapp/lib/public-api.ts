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
/** The "Busy this week" shelf (`orgs.busy`). */
export type OrgBusy = FunctionReturnType<typeof api.orgs.busy>
/** A profile's related listings (`orgs.related`). */
export type OrgRelated = FunctionReturnType<typeof api.orgs.related>
/** A talk in a list, agenda or search (`talks.list`, `talks.search`). */
export type TalkListItem = FunctionReturnType<typeof api.talks.search>[number]
/** One London day of the map (`map.day`). */
export type MapDay = FunctionReturnType<typeof api.map.day>
/** An event or talk on the map, with its place (`map.day` items). */
export type MapItem = MapDay["items"][number]
/** One day of the map's strip (`map.weekCounts`). */
export type MapDayCount = FunctionReturnType<typeof api.map.weekCounts>[number]
/** One item's resolved place (`locations.forItem`), null when it has none. */
export type ItemLocation = FunctionReturnType<typeof api.locations.forItem>
