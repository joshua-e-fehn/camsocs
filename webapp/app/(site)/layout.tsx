import { unstable_rethrow } from "next/navigation"
import { TermStrip } from "@/components/molecules/term-strip"
import { PublicHeader } from "@/components/organisms/public-header"
import { SiteFooter } from "@/components/organisms/site-footer"
import { fetchTermDates } from "@/lib/term-dates"
import { type TermClock, termClock } from "@/lib/term-week"

/** The term dates for the clock strip and the footer. They are decoration:
 * if Convex cannot be read, the page still renders, without them. */
async function loadTerms(): Promise<{ clock: TermClock | null; sourceUrl?: string }> {
  try {
    const rows = await fetchTermDates()
    const now = Date.now()
    const clock = termClock(now, rows)
    const current =
      clock.kind === "term"
        ? rows.find((row) => row.fullTermStart === clock.fullTermStart)
        : rows.find((row) => row.fullTermStart === clock.next?.fullTermStart)
    return { clock: rows.length > 0 ? clock : null, sourceUrl: current?.sourceUrl }
  } catch (error) {
    // Next signals "this render is dynamic" by throwing; that must pass.
    unstable_rethrow(error)
    console.error("termDates.list failed; rendering without the term clock", error)
    return { clock: null }
  }
}

/** The public site's frame: term strip, header, page, footer (with the
 * disclaimer). */
export default async function SiteLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const { clock, sourceUrl } = await loadTerms()
  return (
    <div className="flex min-h-svh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:shadow"
      >
        Skip to content
      </a>
      <TermStrip clock={clock} />
      <PublicHeader />
      <main id="main" className="flex-1">
        {children}
      </main>
      <SiteFooter clock={clock} termSourceUrl={sourceUrl} />
    </div>
  )
}
