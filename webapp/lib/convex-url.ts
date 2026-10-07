/**
 * The Convex deployment this build talks to, checked once at module load.
 *
 * Ported from Bundestracker (lib/convex-url.ts), with one change: the host
 * pattern also accepts region-qualified deployments
 * (`name.eu-west-1.convex.cloud`), which Convex issues for non-default regions.
 *
 * ## The bug this exists to prevent
 *
 * `NEXT_PUBLIC_CONVEX_URL` is inlined at build time. Point a build at the wrong
 * deployment and nothing fails: the URL is well-formed, the deployment answers,
 * and — because a sibling deployment (dev vs prod) carries the same schema and
 * functions — every query returns a *successful* but empty result. The site
 * looks healthy while telling readers that a society it really holds does not
 * exist. Throwing at module load makes that a failed `next build` instead.
 *
 * There is no correct value to fall back to, so this throws rather than guesses.
 */

/**
 * A Convex origin, capturing the deployment name (including an optional region
 * segment) and which of the two suffixes it carries — `happy-otter-123` and
 * `cloud` from `https://happy-otter-123.convex.cloud`.
 *
 * Deliberately a shape check rather than an allowlist of deployment names: the
 * misconfiguration seen in practice is a *different* Convex deployment, which no
 * pattern can catch. `isSameDeployment` is the part that can.
 */
const CONVEX_ORIGIN = /^https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)?)\.convex\.(cloud|site)$/

/** The deployment name and suffix, or null for anything that is not a Convex
 * origin — so callers can say which variable was wrong. */
function parseOrigin(url: string): { name: string; suffix: "cloud" | "site" } | null {
  const match = CONVEX_ORIGIN.exec(url)
  if (!match) return null
  return { name: match[1], suffix: match[2] as "cloud" | "site" }
}

/**
 * The deployment name out of either origin — `happy-otter-123` from
 * `https://happy-otter-123.convex.cloud`, `happy-otter-123.eu-west-1` from a
 * region-qualified one.
 */
export function deploymentName(url: string): string | null {
  return parseOrigin(url)?.name ?? null
}

/**
 * Whether `cloudUrl` and `siteUrl` name the same deployment.
 *
 * The pair is set by hand in the Vercel dashboard, one variable at a time, so
 * "half-updated" is a real state: queries against one deployment while auth
 * talks to another. Neither side errors on its own.
 */
export function isSameDeployment(cloudUrl: string, siteUrl: string): boolean {
  const cloud = deploymentName(cloudUrl)
  const site = deploymentName(siteUrl)
  return cloud !== null && cloud === site
}

/**
 * Reads and validates the deployment URLs this build was compiled against.
 *
 * Called at module load by the places that hold a Convex client. The message
 * names the variable and what it looked like, because the person reading it is
 * looking at a build log rather than at this file.
 */
export function requireConvexUrls(env: {
  NEXT_PUBLIC_CONVEX_URL?: string
  NEXT_PUBLIC_CONVEX_SITE_URL?: string
}): { cloudUrl: string; siteUrl: string } {
  const cloudUrl = env.NEXT_PUBLIC_CONVEX_URL
  const siteUrl = env.NEXT_PUBLIC_CONVEX_SITE_URL

  if (!cloudUrl || parseOrigin(cloudUrl)?.suffix !== "cloud") {
    throw new Error(
      `NEXT_PUBLIC_CONVEX_URL must be a Convex deployment URL like ` +
        `https://example-animal-123.convex.cloud — received ${JSON.stringify(cloudUrl)}. ` +
        `Without it every query returns null and the site renders "not found" for real data.`,
    )
  }
  if (!siteUrl || parseOrigin(siteUrl)?.suffix !== "site") {
    throw new Error(
      `NEXT_PUBLIC_CONVEX_SITE_URL must be a Convex site URL like ` +
        `https://example-animal-123.convex.site — received ${JSON.stringify(siteUrl)}.`,
    )
  }
  if (!isSameDeployment(cloudUrl, siteUrl)) {
    throw new Error(
      `NEXT_PUBLIC_CONVEX_URL (${deploymentName(cloudUrl)}) and NEXT_PUBLIC_CONVEX_SITE_URL ` +
        `(${deploymentName(siteUrl)}) name different Convex deployments. Queries and auth ` +
        `would be served by different backends.`,
    )
  }

  return { cloudUrl, siteUrl }
}
