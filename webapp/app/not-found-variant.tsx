"use client"

import { useEffect, useState } from "react"
import { listingPath } from "@/lib/missing-listing"

/** Whether the address in the browser is a talk's (`/talks/<key>`): its
 * not-found page is the talks pillar's, not the site's. */
export function isTalkAddress(pathname: string): boolean {
  return listingPath(pathname)?.kind === "talk"
}

/**
 * The body of the site's 404 (app/not-found.tsx): the site's own not-found
 * page in the server's HTML, and — once hydrated, for a talk's address — the
 * talks pillar's.
 *
 * Why not decided on the server: Next renders the root not-found into every
 * route's payload, whether or not it is shown, so a request header read
 * there (how proxy.ts used to name the kind) made every page dynamic and
 * uncacheable (SEO audit 2026-11-02, no-cdn-cache). The browser's address is
 * the one the reader asked for: proxy.ts's rewrite does not change it.
 */
export function NotFoundVariant({ site, talk }: { site: React.ReactNode; talk: React.ReactNode }) {
  const [onTalk, setOnTalk] = useState(false)
  useEffect(() => setOnTalk(isTalkAddress(window.location.pathname)), [])
  return <>{onTalk ? talk : site}</>
}
