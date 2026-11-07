import { londonIsoDate, londonTime } from "./calendar"
import {
  type ActivityType,
  CATEGORIES,
  CATEGORY_LABELS,
  type Category,
  type EventType,
  TALK_KIND_LABELS,
  TALK_SCHOOL_LABELS,
  TALK_SCHOOLS,
  type TalkKind,
  type TalkSchool,
} from "./vocab"

/**
 * The Finder quizzes (ENG-127): up to five quick questions, several answers
 * each, then the ~15 best societies, events or talks. This file holds the
 * questions and the scoring, both pure, so the server (societies, in Convex)
 * and the browser (events, talks) rank the same way and tests hold them.
 *
 * No question asks about a sensitive characteristic (Art 9): "who you are"
 * is only undergraduate, postgraduate or international student. Answers are
 * never stored; they travel as query arguments and are gone.
 */

export type FinderOption = { id: string; label: string; emoji: string }
export type FinderQuestion = {
  id: string
  prompt: string
  help?: string
  /** Several answers allowed. */
  multi: boolean
  /** May be skipped. */
  optional?: boolean
  options: readonly FinderOption[]
}
export type FinderAnswers = Record<string, readonly string[]>

/** How many results a finder shows. */
export const FINDER_RESULTS = 15

// --- shared options --------------------------------------------------------------------

const CATEGORY_EMOJI: Record<Category, string> = {
  academic: "📚",
  science_tech: "🔬",
  careers_professional: "💼",
  entrepreneurship: "🚀",
  arts_creative: "🎨",
  music: "🎵",
  theatre_film_dance: "🎭",
  media_publishing: "📰",
  cultural_international: "🌍",
  faith: "🕊️",
  politics_debate: "🗳️",
  causes_volunteering: "🤝",
  identity_wellbeing: "🌱",
  sport: "🏅",
  outdoors: "🏕️",
  hobbies_games: "🎲",
}

const interests: FinderQuestion = {
  id: "interests",
  prompt: "What are you into?",
  help: "Pick as many as you like.",
  multi: true,
  options: CATEGORIES.map((c) => ({ id: c, label: CATEGORY_LABELS[c], emoji: CATEGORY_EMOJI[c] })),
}

const where: FinderQuestion = {
  id: "where",
  prompt: "Where should it be?",
  multi: false,
  options: [
    { id: "anywhere", label: "Anywhere in Cambridge", emoji: "🗺️" },
    { id: "university", label: "University-wide, not one college", emoji: "🏛️" },
    { id: "college", label: "At my college", emoji: "🏰" },
  ],
}

// --- societies -------------------------------------------------------------------------

const TAKE_PART: Record<string, readonly ActivityType[]> = {
  compete: ["competitions", "training"],
  perform: ["performances"],
  learn: ["talks", "workshops"],
  socialise: ["socials", "formals"],
  volunteer: ["volunteering"],
  explore: ["trips"],
  create: ["publications"],
  careers: ["careers_events"],
}

export const SOCIETY_QUESTIONS: readonly FinderQuestion[] = [
  interests,
  {
    id: "takePart",
    prompt: "How do you like to take part?",
    help: "Pick any that sound like you.",
    multi: true,
    options: [
      { id: "compete", label: "Compete and train", emoji: "🏆" },
      { id: "perform", label: "Perform on stage", emoji: "🎤" },
      { id: "learn", label: "Talks and workshops", emoji: "💡" },
      { id: "socialise", label: "Socials and formals", emoji: "🥂" },
      { id: "volunteer", label: "Volunteer and campaign", emoji: "🌻" },
      { id: "explore", label: "Trips and adventures", emoji: "🧭" },
      { id: "create", label: "Write, edit, publish", emoji: "✍️" },
      { id: "careers", label: "Careers and networking", emoji: "🤝" },
    ],
  },
  {
    id: "level",
    prompt: "How much have you done before?",
    multi: false,
    options: [
      { id: "beginner", label: "Nothing yet: total beginner", emoji: "🌱" },
      { id: "some", label: "A bit, for fun", emoji: "🙂" },
      { id: "serious", label: "A lot: I want to go far", emoji: "🔥" },
    ],
  },
  {
    id: "who",
    prompt: "Which of these are you?",
    help: "Optional. It only nudges the order.",
    multi: true,
    optional: true,
    options: [
      { id: "undergraduates", label: "Undergraduate", emoji: "🎓" },
      { id: "postgraduates", label: "Postgraduate", emoji: "🔭" },
      { id: "international", label: "International student", emoji: "✈️" },
    ],
  },
  where,
]

