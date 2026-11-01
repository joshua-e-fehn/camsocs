import { ArrowUpRightIcon } from "lucide-react"
import Link from "next/link"
import { RiverLine } from "@/components/molecules/river-line"
import { formatDayShort } from "@/lib/calendar"
import { DISCLAIMER } from "@/lib/site"
import { TERM_NAMES, type TermClock, weekOfTerm } from "@/lib/term-week"

const COLUMNS = [
  {
    title: "Directory",
    links: [
      { href: "/societies", label: "Societies and clubs" },
      { href: "/#colleges", label: "By college" },
      { href: "/#categories", label: "By category" },
    ],
  },
  {
    title: "Calendar",
    links: [
      { href: "/events", label: "Events" },
      { href: "/talks", label: "Talks" },
    ],
  },
  {
    title: "For societies",
    links: [
      { href: "/request?kind=claim", label: "Claim or correct a listing" },
      { href: "/request?kind=add", label: "Add a missing society" },
      { href: "/request?kind=remove", label: "Ask for removal" },
      { href: "/request?kind=object", label: "Object or complain" },
    ],
  },
  {
    title: "About",
    links: [
      { href: "/about", label: "How camsocs works" },
      { href: "/privacy", label: "Privacy notice" },
    ],
  },
] as const

const LINK =
  "flex min-h-11 items-center text-sm text-foreground/85 transition-colors duration-150 hover:text-primary focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring md:min-h-8"

/**
 * The editorial footer (spec §6 "Shell"): the river from Grantchester to
 * Baits Bite, link columns, where we are in the term, an oversized italic
 * wordmark and the non-affiliation disclaimer on every page.
 *
 * It is a night-river band in both themes: the `dark` class scopes the dark
 * tokens to this subtree, so it needs no colours of its own.
 */
export function SiteFooter({
  clock,
  termSourceUrl,
}: {
  clock: TermClock | null
  /** Where the term dates were read (the `termDates` row's `sourceUrl`). */
  termSourceUrl?: string
}) {
  return (
    <footer className="dark relative overflow-hidden bg-card text-foreground">
      <div className="mx-auto w-full max-w-7xl px-4 pt-10 sm:px-6">
        <RiverLine strokeClassName="stroke-primary/70" className="h-8! sm:h-10!" />
        <div
          aria-hidden
          className="mt-1 flex justify-between font-mono text-[0.625rem] tracking-[0.16em] text-muted-foreground uppercase"
        >
          <span>Grantchester</span>
          <span>Baits Bite</span>
        </div>
      </div>

      <div className="mx-auto grid w-full max-w-7xl grid-cols-2 gap-x-6 gap-y-8 px-4 pt-10 pb-6 sm:px-6 md:grid-cols-5 md:gap-8">
        {COLUMNS.map((column) => (
          <nav key={column.title} aria-label={column.title} className="flex flex-col">
            <h2 className="mb-2 font-serif text-base text-muted-foreground italic">
              {column.title}
            </h2>
            {column.links.map((link) => (
              <Link key={link.href} href={link.href} className={LINK}>
                {link.label}
              </Link>
            ))}
          </nav>
        ))}
        <section aria-labelledby="footer-term" className="col-span-2 flex flex-col md:col-span-1">
          <h2 id="footer-term" className="mb-2 font-serif text-base text-muted-foreground italic">
            Term
          </h2>
          <TermNote clock={clock} />
          {termSourceUrl && (
            <a
              href={termSourceUrl}
              rel="noopener noreferrer"
              target="_blank"
              className="mt-1 inline-flex min-h-11 items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline md:min-h-8"
            >
              Full Term dates, from the University calendar
              <ArrowUpRightIcon aria-hidden className="size-3" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          )}
        </section>
      </div>

      <div aria-hidden className="mx-auto w-full max-w-7xl overflow-hidden px-3 sm:px-5">
        <p className="translate-y-[0.2em] font-serif text-[clamp(5.5rem,25vw,22rem)] leading-[0.8] font-light tracking-[-0.04em] text-foreground/90 italic select-none">
          camsocs
        </p>
      </div>

      <div className="border-t">
        <p className="mx-auto w-full max-w-7xl px-4 py-5 text-xs leading-relaxed text-muted-foreground sm:px-6">
          {DISCLAIMER}
        </p>
      </div>
    </footer>
  )
}

function TermNote({ clock }: { clock: TermClock | null }) {
  if (!clock) {
    return <p className="text-sm text-muted-foreground">Term dates are not available just now.</p>
  }
  if (clock.kind === "vacation") {
    return (
      <p className="flex flex-col gap-0.5 text-sm">
        <span>Vacation</span>
        {clock.next && (
          <span className="text-muted-foreground">
            {TERM_NAMES[clock.next.term]} Full Term from {formatDayShort(clock.next.fullTermStart)}
          </span>
        )}
      </p>
    )
  }
  return (
    <p className="flex flex-col gap-0.5 text-sm">
      <span>
        {TERM_NAMES[clock.term]} {clock.fullTermStart.slice(0, 4)}
      </span>
      <span className="font-mono text-[0.8125rem] text-primary tabular-nums">
        {weekOfTerm(clock.week)}
      </span>
      <span className="text-muted-foreground">
        Full Term {formatDayShort(clock.fullTermStart)} – {formatDayShort(clock.fullTermEnd)}
      </span>
    </p>
  )
}
