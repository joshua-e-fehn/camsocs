import { headers } from "next/headers"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { MISSING_LISTING_HEADER, missingListingKind } from "@/lib/missing-listing"
import SiteNotFound from "./(site)/not-found"
import { SiteFrame } from "./(site)/site-frame"
import TalkNotFound from "./(site)/talks/[key]/not-found"

/**
 * Any URL no route matches, with status 404 and rendered on the server.
 *
 * proxy.ts rewrites an unknown society, event or talk URL here (ENG-20,
 * lib/missing-listing.ts) and names the kind of listing in a request header:
 * those get the public site's frame and the not-found page their segment
 * would show — the talks one for a talk, the site's own for the rest.
 */
export default async function NotFound() {
  const kind = missingListingKind((await headers()).get(MISSING_LISTING_HEADER))
  if (kind) {
    return <SiteFrame>{kind === "talk" ? <TalkNotFound /> : <SiteNotFound />}</SiteFrame>
  }
  return (
    <div className="flex min-h-svh flex-col items-center justify-center p-6 font-sans">
      <div className="flex items-center gap-5">
        <h1 className="text-2xl font-medium">404</h1>
        <div className="h-12 w-px bg-border" />
        <p className="text-sm">This page could not be found.</p>
      </div>
      <Button variant="outline" className="mt-6" asChild>
        <Link href="/">Back to home</Link>
      </Button>
    </div>
  )
}