/** What the societies finder knows of a listing (an `orgCards` row, public fields). */
export type SocietyFacts = {
  key: string
  name: string
  categories: readonly Category[]
  activityTypes: readonly ActivityType[]
  audiences: readonly string[]
  beginnerFriendly?: boolean
  level?: string
  collegeKeys: readonly string[]
  status: string
  shortDescription?: string
  blueStatus?: string
}

export type Scored<T> = { item: T; score: number; reasons: string[] }

const first = (answers: FinderAnswers, id: string) => answers[id]?.[0]

/** A listing's score for these answers and why, or null when it does not fit
 * at all (another college's own club, nothing the student picked). */
export function scoreSociety(
  card: SocietyFacts,
  answers: FinderAnswers,
  collegeKey?: string,
): Scored<SocietyFacts> | null {
  const reasons: string[] = []
  let score = 0

  const wanted = new Set(answers.interests ?? [])
  const matched = card.categories.filter((c) => wanted.has(c))
  if (wanted.size > 0 && matched.length === 0) return null
  score += 4 * Math.min(matched.length, 2)
  for (const c of matched.slice(0, 2)) reasons.push(CATEGORY_LABELS[c])

  const activities = new Set((answers.takePart ?? []).flatMap((id) => TAKE_PART[id] ?? []))
  const doing = card.activityTypes.filter((a) => activities.has(a))
  score += 2 * Math.min(doing.length, 3)
  if (doing.length > 0) reasons.push(`${doing.length > 1 ? "things" : "something"} you like doing`)

  const level = first(answers, "level")
  const welcomesBeginners = card.beginnerFriendly === true || card.audiences.includes("beginners")
  if (level === "beginner") {
    if (welcomesBeginners) {
      score += 4
      reasons.push("beginners welcome")
    } else if (card.beginnerFriendly === false) score -= 3
  } else if (level === "serious") {
    if (card.blueStatus || card.activityTypes.includes("competitions")) {
      score += 3
      reasons.push(card.blueStatus ? "plays Varsity" : "competes")
    }
  } else if (welcomesBeginners) score += 1

  for (const who of answers.who ?? []) {
    if (card.audiences.includes(who)) {
      score += 2
      reasons.push(who === "international" ? "welcomes international students" : `for ${who}`)
    }
  }
  const onlyPostgrads =
    card.audiences.includes("postgraduates") && !card.audiences.includes("undergraduates")
  if (
    onlyPostgrads &&
    (answers.who ?? []).length > 0 &&
    !(answers.who ?? []).includes("postgraduates")
  )
    score -= 3

  // Another college's own club is never offered; "University-wide" leaves
  // college clubs out, "my college" puts its own first.
  const isCollegeLevel = card.level === "college"
  const atMine = collegeKey !== undefined && card.collegeKeys.includes(collegeKey)
  const place = first(answers, "where")
  if (isCollegeLevel && !atMine) return null
  if (card.audiences.includes("own_college_only") && !atMine) return null
  if (place === "university" && isCollegeLevel) return null
  if (place === "college" && atMine) {
    score += 4
    reasons.push("at your college")
  }

  if (card.status === "active") score += 1.5
  else if (card.status === "dormant") score -= 2
  if (card.shortDescription) score += 0.5
  return { item: card, score, reasons }
}

/** The best `limit` listings, best first; ties by name. */
export function rankSocieties(
  cards: readonly SocietyFacts[],
  answers: FinderAnswers,
  collegeKey?: string,
  limit = FINDER_RESULTS,
): Scored<SocietyFacts>[] {
  return cards
    .map((card) => scoreSociety(card, answers, collegeKey))
    .filter((s): s is Scored<SocietyFacts> => s !== null && s.score > 0)
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name, "en-GB"))
    .slice(0, limit)
}

// --- events ----------------------------------------------------------------------------

export const EVENT_KINDS: Record<string, readonly EventType[]> = {
  talks: ["talk"],
  social: ["social", "formal"],
  shows: ["performance", "exhibition"],
  sport: ["competition", "match", "training"],
  workshops: ["workshop"],
  careers: ["careers", "fair"],
  trips: ["trip"],
}

