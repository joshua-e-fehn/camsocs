import type { GenericCtx } from "@convex-dev/better-auth/utils"
import { isBrokerEmail } from "../../lib/broker-access"
import type { DataModel } from "../_generated/dataModel"
import { authComponent } from "../betterAuth/auth"

/**
 * Who a request is allowed to act as.
 *
 * Two callers reach this deployment and authenticate differently: a browser
 * with a Better Auth session (decided here) and the Python pipeline with a
 * shared Bearer key (decided in convex/http.ts). Neither is re-derived per
 * module. Pattern from Bundestracker and salo-ba convex/lib/auth.ts.
 *
 * Three levels:
 *  - public queries over directory data call nothing;
 *  - `requireUserId` / `getUserId` for anything tied to a signed-in account;
 *  - `requireBrokerUser` for **every** function under `convex/broker/` — the
 *    private CRM (people, interactions, introductions). No exceptions.
 */

/** The signed-in user's id, or a thrown error. Taken from the session — never
 * accept a `userId` argument, or any user could act as any other. */
export async function requireUserId(ctx: GenericCtx<DataModel>): Promise<string> {
  const user = await authComponent.safeGetAuthUser(ctx)
  if (!user) {
    throw new Error("Not authenticated")
  }
  return user._id
}

/** The signed-in user's id, or null, for reads with a signed-out rendering. */
export async function getUserId(ctx: GenericCtx<DataModel>): Promise<string | null> {
  const user = await authComponent.safeGetAuthUser(ctx)
  return user?._id ?? null
}

/** What a broker-only function learns about its caller. */
export type BrokerUser = { id: string; email: string; name: string }

/**
 * The signed-in broker, or null for anyone else (signed out, not allowlisted,
 * unverified email, or `BROKER_EMAILS` unset).
 *
 * `emailVerified` is required as well as the address: Google always verifies,
 * and the check keeps a future email/password provider from letting someone
 * claim a broker's address without proving they own it.
 */
export async function getBrokerUser(ctx: GenericCtx<DataModel>): Promise<BrokerUser | null> {
  const user = await authComponent.safeGetAuthUser(ctx)
  if (!user || user.emailVerified !== true) return null
  if (!isBrokerEmail(user.email, process.env.BROKER_EMAILS)) return null
  return { id: user._id, email: user.email, name: user.name }
}

/**
 * The signed-in broker, or a thrown error. Call it first in every function
 * under `convex/broker/`.
 *
 * One message for every refusal, so a caller cannot probe whether an address
 * is on the list or whether the list is configured at all.
 */
export async function requireBrokerUser(ctx: GenericCtx<DataModel>): Promise<BrokerUser> {
  const broker = await getBrokerUser(ctx)
  if (!broker) {
    throw new Error("Not authorized")
  }
  return broker
}
