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
    title: "Which Cambridge society should I join? Take the quiz",
    description:
      "Not sure which Cambridge society to join? Five quick questions find the 15 societies and clubs that fit you, then follow them all in one calendar.",
  },
  events: {
    path: "/finder/events",
    title: "What's on in Cambridge this week? Events picked for you",
    description:
      "This week's best Cambridge student events, and a five-question quiz that picks the 15 that suit you, each one click from your calendar.",
  },
  talks: {
    path: "/talks/finder",
    title: "Interesting talks in Cambridge this week: Talk Finder",
    description:
      "Interesting talks in Cambridge this week, and a quick quiz: pick your subjects and times, get the 15 best talks and a calendar feed for each area.",
  },
} as const

/** The interests /finder shows as "popular starting points" (ENG-134). */
export const STARTING_POINTS = [
  "music",
  "sport",
  "theatre_film_dance",
  "politics_debate",
  "careers_professional",
  "science_tech",
  "cultural_international",
  "outdoors",
  "hobbies_games",
] as const