export const EVENT_QUESTIONS: readonly FinderQuestion[] = [
  interests,
  {
    id: "kind",
    prompt: "What kind of thing?",
    help: "Pick any.",
    multi: true,
    options: [
      { id: "talks", label: "Talks and discussions", emoji: "🎙️" },
      { id: "social", label: "Socials and formals", emoji: "🥂" },
      { id: "shows", label: "Shows and exhibitions", emoji: "🎭" },
      { id: "sport", label: "Sport and matches", emoji: "⚽" },
      { id: "workshops", label: "Workshops and skills", emoji: "🛠️" },
      { id: "careers", label: "Careers and fairs", emoji: "💼" },
      { id: "trips", label: "Trips", emoji: "🚌" },
    ],
  },
  {
    id: "when",
    prompt: "When are you free?",
    multi: false,
    options: [
      { id: "soon", label: "Today or tomorrow", emoji: "⚡" },
      { id: "week", label: "This week", emoji: "📅" },
      { id: "fortnight", label: "In the next two weeks", emoji: "🗓️" },
    ],
  },
  {
    id: "time",
    prompt: "What time of day?",
    help: "Optional.",
    multi: true,
    optional: true,
    options: [
      { id: "day", label: "Daytime", emoji: "☀️" },
      { id: "evening", label: "Evening", emoji: "🌆" },
      { id: "late", label: "Late night", emoji: "🌙" },
    ],
  },
  where,
]

/** Days ahead for the "when" answer. */
export function eventWindowDays(answers: FinderAnswers): number {
  const when = first(answers, "when")
  return when === "soon" ? 2 : when === "week" ? 7 : 14
}

/** "day" before 17:00, "evening" 17:00–20:59, "late" from 21:00 (London);
 * all-day events count as daytime. */
export function timeOfDay(event: {
  startsAt: number
  allDay: boolean
}): "day" | "evening" | "late" {
  if (event.allDay) return "day"
  const hour = Number(londonTime(event.startsAt).slice(0, 2))
  return hour < 17 ? "day" : hour < 21 ? "evening" : "late"
}

export type FinderEvent = {
  key: string
  title: string
  startsAt: number
  endsAt?: number
  allDay: boolean
  eventType: string
  cancelled: boolean
  talksDerived: boolean
  hosting: string
  organisers: { key: string; name: string; slug: string }[]
}

/** The best events: fitting time of day first, sooner first, at most two per
 * organiser so one society cannot fill the list, one row per show. */
export function rankEvents<T extends FinderEvent>(
  events: readonly T[],
  answers: FinderAnswers,
  now: number,
  limit = FINDER_RESULTS,
): Scored<T>[] {
  const times = new Set(answers.time ?? [])
  const kinds = new Set((answers.kind ?? []).flatMap((k) => EVENT_KINDS[k] ?? []))
  const seenTitles = new Set<string>()
  const perOrganiser = new Map<string, number>()
  const scored = events
    .filter((e) => !e.cancelled && !e.talksDerived && (e.endsAt ?? e.startsAt) >= now)
    .map((e) => {
      const reasons: string[] = []
      let score = 10
      if (times.size > 0) {
        if (times.has(timeOfDay(e))) {
          score += 4
          reasons.push(`${timeOfDay(e) === "day" ? "daytime" : timeOfDay(e)}`)
        } else score -= 4
      }
      if (kinds.size > 0 && kinds.has(e.eventType as EventType)) score += 2
      if (e.hosting !== "takes_part") score += 1
      score -= Math.max(0, (e.startsAt - now) / 86_400_000) * 0.3
      return { item: e, score, reasons }
    })
    .sort((a, b) => b.score - a.score || a.item.startsAt - b.item.startsAt)
  const out: Scored<T>[] = []
  for (const s of scored) {
    const title = s.item.title.toLowerCase().trim()
    const org = s.item.organisers[0]?.key ?? s.item.key
    if (seenTitles.has(title) || (perOrganiser.get(org) ?? 0) >= 2) continue
    seenTitles.add(title)
    perOrganiser.set(org, (perOrganiser.get(org) ?? 0) + 1)
    out.push(s)
    if (out.length === limit) break
  }
  return out.sort((a, b) => a.item.startsAt - b.item.startsAt)
}

// --- talks -----------------------------------------------------------------------------

