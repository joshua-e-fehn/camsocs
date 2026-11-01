import { ArrowLeftIcon, LandmarkIcon, SearchXIcon } from "lucide-react"
import Link from "next/link"

/**
 * A talk that is not (or no longer) listed: a stale shared link, most often,
 * since talks are cancelled or taken down at their source. The way back is
 * to the talks pillar, not the societies directory (app/(site)/not-found.tsx).
 */
export default function TalkNotFound() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col items-start gap-4 px-4 py-16 sm:px-6 sm:py-24">
      <p className="flex items-center gap-2 font-mono text-[0.6875rem] font-medium tracking-[0.14em] text-talks uppercase">
        <span aria-hidden className="h-px w-6 bg-talks" />
        Talks
      </p>
      <h1 className="font-serif text-[clamp(2rem,5vw,3rem)] leading-[1.08] font-normal tracking-[-0.02em]">
        This talk is no longer listed
      </h1>
      <p className="flex gap-2.5 text-pretty text-muted-foreground">
        <SearchXIcon aria-hidden className="mt-1 size-4 shrink-0" />
        <span>
          It may have been cancelled or removed by its organisers, or the link is mistyped. Talks
          leave the listing a month after they take place.
        </span>
      </p>
      <div className="flex flex-wrap gap-2">
        <Link
          href="/talks"
          className="inline-flex h-11 items-center gap-2 rounded-full border bg-card px-4 text-sm font-medium transition-colors hover:border-foreground/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <ArrowLeftIcon aria-hidden className="size-4" />
          Upcoming talks
        </Link>
        <Link
          href="/talks/departments"
          className="inline-flex h-11 items-center gap-2 rounded-full border bg-card px-4 text-sm font-medium transition-colors hover:border-foreground/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <LandmarkIcon aria-hidden className="size-4" />
          Browse departments
        </Link>
      </div>
    </div>
  )
}
