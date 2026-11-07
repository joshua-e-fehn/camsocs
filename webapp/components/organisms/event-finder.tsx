"use client"

import { useQuery } from "convex/react"
import { motion, useReducedMotion } from "framer-motion"
import { CalendarPlusIcon } from "lucide-react"
import Link from "next/link"
import { useMemo } from "react"
import { FinderQuiz, type FinderResult } from "@/components/organisms/finder-quiz"
import { api } from "@/convex/_generated/api"
import { addDays, formatEventWhen, londonIsoDate, londonMidnight } from "@/lib/calendar"
import type { CollegeInfo } from "@/lib/colleges"
import { EVENT_KINDS, EVENT_QUESTIONS, eventWindowDays, rankEvents } from "@/lib/finder"
import { CATEGORIES, type Category, EVENT_TYPES, type EventType } from "@/lib/vocab"

type Colleges = readonly Pick<CollegeInfo, "key" | "shortName" | "crest">[]

/** The Events Finder (ENG-130): the quiz, then the best events to go to. */
export function EventFinder({ colleges }: { colleges: Colleges }) {
  return (
    <FinderQuiz
      eyebrow="Events Finder"
      questions={EVENT_QUESTIONS}
      colleges={colleges}
      finishLabel="Show my events"
    >
      {(result) => <EventMatches result={result} />}
    </FinderQuiz>
  )
}

function EventMatches({ result }: { result: FinderResult }) {
  const reduce = useReducedMotion()
  const { answers, collegeKey } = result
  const now = useMemo(() => Date.now(), [])
  const args = useMemo(() => {
    const today = londonIsoDate(now)
    const categories = (answers.interests ?? []).filter((c): c is Category =>
      (CATEGORIES as readonly string[]).includes(c),
    )
    const eventTypes = [
      ...new Set((answers.kind ?? []).flatMap((k) => EVENT_KINDS[k] ?? [])),
    ].filter((t): t is EventType => (EVENT_TYPES as readonly string[]).includes(t))
    return {
      from: londonMidnight(today),
      to: londonMidnight(addDays(today, eventWindowDays(answers) + 1)),
      ...(categories.length > 0 ? { categories } : {}),
      ...(eventTypes.length > 0 ? { eventTypes } : {}),
      ...(collegeKey ? { collegeKeys: [collegeKey] } : {}),
    }
  }, [answers, collegeKey, now])
  const events = useQuery(api.events.list, args)
  const ranked = useMemo(
    () => (events ? rankEvents(events, answers, now) : undefined),
    [events, answers, now],
  )

  if (ranked === undefined) {
    return (
      <ul className="flex flex-col gap-3" aria-busy>
        {Array.from({ length: 5 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholders
          <li key={i} className="h-20 animate-pulse rounded-2xl bg-muted" />
        ))}
      </ul>
    )
  }
  if (ranked.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-2xl border border-dashed p-6">
        <p className="font-serif text-2xl">Nothing fits just yet</p>
        <p className="text-muted-foreground">Try a longer time span or a few more interests.</p>
        <button type="button" onClick={result.restart} className="underline underline-offset-4">
          Start again
        </button>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-5">
      <h2 className="font-serif text-3xl leading-tight tracking-[-0.01em] sm:text-4xl">
        {ranked.length} {ranked.length === 1 ? "event" : "events"} for you 🎟️
      </h2>
      <ul className="flex flex-col gap-3">
        {ranked.map(({ item, reasons }, index) => (
          <motion.li
            key={item.key}
            initial={reduce ? false : { opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={
              reduce
                ? { duration: 0 }
                : { delay: index * 0.05, type: "spring", stiffness: 300, damping: 28 }
            }
            className="flex flex-col gap-1.5 rounded-2xl border-2 border-border bg-card p-4 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
          >
            <div className="flex min-w-0 flex-col gap-1">
              <span className="font-mono text-xs text-muted-foreground tabular-nums">
                {formatEventWhen(item)}
              </span>
              <Link
                href={`/events/${item.key}`}
                className="font-medium underline-offset-4 hover:underline"
              >
                {item.title}
              </Link>
              {item.organisers[0] && (
                <Link
                  href={`/societies/${item.organisers[0].slug}`}
                  className="text-sm text-muted-foreground hover:underline"
                >
                  {item.organisers[0].name}
                </Link>
              )}
              {reasons.length > 0 && (
                <span className="text-xs text-muted-foreground">{reasons.join(" · ")}</span>
              )}
            </div>
            <a
              href={`/events/${item.key}/ics`}
              className="inline-flex min-h-11 shrink-0 items-center gap-1.5 self-start rounded-full border px-3.5 text-sm hover:border-brand sm:min-h-9"
            >
              <CalendarPlusIcon aria-hidden className="size-4" />
              Add to calendar
            </a>
          </motion.li>
        ))}
      </ul>
      <p className="text-sm text-muted-foreground">
        Want everything from the societies you like, automatically?{" "}
        <Link href="/finder" className="text-foreground underline underline-offset-4">
          Take the Society Finder
        </Link>{" "}
        and follow them in one calendar.
      </p>
    </div>
  )
}
