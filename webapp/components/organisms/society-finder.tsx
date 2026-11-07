"use client"

import { useMutation, useQuery } from "convex/react"
import { motion, useReducedMotion } from "framer-motion"
import { CalendarPlusIcon, CheckIcon } from "lucide-react"
import Link from "next/link"
import { useEffect, useState } from "react"
import { FeedPanel } from "@/components/organisms/feed-panel"
import {
  FinderQuiz,
  type FinderResult,
  useFinderCompleted,
} from "@/components/organisms/finder-quiz"
import { api } from "@/convex/_generated/api"
import type { CollegeInfo } from "@/lib/colleges"
import { readStoredFeed, writeStoredFeed } from "@/lib/feed-storage"
import { SOCIETY_QUESTIONS } from "@/lib/finder"
import { cn } from "@/lib/utils"

type Colleges = readonly Pick<CollegeInfo, "key" | "shortName" | "crest">[]

/** The Society Finder (ENG-128): the quiz, then the matches to follow. */
export function SocietyFinder({ colleges }: { colleges: Colleges }) {
  return (
    <FinderQuiz
      eyebrow="Society Finder"
      questions={SOCIETY_QUESTIONS}
      colleges={colleges}
      finishLabel="Show my societies"
    >
      {(result) => <SocietyMatches result={result} />}
    </FinderQuiz>
  )
}

function SocietyMatches({ result }: { result: FinderResult }) {
  const reduce = useReducedMotion()
  const matches = useQuery(api.orgs.finder, {
    answers: result.answers as Record<string, string[]>,
    collegeKey: result.collegeKey,
  })
  const [unfollowed, setUnfollowed] = useState<Set<string>>(new Set())
  const [stored, setStored] = useState<ReturnType<typeof readStoredFeed>>(null)
  const [feed, setFeed] = useState<{ feedId: string; count: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setStored(readStoredFeed()), [])
  const existing = useQuery(api.feeds.get, stored ? { feedId: stored.feedId } : "skip")
  const create = useMutation(api.feeds.create)
  const update = useMutation(api.feeds.update)
  useFinderCompleted("societies", matches?.length)

  if (matches === undefined) {
    return (
      <ul className="flex flex-col gap-3" aria-busy>
        {Array.from({ length: 5 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholders
          <li key={i} className="h-24 animate-pulse rounded-2xl bg-muted" />
        ))}
      </ul>
    )
  }
  if (matches.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-2xl border border-dashed p-6">
        <p className="font-serif text-2xl">No close matches yet</p>
        <p className="text-muted-foreground">
          Try a few more interests, or “Anywhere in Cambridge”.
        </p>
        <button type="button" onClick={result.restart} className="underline underline-offset-4">
          Start again
        </button>
      </div>
    )
  }

  const followed = matches.filter((m) => !unfollowed.has(m.key)).map((m) => m.key)

  async function follow() {
    setBusy(true)
    setError(null)
    try {
      if (stored && existing) {
        const orgKeys = [...new Set([...existing.orgs.map((o) => o.key), ...followed])]
        const saved = await update({ feedId: stored.feedId, editToken: stored.editToken, orgKeys })
        setFeed({ feedId: stored.feedId, count: saved.orgKeys.length })
      } else {
        const made = await create({ orgKeys: followed })
        writeStoredFeed({ feedId: made.feedId, editToken: made.editToken })
        setStored({ feedId: made.feedId, editToken: made.editToken })
        setFeed({ feedId: made.feedId, count: made.orgKeys.length })
      }
    } catch {
      setError("That did not work. Please try again in a moment.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 className="font-serif text-3xl leading-tight tracking-[-0.01em] sm:text-4xl">
          Your {matches.length} {matches.length === 1 ? "match" : "matches"} ✨
        </h2>
        <p className="text-muted-foreground">
          Untick any you are not interested in, then put the rest in your calendar.
        </p>
      </div>

      <ul className="flex flex-col gap-3">
        {matches.map((match, index) => {
          const on = !unfollowed.has(match.key)
          return (
            <motion.li
              key={match.key}
              initial={reduce ? false : { opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={
                reduce
                  ? { duration: 0 }
                  : { delay: index * 0.05, type: "spring", stiffness: 300, damping: 28 }
              }
              className={cn(
                "flex items-start gap-3 rounded-2xl border-2 bg-card p-4 transition-colors",
                on ? "border-brand/40" : "border-border opacity-70",
              )}
            >
              <label className="relative mt-0.5 grid size-6 shrink-0 cursor-pointer place-items-center">
                <input
                  type="checkbox"
                  checked={on}
                  aria-label={`Follow ${match.name}`}
                  onChange={() =>
                    setUnfollowed((prev) => {
                      const next = new Set(prev)
                      if (next.has(match.key)) next.delete(match.key)
                      else next.add(match.key)
                      return next
                    })
                  }
                  className="peer absolute inset-0 size-6 cursor-pointer appearance-none rounded-md border-2 border-muted-foreground/40 checked:border-brand checked:bg-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                />
                <CheckIcon
                  aria-hidden
                  className="pointer-events-none relative hidden size-4 text-brand-foreground peer-checked:block"
                />
              </label>
              <div className="flex min-w-0 flex-col gap-1.5">
                <Link
                  href={`/societies/${match.slug}`}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {match.name}
                </Link>
                {match.reasons.length > 0 && (
                  <ul className="flex flex-wrap gap-1.5">
                    {match.reasons.map((reason) => (
                      <li
                        key={reason}
                        className="rounded-full bg-accent px-2.5 py-0.5 text-xs text-accent-foreground"
                      >
                        {reason}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-xs text-muted-foreground">
                  {match.upcoming > 0
                    ? `📅 ${match.upcoming} ${match.upcoming === 1 ? "event" : "events"} ${match.inTerm ? "this term" : "coming up"}`
                    : "No events listed yet: its page has how to get in touch"}
                </p>
                {match.shortDescription && (
                  <p className="line-clamp-2 text-sm text-muted-foreground">
                    {match.shortDescription}
                  </p>
                )}
              </div>
            </motion.li>
          )
        })}
      </ul>

      {feed ? (
        <FeedPanel feedId={feed.feedId} count={feed.count} />
      ) : (
        <div className="sticky bottom-3 z-10 flex flex-col gap-2 rounded-2xl border bg-background/95 p-3 shadow-lg backdrop-blur sm:flex-row sm:items-center sm:justify-between">
          <p className="px-1 text-sm">
            {followed.length} selected
            {stored && existing ? ` · added to your calendar of ${existing.orgs.length}` : ""}
          </p>
          <button
            type="button"
            onClick={follow}
            disabled={busy || followed.length === 0}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-brand px-5 text-sm font-medium text-brand-foreground disabled:opacity-40"
          >
            <CalendarPlusIcon aria-hidden className="size-4" />
            {busy ? "Making your calendar…" : `Follow ${followed.length} in my calendar`}
          </button>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
