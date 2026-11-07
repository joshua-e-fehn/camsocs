import { ArrowRightIcon } from "lucide-react"
import Link from "next/link"
import { ExternalLink } from "@/components/molecules/external-link"
import { formatDate } from "@/lib/calendar"
import {
  BALL_KIND_LABELS,
  MAY_BALL_ANCHOR,
  MAY_BALLS_CHECKED_ON,
  type MayBall,
} from "@/lib/may-balls"

/**
 * A college's May Ball or June Event (lib/may-balls.ts) on its own page:
 * the date, tickets, dress and workers as the ball's site gives them, and a
 * link to that site, which is the authority.
 */
export function MayBallBox({ balls, college }: { balls: readonly MayBall[]; college: string }) {
  if (balls.length === 0) return null
  const title = balls.every((ball) => ball.kind === "june_event")
    ? `June Event at ${college}`
    : `May Ball at ${college}`
  return (
    <section
      id={MAY_BALL_ANCHOR}
      aria-labelledby={`${MAY_BALL_ANCHOR}-title`}
      className="flex scroll-mt-20 flex-col gap-4 rounded-2xl border p-5 sm:p-6"
    >
      <h2
        id={`${MAY_BALL_ANCHOR}-title`}
        className="font-serif text-2xl font-medium tracking-tight"
      >
        {title}
      </h2>
      {balls.map((ball) => {
        const facts = [
          ["Date", ball.dateText],
          ["How often", ball.frequency],
          ["Tickets", ball.tickets],
          ["Price", ball.price],
          ["Dress", ball.dress],
          ["Workers", ball.workers],
          ["Theme", ball.theme],
        ].filter((row): row is [string, string] => Boolean(row[1]))
        return (
          <div key={ball.name} className="flex flex-col gap-3">
            <p className="text-base">
              <span className="font-medium">{ball.name}</span>
              <span className="text-muted-foreground"> · {BALL_KIND_LABELS[ball.kind]}</span>
            </p>
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[9rem_1fr]">
              {facts.map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="min-w-0">{value}</dd>
                </div>
              ))}
            </dl>
            {ball.website && (
              <p className="text-sm">
                <ExternalLink href={ball.website} className="underline">
                  The ball’s own site
                </ExternalLink>{" "}
                <span className="text-muted-foreground">
                  is the authority for dates and tickets.
                </span>
              </p>
            )}
          </div>
        )
      })}
      <p className="font-mono text-xs text-muted-foreground">
        Checked {formatDate(MAY_BALLS_CHECKED_ON)}. Not run by CAMsocs; we sell no tickets.
      </p>
      <Link
        href={`/guides/may-balls`}
        className="inline-flex min-h-11 items-center gap-1 self-start text-sm font-medium underline underline-offset-4 sm:min-h-0"
      >
        Every college’s May Ball, and how tickets work
        <ArrowRightIcon aria-hidden className="size-3.5" />
      </Link>
    </section>
  )
}
