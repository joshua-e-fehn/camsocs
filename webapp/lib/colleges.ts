import data from "@/lib/data/colleges.json"

/**
 * The 31 colleges' crests and formal hall rules (ENG-107, ENG-112), carried
 * over from the Cambridge Tracker (its `formals.json`, researched 8 Oct 2026)
 * and re-checked statement by statement against each college's own pages
 * (`checkedOn`). Keyed by the college's CAMsocs organisation key, so the
 * directory's colleges (`orgs.colleges`) and this file meet on `key`.
 *
 * What is here is what the colleges publish, summed up; nothing speaks for a
 * college. A rule no current public page states is left out (null), not
 * guessed. Crests are the colleges' own (Joshua's decision, 7 Nov 2026, ENG-120),
 * from the University's Development and Alumni Relations pages.
 */

export type CollegeFormal = {
  /** `YYYY-MM-DD`: when every statement below was last checked. */
  checkedOn: string
  /** One sentence: whether a student from another college can go, and how. */
  visitors: string
  /** At most 60 characters: the documented route for a visitor. */
  bookingSummary: string
  /** At most 160 characters: the main constraint. */
  rulesSummary: string
  formalNights: string | null
  guests: string | null
  booking: string | null
  dress: string | null
  price: string | null
  /** Light markdown with inline links (lib/rich-text.ts). */
  note: string
  primarySourceUrl: string
  sourceUrls: string[]
  /**
   * The regular formal nights (ENG-272), re-checked against the colleges',
   * JCRs' and MCRs' own pages and, where a college publishes no weekdays,
   * secondary sources (student guides, menus, archived listings) on
   * `nightsCheckedOn`. Each night says how often it runs (`frequency`); Super
   * Halls and once-a-term dinners stay in the text above.
   */
  nights: FormalNight[]
  /** `found`: the nights are established from the sources below (every
   * college since 19 Nov 2026). */
  nightsStatus: NightsStatus
  /** The source's own words the nights rest on. */
  nightsQuote: string
  /** Details around the nights still not published (a guest cap, a price). */
  nightsGaps: string[]
  /** A page that disagrees, and why it was not used; null when none. */
  nightsConflict: string | null
  nightsSourceUrls: string[]
  /** The sources the nights rest on, with who published them and when, for a
   * college whose nights needed secondary sources; empty otherwise. */
  nightsSources: NightsSource[]
  /** `YYYY-MM-DD`: when the nights, visitor route and price were checked. */
  nightsCheckedOn: string
  /** `as_guest`: a visitor goes as a member's guest; `unknown`: not published. */
  visitorRoute: VisitorRoute
  /** Short: guest limits and how a host books, as published. */
  guestNote: string
  /** The published student and guest price in pounds; null when none is. */
  priceGbp: FormalPrice | null
  bookingDeadline: string | null
}

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const
export type Weekday = (typeof WEEKDAYS)[number]

export const FORMAL_KINDS = ["formal", "grad_formal", "other"] as const
export type FormalKind = (typeof FORMAL_KINDS)[number]

export const FORMAL_AUDIENCES = ["all_members", "jcr", "mcr"] as const
export type FormalAudience = (typeof FORMAL_AUDIENCES)[number]

export const NIGHTS_STATUSES = ["found"] as const
export type NightsStatus = (typeof NIGHTS_STATUSES)[number]

export const NIGHT_CONFIDENCES = ["found"] as const
export type NightConfidence = (typeof NIGHT_CONFIDENCES)[number]

/** How often a night runs in term: every week, every other week, the first
 * of its weekday in each month, or only some weeks (a Super Hall or themed
 * dinner takes its place on the others). */
export const NIGHT_FREQUENCIES = ["weekly", "fortnightly", "first_of_month", "some_weeks"] as const
export type NightFrequency = (typeof NIGHT_FREQUENCIES)[number]

export const NIGHT_SOURCE_KINDS = [
  "official",
  "jcr_mcr",
  "archive",
  "guide",
  "student_press",
  "other",
] as const
export type NightSourceKind = (typeof NIGHT_SOURCE_KINDS)[number]

export type NightsSource = {
  url: string
  /** Who published it ("Christ's JCR, Freshers' Guide 2024"). */
  publisher: string
  /** The date the source gives or was read, in its own words. */
  date: string
  kind: NightSourceKind
}

export const VISITOR_ROUTES = ["as_guest", "unknown"] as const
export type VisitorRoute = (typeof VISITOR_ROUTES)[number]

