import { type Campus, DEFAULT_CAMPUS, getCampus, isCampus } from "./index"
import type { CampusProfile } from "./profile"

/**
 * The campus a Convex deployment serves (decision D8): its `CAMSOCS_CAMPUS`
 * env var, unset meaning `cam`, so production needs no env change.
 *
 *   bunx convex env set CAMSOCS_CAMPUS <id>      (only on a non-cam deployment)
 *
 * Read inside the call, never at module load, so a changed env var takes
 * effect without a deploy and tests can set it per case. Used only by Convex;
 * Next reads `currentCampus()` (./index.ts).
 */
export function deploymentCampus(env: Record<string, string | undefined> = process.env): Campus {
  const value = env.CAMSOCS_CAMPUS?.trim() || DEFAULT_CAMPUS
  if (!isCampus(value)) {
    throw new Error(`CAMSOCS_CAMPUS is "${value}", which is not a known campus`)
  }
  return value
}

/** The profile of the deployment's campus (`getCampus(deploymentCampus())`). */
export function deploymentProfile(
  env: Record<string, string | undefined> = process.env,
): CampusProfile {
  return getCampus(deploymentCampus(env))
}
