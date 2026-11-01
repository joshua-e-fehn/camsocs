// Hooks for the talks pillar (/talks, the ⌘K palette, the home page). Thin
// wrappers over convex/react, like ./index.ts; the argument builders live in
// lib/talks-url-state.ts so the server preloads ask for exactly the same.
import { type Preloaded, usePaginatedQuery, useQuery } from "convex/react"
import { useEffect, useRef } from "react"
import { api } from "@/convex/_generated/api"
import type { TalkListItem } from "@/lib/talks"
import {
  TALKS_PAGE_SIZE,
  type TalkDayCountArgs,
  type TalkListArgs,
  type TalkSearchArgs,
} from "@/lib/talks-url-state"
import { useStickyQuery } from "./use-sticky-query"

/** The first page of `talks.list`, read on the server (`fetchQuery`), with
 * the arguments it was read for. */
export type InitialTalkPage = { args: TalkListArgs; page: TalkListItem[]; isDone: boolean }

export type TalkAgenda = {
  talks: TalkListItem[]
  /** "LoadingFirstPage" only when there is nothing to show yet. */
  status: "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted"
  loadMore: () => void
  /** The filters changed and the previous results are still on screen. */
  stale: boolean
}

/**
 * The agenda: `talks.list` page by page ("Load more"), live. Until the
 * subscription's first page arrives it shows the server's first page (same
 * arguments) or, after a filter change, the previous results — never a blank
 * list between two views.
 */
export function useTalkAgenda(args: TalkListArgs | "skip", initial?: InitialTalkPage): TalkAgenda {
  const { results, status, loadMore } = usePaginatedQuery(api.talks.list, args, {
    initialNumItems: TALKS_PAGE_SIZE,
  })
  const last = useRef<{ talks: TalkListItem[]; done: boolean } | undefined>(undefined)
  const more = () => loadMore(TALKS_PAGE_SIZE)
  if (status !== "LoadingFirstPage") {
    last.current = { talks: results, done: status === "Exhausted" }
    return { talks: results, status, loadMore: more, stale: false }
  }
  if (initial && args !== "skip" && JSON.stringify(initial.args) === JSON.stringify(args)) {
    return {
      talks: initial.page,
      status: initial.isDone ? "Exhausted" : "CanLoadMore",
      loadMore: more,
      stale: false,
    }
  }
  // The previous view, held while the next loads. "LoadingMore" keeps its
  // footer quiet: "Load more" would act on the new arguments, not these rows.
  if (last.current) {
    return {
      talks: last.current.talks,
      status: last.current.done ? "Exhausted" : "LoadingMore",
      loadMore: more,
      stale: true,
    }
  }
  return { talks: [], status: "LoadingFirstPage", loadMore: more, stale: false }
}

/** `talks.search` for the agenda's text query (best matches, upcoming),
 * sticky across changes like the directory's queries. */
export function useTalkSearchResults(
  args: TalkSearchArgs | "skip",
  preloaded?: Preloaded<typeof api.talks.search>,
) {
  return useStickyQuery(api.talks.search, args, preloaded)
}

/** Talks per day for the week strip; sticky while the week or filters change. */
export function useTalkDayCounts(
  args: TalkDayCountArgs | "skip",
  preloaded?: Preloaded<typeof api.talks.dayCounts>,
) {
  return useStickyQuery(api.talks.dayCounts, args, preloaded)
}

/** One listed talk with its abstract: null if it is not listed, undefined
 * while loading or without a key. A server preload of the same key fills
 * the first paint; another talk's details are never shown in its place. */
export function useTalk(key: string | undefined, preloaded?: Preloaded<typeof api.talks.get>) {
  const { data, stale } = useStickyQuery(api.talks.get, key ? { key } : "skip", preloaded)
  if (!key || data === undefined) return undefined
  if (data === null) return stale ? undefined : null
  return data.key === key ? data : undefined
}

const PALETTE_LIMIT = 6

/** Upcoming talks matching `q`, best first — for the ⌘K palette's Talks
 * group. Skipped below two characters; undefined while loading. */
export function useTalkSearch(q: string) {
  const text = q.trim()
  return useQuery(api.talks.search, text.length >= 2 ? { q: text, limit: PALETTE_LIMIT } : "skip")
}

/** Talks read per page while looking for the next one (the list's maximum). */
const NEXT_TALK_PAGE = 100
/** Pages read at most before giving up (500 talks: months of one department). */
const NEXT_TALK_PAGES = 5

/**
 * The first talk matching `args` (a window after the agenda's), for the
 * empty state's "Next talk · Thu 12 Nov". Skipped with "skip".
 *
 * `talks.list` applies `kind` and `online` after reading a page, so a page
 * can come back empty while matches lie further on: keep reading pages
 * (bounded) until one turns up or the window is exhausted.
 */
export function useNextTalk(args: TalkListArgs | "skip"): TalkListItem | null | undefined {
  const { results, status, loadMore } = usePaginatedQuery(api.talks.list, args, {
    initialNumItems: NEXT_TALK_PAGE,
  })
  const found = results.find((talk) => !talk.cancelled)
  const pagesRead = useRef(0)
  const argsKey = args === "skip" ? "skip" : JSON.stringify(args)
  const seenKey = useRef(argsKey)
  if (seenKey.current !== argsKey) {
    seenKey.current = argsKey
    pagesRead.current = 0
  }
  const more = !found && status === "CanLoadMore" && pagesRead.current < NEXT_TALK_PAGES
  useEffect(() => {
    if (!more) return
    pagesRead.current += 1
    loadMore(NEXT_TALK_PAGE)
  }, [more, loadMore])
  if (args === "skip") return undefined
  if (found) return found
  if (status === "LoadingFirstPage" || status === "LoadingMore" || more) return undefined
  return null
}
