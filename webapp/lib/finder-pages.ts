import { COLLEGE_INFO } from "./colleges"

/** The colleges a Finder's "At my college" picker shows: key, short name, crest. */
export const FINDER_COLLEGES = COLLEGE_INFO.map(({ key, shortName, crest }) => ({
  key,
  shortName,
  crest,
}))

export const FINDER_PAGES = {
  societies: {
    path: "/finder",
    title: "Society Finder: your Cambridge societies in 60 seconds",
    description:
      "Answer five quick questions and get the 15 Cambridge societies and clubs that fit you best, then follow them all in one calendar. No account needed.",
  },
  events: {
    path: "/finder/events",
    title: "Events Finder: what's on in Cambridge for you",
    description:
      "Five quick questions, then the 15 Cambridge student events of the next two weeks that suit you best, each one click from your calendar.",
  },
  talks: {
    path: "/talks/finder",
    title: "Talk Finder: Cambridge talks for you",
    description:
      "Pick your subjects and the times that suit you, and get the 15 best Cambridge talks of the next two weeks, with a feed for each area.",
  },
} as const
