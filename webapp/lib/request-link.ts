/**
 * A preset request form link (`/request?kind=…&org=…`, `?event=…`) is the
 * same page as `/request`, its canonical: not worth a crawler's fetch, so it
 * is `rel="nofollow"`; the bare `/request` stays followed (SEO audit
 * 2026-11-02, request-param-urls).
 */
export function requestLinkRel(href: string): "nofollow" | undefined {
  return href.startsWith("/request?") ? "nofollow" : undefined
}
