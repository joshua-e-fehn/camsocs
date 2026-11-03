/**
 * Owner decision G3 (SEO audit 2026-11-02, thin-empty-profiles): a profile
 * with no description (long or short), no public event (upcoming or past)
 * and no website says nothing a search engine should index. It is
 * `noindex, follow` and stays out of the sitemap until any of the three
 * arrives, which lifts it automatically. Shared by the profile page and
 * `orgs.sitemap` (convex/orgs.ts), so the two never disagree; kept apart
 * from lib/directory-profile.ts so Convex imports nothing else with it.
 */
export function isThinProfile({
  hasDescription,
  hasWebsite,
  hasEvents,
}: {
  hasDescription: boolean
  hasWebsite: boolean
  hasEvents: boolean
}): boolean {
  return !hasDescription && !hasWebsite && !hasEvents
}

/**
 * `isThinProfile` for a listing as its page shows it (the guarded public
 * projection: suppressed fields gone, nothing from talks.cam), and whether
 * it has any public event that is not from talks.cam. The profile page and
 * `orgs.sitemap` both call this on that same projection, so a URL in the
 * sitemap is never one its page marks noindex.
 */
export function isThinListing(
  org: { description?: string; shortDescription?: string; website?: string },
  hasEvents: boolean,
): boolean {
  return isThinProfile({
    hasDescription: Boolean(org.description?.trim() || org.shortDescription?.trim()),
    hasWebsite: Boolean(org.website?.trim()),
    hasEvents,
  })
}
