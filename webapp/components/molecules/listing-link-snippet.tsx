import { SITE_NAME, SITE_URL } from "@/lib/site"

/** The HTML a society can paste to link to its listing. */
export function listingLinkHtml(slug: string): string {
  return `<a href="${SITE_URL}/societies/${slug}">Find us on ${SITE_NAME}</a>`
}

/**
 * "Link to your listing": a copy-paste snippet for a society's own website
 * or Linktree, under "Is this your society?" (SEO audit 2026-11-02,
 * backlink-loop). Folded by default and script-free: the code is selectable
 * as one block (`select-all`). Plain text and our own link only — no badge
 * image to host, no tracking parameter.
 */
export function ListingLinkSnippet({ slug }: { slug: string }) {
  return (
    <details className="group pt-1">
      <summary className="cursor-pointer list-none text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring max-sm:inline-flex max-sm:min-h-11 max-sm:items-center [&::-webkit-details-marker]:hidden">
        Link to this listing from your site
      </summary>
      <div className="flex flex-col gap-1.5 pt-2">
        <p className="text-xs text-muted-foreground">
          Paste this where you list your links. It helps students find your events.
        </p>
        <code className="block rounded-md bg-muted px-2.5 py-2 font-mono text-xs break-all select-all">
          {listingLinkHtml(slug)}
        </code>
      </div>
    </details>
  )
}
