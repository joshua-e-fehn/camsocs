import { ArrowRightIcon } from "lucide-react"
import Link from "next/link"
import { ExternalLink } from "@/components/molecules/external-link"
import { RichText } from "@/components/molecules/rich-text"
import { formatDate } from "@/lib/calendar"
import { type CollegeInfo, FORMAL_ANCHOR } from "@/lib/colleges"

/**
 * A college's formal hall rules (lib/colleges.ts) on its own page: the facts
 * a visitor needs first, then the checked note with its links, the day it was
 * checked and the college's own page, which is the authority.
 */
export function FormalHallBox({ college }: { college: CollegeInfo }) {
  const { formal } = college
  const facts = [
    ["Formal nights", formal.formalNights],
    ["Guests", formal.guests],
    ["Booking", formal.booking],
    ["Dress", formal.dress],
    ["Price", formal.price],
  ].filter((row): row is [string, string] => Boolean(row[1]))
  return (
    <section
      id={FORMAL_ANCHOR}
      aria-labelledby={`${FORMAL_ANCHOR}-title`}
      className="flex scroll-mt-20 flex-col gap-4 rounded-2xl border p-5 sm:p-6"
    >
      <div className="flex flex-col gap-1">
        <h2
          id={`${FORMAL_ANCHOR}-title`}
          className="font-serif text-2xl font-medium tracking-tight"
        >
          Formal hall at {college.shortName}
        </h2>
        <p className="text-base">{formal.visitors}</p>
      </div>
      {facts.length > 0 && (
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[9rem_1fr]">
          {facts.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="min-w-0">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      <RichText text={formal.note} className="text-sm leading-relaxed text-muted-foreground" />
      <p className="font-mono text-xs text-muted-foreground">
        Checked {formatDate(formal.checkedOn)} against the college’s pages · the{" "}
        <ExternalLink href={formal.primarySourceUrl} className="underline">
          college’s own page
        </ExternalLink>{" "}
        is the authority; rules change between terms.
      </p>
      <Link
        href="/guides/formal-hall"
        className="inline-flex min-h-11 items-center gap-1 self-start text-sm font-medium underline underline-offset-4 sm:min-h-0"
      >
        How formal hall works, and every college’s rules
        <ArrowRightIcon aria-hidden className="size-3.5" />
      </Link>
    </section>
  )
}
