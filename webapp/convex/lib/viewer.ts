import type { GenericCtx } from "@convex-dev/better-auth/utils"
import { isBrokerEmail } from "../../lib/broker-access"
import type { DataModel } from "../_generated/dataModel"
import { authComponent } from "../betterAuth/auth"

/**
 * Who is looking — the one place a public query decides what tier of data a
 * caller may see. Never throws: signed-out is an ordinary viewer.
 *
 *  - `isBroker`: verified email on `BROKER_EMAILS` (same rule as
 *    `requireBrokerUser`, convex/lib/auth.ts).
 *  - `isCamVerified`: a *verified* email ending `@cam.ac.uk` — the tier that
 *    sees `cam_only` events (mailing-list events). Subdomains such as
 *    `@srcf.cam.ac.uk` do not count: the sign-in link is sent to `@cam.ac.uk`.
 *
 * Pass the result down; do not re-derive access in each query.
 */
export type Viewer = {
  userId?: string
  email?: string
  isBroker: boolean
  isCamVerified: boolean
}

export const ANONYMOUS: Viewer = { isBroker: false, isCamVerified: false }

export function isCamEmail(email: string): boolean {
  return /^[^@\s]+@cam\.ac\.uk$/i.test(email.trim())
}

export async function getViewer(ctx: GenericCtx<DataModel>): Promise<Viewer> {
  const user = await authComponent.safeGetAuthUser(ctx)
  if (!user) return ANONYMOUS
  const verified = user.emailVerified === true
  return {
    userId: user._id,
    email: user.email,
    isBroker: verified && isBrokerEmail(user.email, process.env.BROKER_EMAILS),
    isCamVerified: verified && isCamEmail(user.email),
  }
}

/**
 * The event visibilities a viewer may see. `members_only` is never shown.
 * A broker sees the `cam_only` tier too: broker access is a superset, and the
 * broker is the person whose @cam.ac.uk mailbox feeds that tier.
 */
export function visibleEventTiers(viewer: Viewer): ("public" | "cam_only")[] {
  return viewer.isCamVerified || viewer.isBroker ? ["public", "cam_only"] : ["public"]
}
