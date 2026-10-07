import { describe, expect, test } from "bun:test"
import { deploymentName, isSameDeployment, requireConvexUrls } from "./convex-url"

/**
 * Regression tests for a build compiled against the wrong Convex deployment.
 *
 * Ported from Bundestracker, where the symptom was real records rendering as
 * "does not exist": a sibling deployment with the same schema and none of the
 * data answers every query successfully and empty. **A wrong deployment URL is
 * not a crash, it is a lie**, so the check has to fire before anything renders.
 */

/** A well-formed pair, as production has them. */
const VALID = {
  NEXT_PUBLIC_CONVEX_URL: "https://happy-otter-123.convex.cloud",
  NEXT_PUBLIC_CONVEX_SITE_URL: "https://happy-otter-123.convex.site",
}

describe("deploymentName", () => {
  test("reads the deployment out of either origin", () => {
    expect(deploymentName("https://happy-otter-123.convex.cloud")).toBe("happy-otter-123")
    expect(deploymentName("https://happy-otter-123.convex.site")).toBe("happy-otter-123")
  })

  test("returns null for anything that is not a Convex origin", () => {
    // A path, a trailing slash and a non-Convex host. The first two are what a
    // hand-pasted dashboard value actually looks like when it is wrong.
    expect(deploymentName("https://happy-otter-123.convex.cloud/")).toBeNull()
    expect(deploymentName("https://happy-otter-123.convex.cloud/api")).toBeNull()
    expect(deploymentName("https://camsocs.example")).toBeNull()
    expect(deploymentName("")).toBeNull()
  })
})

describe("isSameDeployment", () => {
  test("the matching pair is the same deployment", () => {
    expect(isSameDeployment(VALID.NEXT_PUBLIC_CONVEX_URL, VALID.NEXT_PUBLIC_CONVEX_SITE_URL)).toBe(
      true,
    )
  })

  test("a half-updated pair is not", () => {
    // The state this has actually been in: the two variables are set by hand,
    // one at a time, so queries can be pointed at the new deployment while auth
    // still talks to the old one. Neither side errors — the reader is simply
    // never signed in, which on a site where signing in is optional looks like
    // nothing at all.
    expect(
      isSameDeployment(
        "https://happy-otter-123.convex.cloud",
        "https://festive-monitor-280.convex.site",
      ),
    ).toBe(false)
  })
})

describe("requireConvexUrls", () => {
  test("returns both URLs when the pair is well-formed and agrees", () => {
    expect(requireConvexUrls(VALID)).toEqual({
      cloudUrl: VALID.NEXT_PUBLIC_CONVEX_URL,
      siteUrl: VALID.NEXT_PUBLIC_CONVEX_SITE_URL,
    })
  })

  test("an unset deployment URL throws rather than building", () => {
    // Before this check the value flowed on as `undefined!`, and the first
    // symptom was a fetch error at request time on one page rather than a
    // failed build.
    expect(() => requireConvexUrls({})).toThrow(/NEXT_PUBLIC_CONVEX_URL/)
    expect(() =>
      requireConvexUrls({ NEXT_PUBLIC_CONVEX_SITE_URL: VALID.NEXT_PUBLIC_CONVEX_SITE_URL }),
    ).toThrow(/NEXT_PUBLIC_CONVEX_URL/)
  })

  test("a site URL missing its pair throws", () => {
    expect(() =>
      requireConvexUrls({ NEXT_PUBLIC_CONVEX_URL: VALID.NEXT_PUBLIC_CONVEX_URL }),
    ).toThrow(/NEXT_PUBLIC_CONVEX_SITE_URL/)
  })

  test("the two URLs must name the same deployment", () => {
    // The exact shape of the production misconfiguration, kept as a named case
    // so a future edit cannot quietly allow it again.
    expect(() =>
      requireConvexUrls({
        NEXT_PUBLIC_CONVEX_URL: "https://happy-otter-123.convex.cloud",
        NEXT_PUBLIC_CONVEX_SITE_URL: "https://festive-monitor-280.convex.site",
      }),
    ).toThrow(/different Convex deployments/)
  })

  test("rejects a .site URL given as the query URL, and the reverse", () => {
    // Swapping the two is a single-character mistake in the dashboard and both
    // values remain "set", so neither a truthiness check nor a `!` assertion
    // notices. The suffix is what distinguishes them.
    expect(() =>
      requireConvexUrls({
        NEXT_PUBLIC_CONVEX_URL: VALID.NEXT_PUBLIC_CONVEX_SITE_URL,
        NEXT_PUBLIC_CONVEX_SITE_URL: VALID.NEXT_PUBLIC_CONVEX_URL,
      }),
    ).toThrow(/NEXT_PUBLIC_CONVEX_URL/)
  })

  test("rejects a URL with a path or a trailing slash", () => {
    // `ConvexHttpClient` accepts these and then builds request URLs that 404,
    // which reads downstream as an unreachable backend rather than as a typo.
    expect(() =>
      requireConvexUrls({
        ...VALID,
        NEXT_PUBLIC_CONVEX_URL: "https://happy-otter-123.convex.cloud/",
      }),
    ).toThrow(/NEXT_PUBLIC_CONVEX_URL/)
  })

  test("rejects a non-Convex host", () => {
    // The local-dev value someone might paste in, and the site's own origin —
    // both plausible, both silently wrong.
    expect(() =>
      requireConvexUrls({ ...VALID, NEXT_PUBLIC_CONVEX_URL: "http://localhost:3000" }),
    ).toThrow(/NEXT_PUBLIC_CONVEX_URL/)
    expect(() =>
      requireConvexUrls({ ...VALID, NEXT_PUBLIC_CONVEX_URL: "https://camsocs.example" }),
    ).toThrow(/NEXT_PUBLIC_CONVEX_URL/)
  })

  test("the message names the variable and shows what it received", () => {
    // The reader of this error is looking at a Vercel build log, not at
    // lib/convex-url.ts. A message that does not say which variable was wrong
    // and what it held sends them to the dashboard to guess.
    expect(() => requireConvexUrls({ ...VALID, NEXT_PUBLIC_CONVEX_URL: "nonsense" })).toThrow(
      /received "nonsense"/,
    )
  })
})

describe("region-qualified deployments", () => {
  // Convex names non-default-region deployments `name.<region>.convex.cloud`.
  // The name *including* the region is the identity, so a pair that differs
  // only in region is two deployments.
  const REGIONAL = {
    NEXT_PUBLIC_CONVEX_URL: "https://happy-otter-123.eu-west-1.convex.cloud",
    NEXT_PUBLIC_CONVEX_SITE_URL: "https://happy-otter-123.eu-west-1.convex.site",
  }

  test("accepts a matching regional pair", () => {
    expect(requireConvexUrls(REGIONAL)).toEqual({
      cloudUrl: REGIONAL.NEXT_PUBLIC_CONVEX_URL,
      siteUrl: REGIONAL.NEXT_PUBLIC_CONVEX_SITE_URL,
    })
    expect(deploymentName(REGIONAL.NEXT_PUBLIC_CONVEX_URL)).toBe("happy-otter-123.eu-west-1")
  })

  test("a regional and an unqualified host are different deployments", () => {
    expect(
      isSameDeployment(
        "https://happy-otter-123.eu-west-1.convex.cloud",
        "https://happy-otter-123.convex.site",
      ),
    ).toBe(false)
  })

  test("still rejects deeper nesting", () => {
    expect(deploymentName("https://a.b.c.convex.cloud")).toBeNull()
  })
})