export const TALK_QUESTIONS: readonly FinderQuestion[] = [
  {
    id: "areas",
    prompt: "Which areas interest you?",
    help: "Pick as many as you like.",
    multi: true,
    options: TALK_SCHOOLS.map((s) => ({
      id: s,
      label: TALK_SCHOOL_LABELS[s],
      emoji: {
        arts_humanities: "🏺",
        humanities_social_sciences: "🧭",
        biological_sciences: "🧬",
        clinical_medicine: "🩺",
        physical_sciences: "🪐",
        technology: "⚙️",
        other: "✨",
      }[s],
    })),
  },
  {
    id: "kind",
    prompt: "What kind of talk?",
    help: "Optional.",
    multi: true,
    optional: true,
    options: (["seminar", "lecture", "workshop", "conference"] as const).map((k) => ({
      id: k,
      label: TALK_KIND_LABELS[k],
      emoji: { seminar: "💬", lecture: "🎓", workshop: "🛠️", conference: "🏛️" }[k],
    })),
  },
  {
    id: "when",
    prompt: "When?",
    multi: false,
    options: [
      { id: "week", label: "This week", emoji: "📅" },
      { id: "fortnight", label: "In the next two weeks", emoji: "🗓️" },
    ],
  },
  {
    id: "time",
    prompt: "What time suits you?",
    help: "Optional.",
    multi: true,
    optional: true,
    options: [
      { id: "lunch", label: "Lunchtime", emoji: "🥪" },
      { id: "afternoon", label: "Afternoon", emoji: "☕" },
      { id: "evening", label: "Evening", emoji: "🌆" },
    ],
  },
  {
    id: "online",
    prompt: "In person or online?",
    multi: false,
    options: [
      { id: "any", label: "Either is fine", emoji: "👌" },
      { id: "person", label: "In person", emoji: "🚶" },
      { id: "online", label: "Online", emoji: "💻" },
    ],
  },
]

export type FinderTalk = {
  key: string
  title: string
  startsAt: number
  allDay: boolean
  online: boolean
  kind: TalkKind
  cancelled: boolean
  series: string | null
}

/** "lunch" 11:00–13:59, "afternoon" 14:00–16:59, "evening" from 17:00. */
export function talkTime(talk: {
  startsAt: number
  allDay: boolean
}): "lunch" | "afternoon" | "evening" | "other" {
  if (talk.allDay) return "other"
  const hour = Number(londonTime(talk.startsAt).slice(0, 2))
  return hour >= 11 && hour < 14
    ? "lunch"
    : hour >= 14 && hour < 17
      ? "afternoon"
      : hour >= 17
        ? "evening"
        : "other"
}

/** The best talks: wanted kind and time first, sooner first, two per series. */
export function rankTalks<T extends FinderTalk>(
  talks: readonly T[],
  answers: FinderAnswers,
  now: number,
  limit = FINDER_RESULTS,
): Scored<T>[] {
  const kinds = new Set(answers.kind ?? [])
  const times = new Set(answers.time ?? [])
  const online = first(answers, "online") ?? "any"
  const perSeries = new Map<string, number>()
  const scored = talks
    .filter((t) => !t.cancelled && t.startsAt >= now)
    .filter((t) => online === "any" || (online === "online" ? t.online : !t.online))
    .map((t) => {
      let score = 10
      const reasons: string[] = []
      if (kinds.size > 0) {
        if (kinds.has(t.kind)) {
          score += 3
          reasons.push(TALK_KIND_LABELS[t.kind].toLowerCase())
        } else score -= 2
      }
      if (times.size > 0) {
        if (times.has(talkTime(t))) {
          score += 3
          reasons.push(talkTime(t) === "lunch" ? "lunchtime" : talkTime(t))
        } else score -= 3
      }
      score -= Math.max(0, (t.startsAt - now) / 86_400_000) * 0.3
      return { item: t, score, reasons }
    })
    .sort((a, b) => b.score - a.score || a.item.startsAt - b.item.startsAt)
  const out: Scored<T>[] = []
  for (const s of scored) {
    const series = s.item.series ?? s.item.key
    if ((perSeries.get(series) ?? 0) >= 2) continue
    perSeries.set(series, (perSeries.get(series) ?? 0) + 1)
    out.push(s)
    if (out.length === limit) break
  }
  return out.sort((a, b) => a.item.startsAt - b.item.startsAt)
}

/** The talks finder's schools, or every school when none was picked. */
export function talkSchools(answers: FinderAnswers): TalkSchool[] {
  const picked = (answers.areas ?? []).filter((s): s is TalkSchool =>
    (TALK_SCHOOLS as readonly string[]).includes(s),
  )
  return picked.length > 0 ? picked : [...TALK_SCHOOLS]
}

/** London day of an instant, for result headings. */
export const dayOf = (ms: number) => londonIsoDate(ms)
