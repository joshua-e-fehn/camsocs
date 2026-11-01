import { PublicHeader } from "@/components/organisms/public-header"
import { SiteFooter } from "@/components/organisms/site-footer"
import { loadTermClock } from "@/lib/term-dates"

/** The public site's frame: header, page, footer (with the disclaimer). */
export default async function SiteLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const { clock, sourceUrl } = await loadTermClock()
  return (
    <div className="flex min-h-svh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:shadow"
      >
        Skip to content
      </a>
      <PublicHeader />
      {/* Focusable so the skip link and the consent banner can hand focus here. */}
      <main id="main" tabIndex={-1} className="flex-1 outline-none">
        {children}
      </main>
      <SiteFooter clock={clock} termSourceUrl={sourceUrl} />
    </div>
  )
}
