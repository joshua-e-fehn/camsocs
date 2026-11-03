import { ArrowUpRightIcon } from "lucide-react"
import Link from "next/link"
import { CookieSettingsButton } from "@/components/molecules/cookie-settings-button"
import { Crest } from "@/components/molecules/crest"
import { formatDayShort } from "@/lib/calendar"
import { CONTACT_EMAIL, DISCLAIMER } from "@/lib/site"
import { TERM_NAMES, type TermClock, weekOfTerm } from "@/lib/term-week"

const COLUMNS = [
  {
    title: "Browse",
    links: [
      { href: "/events", label: "Events" },
      { href: "/talks", label: "Talks" },
      { href: "/societies", label: "Societies and clubs" },
      { href: "/talks/departments", label: "Departments" },
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
    title: "camsocs",
    links: [
      { href: "/about", label: "How camsocs works" },
      { href: "/privacy", label: "Privacy notice" },
      { href: "/terms", label: "Terms of use" },
    ],
  },
] as const

const LINK =
  "inline-flex min-h-11 items-center text-[0.9375rem] transition-colors hover:text-brand-text hover:underline hover:underline-offset-4 focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring md:min-h-8"

/**
 * The footer (DESIGN.md "River & ink"): the sky band again, the crest and a
 * line about the site, three short link columns with the contact address
 * (and "Cookie settings", which reopens the consent banner),
 * then the non-affiliation disclaimer and where we are in the term.
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
    <footer className="mt-12 border-t border-sky-line bg-sky text-foreground">
      <div className="mx-auto grid w-full max-w-7xl grid-cols-2 gap-x-6 gap-y-8 px-4 pt-10 pb-7 sm:px-8 md:grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))] md:gap-10">
        <div className="col-span-2 flex items-start gap-3.5 md:col-span-1">
          <Crest className="w-10 shrink-0" />
          <div className="flex flex-col gap-1">
            <p className="font-serif text-2xl leading-tight">camsocs</p>
            <p className="max-w-xs text-sm text-muted-foreground">
              Everything on in Cambridge, in one place. Made by a student, for anyone curious.
            </p>
          </div>
        </div>
        {COLUMNS.map((column) => (
          <nav
            key={column.title}
            aria-label={column.title}
            className={
              column.title === "camsocs"
                ? "col-span-2 flex flex-col md:col-span-1"
                : "flex flex-col"
            }
          >
            <h2 className="mb-1.5 text-xs font-semibold tracking-[0.08em] text-muted-foreground uppercase">
              {column.title}
            </h2>
            {column.links.map((link) => (
              <Link key={link.href} href={link.href} className={LINK}>
                {link.label}
              </Link>
            ))}
            {column.title === "camsocs" && <CookieSettingsButton className={LINK} />}
            {column.title === "camsocs" && (
              <p className="mt-3 flex flex-col gap-0.5 text-sm text-muted-foreground">
                Missing a society or a talk series?
                <a
                  href={`mailto:${CONTACT_EMAIL}`}
                  className="inline-flex min-h-11 items-center font-mono text-[0.8125rem] text-foreground hover:text-brand-text hover:underline hover:underline-offset-4 md:min-h-8"
                >
                  {CONTACT_EMAIL}
                </a>
              </p>
            )}
          </nav>
        ))}
      </div>

      <div className="border-t border-sky-line">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 px-4 pt-4 pb-9 text-[0.8125rem] text-muted-foreground sm:px-8 md:flex-row md:justify-between md:gap-10">
          <p className="max-w-3xl leading-relaxed">
            <span className="font-medium text-foreground">{DISCLAIMER}</span>
          </p>
          <TermNote clock={clock} sourceUrl={termSourceUrl} />
        </div>
      </div>
    </footer>
  )
}

function TermNote({ clock, sourceUrl }: { clock: TermClock | null; sourceUrl?: string }) {
  if (!clock) return null
  const text =
    clock.kind === "term"
      ? `${TERM_NAMES[clock.term]} ${clock.fullTermStart.slice(0, 4)} · ${weekOfTerm(clock.week)} · Full Term ${formatDayShort(clock.fullTermStart)} – ${formatDayShort(clock.fullTermEnd)}`
      : clock.next
        ? `Vacation · ${TERM_NAMES[clock.next.term]} Full Term from ${formatDayShort(clock.next.fullTermStart)}`
        : "Vacation"
  return (
    <p className="flex shrink-0 flex-col gap-0.5 font-mono tabular-nums md:items-end md:text-right">
      <span>{text}</span>
      {sourceUrl && (
        <a
          href={sourceUrl}
          rel="noopener noreferrer"
          target="_blank"
          className="inline-flex min-h-11 items-center gap-1 font-sans underline-offset-4 hover:text-foreground hover:underline md:min-h-6"
        >
          Dates from the University calendar
          <ArrowUpRightIcon aria-hidden className="size-3" />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      )}
    </p>
  )
}
