import { SiteFrame } from "./site-frame"

/**
 * Seconds a public page is served from Vercel's edge before it is rendered
 * again (SEO audit 2026-11-02, no-cdn-cache; docs/webapp.md "Caching").
 *
 * Every page here is static and revalidated unless it reads its search
 * params (the directory, the calendar, the talks agenda, the form) or a
 * cookie: its Convex reads are anonymous and cached (lib/public-data.ts), and
 * nothing above it reads the session (app/layout.tsx). Dynamic segments
 * build no page with the site (`generateStaticParams` returns none), so a
 * build never reads Convex for them; each is rendered on its first request.
 * Must stay a literal (Next reads it statically).
 */
export const revalidate = 300

/** The public site's frame around every public page (site-frame.tsx). */
export default function SiteLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <SiteFrame>{children}</SiteFrame>
}
