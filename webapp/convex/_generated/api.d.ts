/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as broker_session from "../broker/session.js";
import type * as crons from "../crons.js";
import type * as derive from "../derive.js";
import type * as events from "../events.js";
import type * as http from "../http.js";
import type * as ingest_broker from "../ingest/broker.js";
import type * as ingest_claims from "../ingest/claims.js";
import type * as ingest_files from "../ingest/files.js";
import type * as ingest_inbound from "../ingest/inbound.js";
import type * as ingest_orgInternal from "../ingest/orgInternal.js";
import type * as ingest_purge from "../ingest/purge.js";
import type * as ingest_relationships from "../ingest/relationships.js";
import type * as ingest_sources from "../ingest/sources.js";
import type * as ingest_termDates from "../ingest/termDates.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_checkValue from "../lib/checkValue.js";
import type * as lib_derived from "../lib/derived.js";
import type * as lib_entityStore from "../lib/entityStore.js";
import type * as lib_fields from "../lib/fields.js";
import type * as lib_ingest from "../lib/ingest.js";
import type * as lib_materialise from "../lib/materialise.js";
import type * as lib_orgFilters from "../lib/orgFilters.js";
import type * as lib_projections from "../lib/projections.js";
import type * as lib_relationships from "../lib/relationships.js";
import type * as lib_resolve from "../lib/resolve.js";
import type * as lib_validators from "../lib/validators.js";
import type * as lib_viewer from "../lib/viewer.js";
import type * as listingRequests from "../listingRequests.js";
import type * as orgs from "../orgs.js";
import type * as runs from "../runs.js";
import type * as termDates from "../termDates.js";
import type * as venues from "../venues.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  "broker/session": typeof broker_session;
  crons: typeof crons;
  derive: typeof derive;
  events: typeof events;
  http: typeof http;
  "ingest/broker": typeof ingest_broker;
  "ingest/claims": typeof ingest_claims;
  "ingest/files": typeof ingest_files;
  "ingest/inbound": typeof ingest_inbound;
  "ingest/orgInternal": typeof ingest_orgInternal;
  "ingest/purge": typeof ingest_purge;
  "ingest/relationships": typeof ingest_relationships;
  "ingest/sources": typeof ingest_sources;
  "ingest/termDates": typeof ingest_termDates;
  "lib/auth": typeof lib_auth;
  "lib/checkValue": typeof lib_checkValue;
  "lib/derived": typeof lib_derived;
  "lib/entityStore": typeof lib_entityStore;
  "lib/fields": typeof lib_fields;
  "lib/ingest": typeof lib_ingest;
  "lib/materialise": typeof lib_materialise;
  "lib/orgFilters": typeof lib_orgFilters;
  "lib/projections": typeof lib_projections;
  "lib/relationships": typeof lib_relationships;
  "lib/resolve": typeof lib_resolve;
  "lib/validators": typeof lib_validators;
  "lib/viewer": typeof lib_viewer;
  listingRequests: typeof listingRequests;
  orgs: typeof orgs;
  runs: typeof runs;
  termDates: typeof termDates;
  venues: typeof venues;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  betterAuth: import("../betterAuth/_generated/component.js").ComponentApi<"betterAuth">;
};
