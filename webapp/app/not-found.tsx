import type { Metadata } from "next"
import SiteNotFound from "./(site)/not-found"
import { SiteFrame } from "./(site)/site-frame"
import TalkNotFound from "./(site)/talks/[key]/not-found"
import { NotFoundVariant } from "./not-found-variant"

/** Its own title, not the home page's (SEO audit 2026-11-02,
 * not-found-template). Next adds `noindex` to every 404 itself. */
export const metadata: Metadata = {
  title: "Page not found",
  description: "There is no page at this address on CAMsocs.",
}

/**
 * Any URL no route matches, with status 404 and rendered on the server,
 * always inside the public site's frame, so a mistyped or stale link still
 * leads somewhere: the header, the directory and the footer.
 *
 * proxy.ts rewrites an unknown society, event or talk URL here (ENG-20,
 * lib/missing-listing.ts). A talk gets the talks pillar's not-found page once
 * hydrated, everything else the site's (`NotFoundVariant`).
 *
 * ⚠ Static: no `headers()`, `cookies()` or other request read. Next renders
 * this component into every route's payload, so one such read would make
 * every page of the site dynamic and uncacheable (docs/webapp.md "Caching").
 */
export default function NotFound() {
  return (
    <SiteFrame>
      <NotFoundVariant site={<SiteNotFound />} talk={<TalkNotFound />} />
    </SiteFrame>
  )
}
