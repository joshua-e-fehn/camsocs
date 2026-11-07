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

export const COLLEGE_INFO: readonly CollegeInfo[] = data.colleges
/** The day the formal hall rules were last checked, across all colleges. */
export const FORMALS_CHECKED_ON: string = data.checkedOn

const BY_KEY = new Map(COLLEGE_INFO.map((college) => [college.key, college]))

/** A college's crest and formal rules by its organisation key. */
export function collegeInfo(key: string): CollegeInfo | undefined {
  return BY_KEY.get(key)
}

/** The anchor of a college page's formal hall section. */
export const FORMAL_ANCHOR = "formal-hall"
