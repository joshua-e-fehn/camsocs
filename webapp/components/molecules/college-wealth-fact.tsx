import { ArrowRightIcon } from "lucide-react"
import Link from "next/link"
import type { hubWealthFact } from "@/lib/college-wealth-view"

/**
 * A college's endowment on its own page (/societies/<college>, ENG-272):
 * one line, its rank of 31 and the year, linking its row in the ranking
 * (`/colleges/wealth#<slug>`). From the ranking's own view, so the two
 * pages never disagree.
 */
export function CollegeWealthFact({
  fact,
}: {
  fact: NonNullable<ReturnType<typeof hubWealthFact>>
}) {
  return (
    <section
      aria-labelledby="college-wealth"
      className="flex flex-col gap-2 rounded-2xl border p-5"
    >
      <h2 id="college-wealth" className="font-serif text-2xl font-medium tracking-tight">
        Wealth
      </h2>
      <p className="font-mono text-sm tabular-nums">{fact.text}</p>
      <Link
        href={fact.href}
        className="inline-flex min-h-11 items-center gap-1 self-start text-sm font-medium underline underline-offset-4 sm:min-h-0"
      >
        {fact.linkText}
        <ArrowRightIcon aria-hidden className="size-3.5" />
      </Link>
    </section>
  )
}
