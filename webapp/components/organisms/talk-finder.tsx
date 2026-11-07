"use client"

import { useQueries } from "convex/react"
import { motion, useReducedMotion } from "framer-motion"
import { CalendarSyncIcon } from "lucide-react"
import Link from "next/link"
import { useMemo } from "react"
import { TalksSubscribeDialog } from "@/components/molecules/talks-subscribe-dialog"
import {
  FinderQuiz,
  type FinderResult,
  useFinderCompleted,
} from "@/components/organisms/finder-quiz"
import { api } from "@/convex/_generated/api"
import { addDays, formatEventWhen, londonIsoDate, londonMidnight } from "@/lib/calendar"
import { rankTalks, TALK_QUESTIONS, talkSchools } from "@/lib/finder"
import type { TalkListItem } from "@/lib/public-api"
import { TALK_SCHOOL_LABELS } from "@/lib/vocab"

/**
 * The Talk Finder (ENG-131), inside the talks pillar: the quiz, then the best
 * talks of the next one or two weeks and a feed per chosen area. Talks are
 * read only in the browser, through the same public `talks.list` as /talks.
 */
export function TalkFinder() {
  return (
    <FinderQuiz
      eyebrow="Talk Finder"
      questions={TALK_QUESTIONS}
      colleges={[]}
      finishLabel="Show my talks"
    >
      {(result) => <TalkMatches result={result} />}
    </FinderQuiz>
  )
}

function TalkMatches({ result }: { result: FinderResult }) {
  const reduce = useReducedMotion()
  const { answers } = result
  const now = useMemo(() => Date.now(), [])
  const schools = talkSchools(answers)
  const online = answers.online?.[0]
  const requests = useMemo(() => {
    const today = londonIsoDate(now)
    const days = answers.when?.[0] === "week" ? 7 : 14
    return Object.fromEntries(
      schools.map((school) => [
        school,
        {
          query: api.talks.list,
          args: {
            from: londonMidnight(today),
            to: londonMidnight(addDays(today, days + 1)),
            school,
            ...(online === "online"
              ? { online: true }
              : online === "person"
                ? { online: false }
                : {}),
            paginationOpts: { numItems: 100, cursor: null },
          },
        },
      ]),
    )
  }, [schools, online, answers.when, now])
  const pages = useQueries(requests)
  const loading = Object.values(pages).some((page) => page === undefined)
  const talks = useMemo(
    () =>
      Object.values(pages)
        .filter(
          (page): page is { page: TalkListItem[] } => Boolean(page) && !(page instanceof Error),
        )
        .flatMap((page) => page.page),
    [pages],
  )
  const ranked = useMemo(() => rankTalks(talks, answers, now), [talks, answers, now])

  useFinderCompleted("talks", loading ? undefined : ranked.length)

  if (loading) {
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
        <p className="font-serif text-2xl">No talks fit just yet</p>
        <p className="text-muted-foreground">Try “In the next two weeks” or another area.</p>
        <button type="button" onClick={result.restart} className="underline underline-offset-4">
          Start again
        </button>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-5">
      <h2 className="font-serif text-3xl leading-tight tracking-[-0.01em] sm:text-4xl">
        {ranked.length} {ranked.length === 1 ? "talk" : "talks"} for you 🎓
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
            className="flex flex-col gap-1 rounded-2xl border-2 border-border bg-card p-4"
          >
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              {formatEventWhen({
                startsAt: item.startsAt,
                endsAt: item.endsAt ?? undefined,
                allDay: item.allDay,
              })}
            </span>
            <Link
              href={`/talks/${item.key}`}
              className="font-medium underline-offset-4 hover:underline"
            >
              {item.title}
            </Link>
            {item.departments[0] && (
              <span className="text-sm text-muted-foreground">{item.departments[0].shortName}</span>
            )}
            {reasons.length > 0 && (
              <span className="text-xs text-muted-foreground">{reasons.join(" · ")}</span>
            )}
          </motion.li>
        ))}
      </ul>
      <div className="flex flex-col gap-2 rounded-2xl border p-4">
        <p className="font-medium">Get new talks in your calendar</p>
        <div className="flex flex-wrap gap-2">
          {(schools.length > 3 ? [undefined] : schools).map((school) => (
            <TalksSubscribeDialog
              key={school ?? "all"}
              state={{
                school,
                ...(online === "online"
                  ? { online: true }
                  : online === "person"
                    ? { online: false }
                    : {}),
              }}
              trigger={
                <button
                  type="button"
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3.5 text-sm hover:border-brand sm:min-h-9"
                >
                  <CalendarSyncIcon aria-hidden className="size-4" />
                  {school ? TALK_SCHOOL_LABELS[school] : "All talks"}
                </button>
              }
            />
          ))}
        </div>
      </div>
    </div>
  )
}
