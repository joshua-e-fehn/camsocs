import { ArrowRightIcon } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { ExternalLink } from "@/components/molecules/external-link"
import { FormalTracker } from "@/components/organisms/formal-tracker"
import {
  COLLEGE_INFO,
  COLLEGES_PATH,
  CREST_CREDIT,
  CREST_CREDIT_URL,
  collegeRefs,
} from "@/lib/colleges"
import { FORMAL_BADGES, FORMAL_RANKS } from "@/lib/formal-ranks"
import { pageMetadata } from "@/lib/page-metadata"
import { DISCLAIMER } from "@/lib/site"

/**
 * The formal tracker (ENG-272): the "one formal at every college" challenge,
 * ported from the Cambridge Tracker. This page is a static, anonymous shell
 * (no headers, cookies or token, docs/webapp.md "Caching"): the explanation,
 * ranks and badges are in its HTML for readers and crawlers, and the
 * member's own tracker (`FormalTracker`) is drawn in the browser once the
 * session reaches the Convex client.
 */

const PATH = "/formals/tracker"
const TITLE = "Formal tracker: a formal at every Cambridge college"
const DESCRIPTION = `Tick off all ${COLLEGE_INFO.length} Cambridge colleges' formal halls, earn ranks and badges, keep your own notes, and join the members' leaderboard if you like.`

export const metadata: Metadata = pageMetadata({
  title: TITLE,
  description: DESCRIPTION,
  path: PATH,
})

const LINK =
  "underline decoration-muted-foreground/50 underline-offset-4 hover:decoration-foreground"
const SECTION_HEAD =
  "border-t-2 border-foreground pt-3 font-serif text-2xl font-medium tracking-tight"

export default function FormalTrackerPage() {
  return (
    <article>
      <header className="border-b bg-card/40">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 px-4 pt-6 pb-7 sm:px-6 sm:pt-8">
          <p className="font-mono text-xs tracking-wider text-muted-foreground uppercase">
            <Link href="/formals" className={LINK}>
              Formals
            </Link>{" "}
            · Tracker
          </p>
          <h1 className="font-serif text-4xl font-medium tracking-tight text-balance sm:text-5xl">
            One formal at every college
          </h1>
          <p className="max-w-3xl text-lg leading-relaxed text-pretty">
            There are {COLLEGE_INFO.length} colleges, and each has a formal hall. Some students try
            to eat at every one before they leave. Tick them off here as you go, collect a rank and
            a few badges on the way, and keep a note of each night.
          </p>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-7xl flex-col gap-14 px-4 py-8 sm:px-6 lg:py-10">
        <FormalTracker colleges={collegeRefs()} />

        <section aria-labelledby="how" className="grid gap-8 lg:grid-cols-[2fr_3fr]">
          <div className="flex flex-col gap-3">
            <h2 id="how" className={SECTION_HEAD}>
              How it works
            </h2>
            <p className="text-pretty">
              Sign in with your @cam.ac.uk address and press a college’s crest once you have had a
              formal there. Add the date, how many times you have been and a few words to remember
              it by. Most formals need a member of that college to sign you in, or a swap through a
              common room or society:{" "}
              <Link href="/formals" className={LINK}>
                see which colleges dine on which night
              </Link>{" "}
              and{" "}
              <Link href="/guides/formal-hall" className={LINK}>
                how visitors get in
              </Link>
              .
            </p>
            <p className="text-sm text-muted-foreground">
              Your tracker is private to your account. The leaderboard is off unless you switch it
              on; it shows only the name you choose for it, your college if you give one, and your
              counts, and only signed-in Cambridge members can see it. “Erase my tracker” deletes
              everything at once.
            </p>
          </div>
          <div className="grid gap-8 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <h3 className="font-semibold">Ranks</h3>
              <ol className="flex flex-col">
                {FORMAL_RANKS.map((rank) => (
                  <li
                    key={rank.title}
                    className="flex items-baseline justify-between gap-4 border-t py-2"
                  >
                    <span>{rank.title}</span>
                    <span className="font-mono text-xs text-muted-foreground tabular-nums">
                      {rank.min === 1 ? "1 college" : `${rank.min} colleges`}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
            <div className="flex flex-col gap-2">
              <h3 className="font-semibold">Badges</h3>
              <ul className="flex flex-col">
                {FORMAL_BADGES.map((badge) => (
                  <li key={badge.id} className="flex flex-col gap-0.5 border-t py-2">
                    <span>{badge.title}</span>
                    <span className="text-sm text-muted-foreground">{badge.description}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <footer className="flex max-w-3xl flex-col gap-2 text-sm text-muted-foreground">
          <Link
            href={COLLEGES_PATH}
            className="inline-flex min-h-11 items-center gap-1 self-start font-medium text-foreground underline underline-offset-4 sm:min-h-0"
          >
            All {COLLEGE_INFO.length} colleges and their formal hall rules
            <ArrowRightIcon aria-hidden className="size-3.5" />
          </Link>
          <p>
            <ExternalLink href={CREST_CREDIT_URL} className="underline">
              {CREST_CREDIT}
            </ExternalLink>
          </p>
          <p>{DISCLAIMER}</p>
        </footer>
      </div>
    </article>
  )
}
