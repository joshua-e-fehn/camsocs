import Link from "next/link"
import { Wordmark } from "@/components/molecules/wordmark"
import { DISCLAIMER, SITE_TAGLINE } from "@/lib/site"

const COLUMNS = [
  {
    title: "Browse",
    links: [
      { href: "/societies", label: "Societies and clubs" },
      { href: "/events", label: "Events" },
    ],
  },
  {
    title: "Your listing",
    links: [
      { href: "/request?kind=claim", label: "Claim or correct a listing" },
      { href: "/request?kind=remove", label: "Ask for removal" },
      { href: "/request?kind=add", label: "Add a missing society" },
    ],
  },
  {
    title: "About",
    links: [
      { href: "/about", label: "How camsocs works" },
      { href: "/privacy", label: "Privacy notice" },
      { href: "/request?kind=object", label: "Object or complain" },
    ],
  },
] as const

/** Footer: wordmark, the non-affiliation disclaimer on every page, and the
 * routes a society needs (claim, correct, remove, object). */
export function SiteFooter() {
  return (
    <footer className="border-t bg-muted/30">
      <div className="mx-auto grid w-full max-w-7xl grid-cols-2 gap-x-6 gap-y-8 px-4 py-12 sm:px-6 md:grid-cols-[1.4fr_repeat(3,1fr)] md:gap-10">
        <div className="col-span-2 flex flex-col gap-3 md:col-span-1">
          <Wordmark />
          <p className="max-w-xs text-sm text-muted-foreground">{SITE_TAGLINE}.</p>
        </div>
        {COLUMNS.map((column) => (
          <nav
            key={column.title}
            aria-label={column.title}
            className="flex flex-col gap-1 md:gap-2"
          >
            <h2 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
              {column.title}
            </h2>
            {column.links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="flex min-h-9 items-center text-sm transition-colors duration-150 hover:text-muted-foreground focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring md:min-h-0"
              >
                {link.label}
              </Link>
            ))}
          </nav>
        ))}
      </div>
      <div className="border-t">
        <p className="mx-auto w-full max-w-7xl px-4 py-5 text-xs text-muted-foreground sm:px-6">
          {DISCLAIMER}
        </p>
      </div>
    </footer>
  )
}
