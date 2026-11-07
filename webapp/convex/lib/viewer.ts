import type { GenericCtx } from "@convex-dev/better-auth/utils"
import { isBrokerEmail } from "../../lib/broker-access"
import { deploymentProfile } from "../../lib/campus/deployment"
import { isMemberEmail } from "../../lib/campus/member-email"
import type { DataModel } from "../_generated/dataModel"
import { authComponent } from "../betterAuth/auth"

/**
 * Who is looking — the one place a public query decides what tier of data a
 * caller may see. Never throws: signed-out is an ordinary viewer.
 *
 *  - `isBroker`: verified email on `BROKER_EMAILS` (same rule as
 *    `requireBrokerUser`, convex/lib/auth.ts).
 *  - `isCamVerified`: a *verified* member address of the deployment's campus
 *    (Cambridge: exactly `@cam.ac.uk`) — the tier that sees `cam_only`
 *    events (mailing-list events), "members of this deployment's campus
 *    only". Subdomains such as `@srcf.cam.ac.uk` do not count: the sign-in
 *    link is sent to the member domain only (lib/campus/member-email.ts
 *    `isMemberEmail` is the one rule for both; the name stays for the
 *    stored `cam_only` literal, decision D8).
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

export async function getViewer(ctx: GenericCtx<DataModel>): Promise<Viewer> {
  const user = await authComponent.safeGetAuthUser(ctx)
  if (!user) return ANONYMOUS
  const verified = user.emailVerified === true
  return {
    userId: user._id,
    email: user.email,
    isBroker: verified && isBrokerEmail(user.email, process.env.BROKER_EMAILS),
    isCamVerified: verified && isMemberEmail(user.email, deploymentProfile()),
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
