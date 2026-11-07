import type { CampusProfile } from "./profile"
import { CAMBRIDGE } from "./profiles/cam"

/**
 * The campus registry (decision D8). One deployment serves one campus:
 *
 *  - Next reads `currentCampus()`, fixed at build time by
 *    `NEXT_PUBLIC_CAMPUS` (unset: `cam`);
 *  - Convex reads `deploymentCampus()` (./deployment.ts) from the
 *    deployment's `CAMSOCS_CAMPUS` env var (unset: `cam`).
 *
 * There is no host routing and no `[campus]` segment: each campus is its own
 * Vercel project. The synthetic `zz` profile (profiles/zz.testing.ts) is
 * never registered here; tests pass it to the pure functions directly.
 */

export type { CampusFacts, CampusProfile, MemberEmailFacts, TermModel } from "./profile"
export { CAMBRIDGE } from "./profiles/cam"

/** The campuses a deployment may serve. Append-only. */
export const CAMPUS_IDS = ["cam"] as const
export type Campus = (typeof CAMPUS_IDS)[number]

/** The campus a deployment serves when nothing says otherwise. */
export const DEFAULT_CAMPUS: Campus = "cam"

const PROFILES: Readonly<Record<Campus, CampusProfile>> = { cam: CAMBRIDGE }

/** Whether `id` names a registered campus. */
export function isCampus(id: unknown): id is Campus {
  return typeof id === "string" && (CAMPUS_IDS as readonly string[]).includes(id)
}

/** The profile of a registered campus; throws on anything else, so a typo in
 * an env var fails loudly instead of serving Cambridge's rules elsewhere. */
export function getCampus(id: string): CampusProfile {
  if (!isCampus(id)) throw new Error(`Unknown campus "${id}" (known: ${CAMPUS_IDS.join(", ")})`)
  return PROFILES[id]
}

/** The campus this Next build serves (`NEXT_PUBLIC_CAMPUS`, inlined at build
 * time; unset or empty: `cam`). */
export function currentCampus(): CampusProfile {
  return getCampus(process.env.NEXT_PUBLIC_CAMPUS || DEFAULT_CAMPUS)
}
