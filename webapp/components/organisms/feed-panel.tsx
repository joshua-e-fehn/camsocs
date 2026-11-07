"use client"

import { motion, useReducedMotion } from "framer-motion"
import { CalendarSyncIcon } from "lucide-react"
import Link from "next/link"
import { CopyField } from "@/components/molecules/talks-subscribe-dialog"
import { track } from "@/lib/analytics"
import { feedLinks } from "@/lib/feed-storage"
import { SITE_URL } from "@/lib/site"

/**
 * "Your calendar is ready": the personal feed's links (ENG-129). Open in
 * Calendar (webcal) for Apple and most apps, Google's and Outlook's own
 * "add by URL" pages, and the link to copy.
 */
export function FeedPanel({ feedId, count }: { feedId: string; count: number }) {
  const reduce = useReducedMotion()
  const links = feedLinks(SITE_URL, feedId)
  const onSubscribe = () => track("calendar_subscribe_clicked", { feed: "personal" })
  const button =
    "inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
  return (
    <motion.section
      aria-labelledby="feed-ready"
      initial={reduce ? false : { opacity: 0, y: 16, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 300, damping: 26 }}
      className="flex flex-col gap-4 rounded-3xl border-2 border-brand bg-accent/40 p-5 sm:p-6"
    >
      <div className="flex items-start gap-3">
        <motion.span
          aria-hidden
          className="text-4xl"
          initial={reduce ? false : { rotate: -20, scale: 0.4 }}
          animate={{ rotate: 0, scale: 1 }}
          transition={{ type: "spring", stiffness: 260, damping: 12 }}
        >
          🎉
        </motion.span>
        <div>
          <h2 id="feed-ready" className="font-serif text-2xl leading-tight">
            Your calendar is ready
          </h2>
          <p className="text-muted-foreground">
            {count} {count === 1 ? "society’s" : "societies’"} public events for the next 60 days,
            kept up to date by your calendar app.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <a
          href={links.webcal}
          onClick={onSubscribe}
          className={`${button} bg-brand text-brand-foreground hover:bg-brand/90`}
        >
          <CalendarSyncIcon aria-hidden className="size-4" />
          Open in Calendar
        </a>
        <a
          href={links.google}
          onClick={onSubscribe}
          target="_blank"
          rel="noopener noreferrer"
          className={`${button} border bg-card hover:border-brand`}
        >
          Google Calendar
        </a>
        <a
          href={links.outlook}
          onClick={onSubscribe}
          target="_blank"
          rel="noopener noreferrer"
          className={`${button} border bg-card hover:border-brand`}
        >
          Outlook
        </a>
      </div>
      <CopyField label="Feed link" value={links.https} onCopied={onSubscribe} />
      <p className="text-sm text-muted-foreground">
        No account needed: this browser remembers your calendar, so you can{" "}
        <Link href="/finder/calendar" className="text-foreground underline underline-offset-4">
          add or remove societies
        </Link>{" "}
        later. Anyone with the link sees the same public events.
      </p>
    </motion.section>
  )
}