export type FormalNight = {
  weekday: Weekday
  kind: FormalKind
  /** The college's own name for it ("Formal Hall", "MCR Grad Hall"). */
  label: string
  /** `HH:MM` London time, or null when no page gives it. */
  startTime: string | null
  /** Term (or Full Term) only, per the source. */
  termOnly: boolean
  /** Who may book it: every member, undergraduates (JCR) or graduates (MCR). */
  audience: FormalAudience
  /** How often it runs in term. */
  frequency: NightFrequency
  /** `found`: established from the college's sources. */
  confidence: NightConfidence
  notes: string | null
  /** This night's own published price, when it differs from the college's
   * regular formal (a graduate hall); absent when none is recorded. */
  price?: FormalPrice | null
}

export type FormalPrice = {
  student: number | null
  guest: number | null
  /** The year or date the source gives the price for, or null (undated). */
  asOf: string | null
  sourceUrl: string | null
  note: string | null
  /** A short qualifier shown beside the price where it changes what the
   * figure means ("with wine", "first guest"); absent when none is needed. */
  caveat?: string | null
}

export type CollegeCrest = {
  /** Site path of the crest image (WebP, about 192 px tall). */
  src: string
  alt: string
  sourceImageUrl: string
  sourcePageUrl: string
}

export type CollegeInfo = {
  key: string
  slug: string
  /** The official name, as the directory has it ("Christ's College"). */
  name: string
  /** The short name students use ("Christ's"). */
  shortName: string
  crest: CollegeCrest
  formal: CollegeFormal
}

export const COLLEGES_PATH = "/colleges"

export const CREST_CREDIT =
  "College crests from the University of Cambridge Development and Alumni Relations; they belong to their colleges."
export const CREST_CREDIT_URL = "https://www.philanthropy.cam.ac.uk/careers/collegiate-cambridge"

function oneOf<T extends string>(values: readonly T[], value: string, what: string): T {
  if (!(values as readonly string[]).includes(value)) {
    throw new Error(`lib/data/colleges.json: unknown ${what} "${value}"`)
  }
  return value as T
}

type RawCollege = (typeof data.colleges)[number]
type RawNight = Omit<FormalNight, "weekday" | "kind" | "audience" | "frequency" | "confidence"> & {
  weekday: string
  kind: string
  audience: string
  frequency: string
  confidence: string
}
type RawSource = Omit<NightsSource, "kind"> & { kind: string }

/** The JSON's string fields narrowed to their vocabularies, failing loudly on
 * a value outside them (JSON imports type every string as `string`). */
function toCollege(raw: RawCollege): CollegeInfo {
  const { formal } = raw
  const nights: RawNight[] = formal.nights
  const sources: RawSource[] = formal.nightsSources
  return {
    ...raw,
    formal: {
      ...formal,
      nights: nights.map((night) => ({
        ...night,
        weekday: oneOf(WEEKDAYS, night.weekday, "weekday"),
        kind: oneOf(FORMAL_KINDS, night.kind, "formal kind"),
        audience: oneOf(FORMAL_AUDIENCES, night.audience, "audience"),
        frequency: oneOf(NIGHT_FREQUENCIES, night.frequency, "night frequency"),
        confidence: oneOf(NIGHT_CONFIDENCES, night.confidence, "night confidence"),
      })),
      nightsSources: sources.map((source) => ({
        ...source,
        kind: oneOf(NIGHT_SOURCE_KINDS, source.kind, "night source kind"),
      })),
      nightsStatus: oneOf(NIGHTS_STATUSES, formal.nightsStatus, "nights status"),
      visitorRoute: oneOf(VISITOR_ROUTES, formal.visitorRoute, "visitor route"),
    },
  }
}

export const COLLEGE_INFO: readonly CollegeInfo[] = data.colleges.map(toCollege)
/** The day the formal hall rules were last checked, across all colleges. */
export const FORMALS_CHECKED_ON: string = data.checkedOn
/** The day the formal nights, visitor routes and prices were re-checked
 * (ENG-272); the text rules keep `FORMALS_CHECKED_ON`. */
export const FORMAL_NIGHTS_CHECKED_ON: string = data.nightsCheckedOn

const BY_KEY = new Map(COLLEGE_INFO.map((college) => [college.key, college]))

/** A college's crest and formal rules by its organisation key. */
export function collegeInfo(key: string): CollegeInfo | undefined {
  return BY_KEY.get(key)
}

export { FORMAL_ANCHOR } from "@/lib/college-anchors"

/** What a client component needs to draw a college: no formal hall text,
 * so the browser never receives lib/data/colleges.json (`collegeRefs`). */
export type CollegeRef = Pick<CollegeInfo, "key" | "slug" | "name" | "shortName" | "crest">

/** The 31 colleges as `CollegeRef`s, for a server page to hand to a client
 * organism (the formal tracker). */
export function collegeRefs(): CollegeRef[] {
  return COLLEGE_INFO.map(({ key, slug, name, shortName, crest }) => ({
    key,
    slug,
    name,
    shortName,
    crest,
  }))
}
