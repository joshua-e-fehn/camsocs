import data from "@/lib/data/guides/postgraduates.json"
import type { GuideSection } from "./guide-content"

/**
 * The postgraduate guide's researched text (ENG-116), from the University's
 * postgraduate pages, Cambridge SU and the colleges (`checkedOn`), and the
 * colleges that take only postgraduates or mature students.
 */

export type GraduateCollege = { collegeKey: string; who: string; detail: string; sources: string[] }

export const POSTGRAD_CHECKED_ON: string = data.checkedOn
export const POSTGRAD_SECTIONS: readonly GuideSection[] = data.sections
export const GRADUATE_COLLEGES: readonly GraduateCollege[] = data.graduateColleges
