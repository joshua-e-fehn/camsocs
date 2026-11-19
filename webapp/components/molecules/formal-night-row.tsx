import Link from "next/link"
import { CollegeCrest } from "@/components/molecules/college-crest"
import { ExternalLink } from "@/components/molecules/external-link"
import type { FormalAudience } from "@/lib/colleges"
import { type FormalSlot, frequencyLabel, priceLabel } from "@/lib/formal-week"

const AUDIENCE: Readonly<Record<FormalAudience, string | null>> = {
  all_members: null,
  jcr: "Undergraduates",
  mcr: "Graduates",
}

/**
 * One college's formal on one night (/formals, ENG-272): crest, the college
 * (its formal hall section), the college's name for the dinner, the start
 * time, how a visitor gets in and the published price with its date, any
 * qualifier ("with wine") and source. A night that is not every week says how
 * often it runs ("every other week"); one that also runs out of term says so.
 */
export function FormalNightRow({ slot }: { slot: FormalSlot }) {
  const { night } = slot
  const audience = AUDIENCE[night.audience]
  const price = priceLabel(slot.price)
  const frequency = frequencyLabel(night)
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-1 px-4 py-3 sm:grid-cols-[auto_minmax(0,14rem)_minmax(0,1fr)_auto] sm:gap-x-4">
      <CollegeCrest
        crest={slot.crest}
        size={32}
        decorative
        className="row-span-3 mt-0.5 sm:row-span-1"
      />
      <div className="flex min-w-0 flex-col">
        <Link
          href={slot.href}
          className="inline-flex min-h-11 items-center self-start font-medium underline decoration-muted-foreground/50 underline-offset-4 hover:decoration-foreground sm:min-h-0"
        >
          {slot.shortName}
        </Link>
        <span className="text-sm text-muted-foreground">
          {night.label}
          {audience && ` · ${audience}`}
          {frequency && ` · ${frequency}`}
        </span>
      </div>
      <p className="col-start-2 text-sm sm:col-start-3 sm:row-start-1">
        {slot.visitorRoute === "unknown" ? (
          <span className="text-muted-foreground">Visitor route not published</span>
        ) : (
          slot.bookingSummary
        )}
        {price && slot.price && (
          <span className="block text-xs text-muted-foreground">
            <span className="font-mono tabular-nums">{price}</span>
            {slot.price.caveat && <span>, {slot.price.caveat}</span>}
            {slot.price.sourceUrl && (
              <>
                {" · "}
                <ExternalLink href={slot.price.sourceUrl} className="underline">
                  source
                </ExternalLink>
              </>
            )}
          </span>
        )}
        {!price && slot.priceWithheld && (
          <span className="block text-xs text-muted-foreground">
            No price published for this night
          </span>
        )}
      </p>
      <div className="col-start-2 flex flex-wrap items-center gap-x-3 sm:col-start-4 sm:row-start-1 sm:flex-col sm:items-end">
        <span className="font-mono text-sm tabular-nums">
          {night.startTime ?? <span className="text-muted-foreground">time not published</span>}
        </span>
        {!night.termOnly && (
          <span className="font-mono text-xs text-muted-foreground">also out of term</span>
        )}
      </div>
    </li>
  )
}
