import { COLLEGE_INFO, type CollegeInfo } from "./colleges"
import type { GuideSource } from "./guides"

/**
 * The formal hall guide's sources (ENG-112): the general pages its text
 * cites, then each college's own page, as lib/colleges.ts checked them. All
 * read on 7 Nov 2026 (the Tracker's research of 8 Oct, re-checked).
 */

const READ = "2026-11-07"

export const FORMAL_SOURCES = {
  downing: {
    publisher: "Downing College",
    title: "Catering for current students",
    url: "https://www.dow.cam.ac.uk/current-students/catering",
    retrieved: READ,
  },
  darwin: {
    publisher: "Darwin College",
    title: "Formal Hall",
    url: "https://www.darwin.cam.ac.uk/dine/formal-hall/",
    retrieved: READ,
  },
  hughes: {
    publisher: "Hughes Hall",
    title: "Formal Halls",
    url: "https://www.hughes.cam.ac.uk/student-centre/practical/dining/formal-halls/",
    retrieved: READ,
  },
  christsMcr: {
    publisher: "Christ's College MCR",
    title: "Halls",
    url: "https://www.christsmcr.co.uk/halls",
    retrieved: READ,
  },
  lucyMcr: {
    publisher: "Cambridge SU",
    title: "Lucy Cavendish MCR's listing",
    url: "https://www.cambridgesu.co.uk/organisation/20615/",
    retrieved: READ,
  },
  fhn: {
    publisher: "Cambridge SU",
    title: "Formal Hall Networking Society's listing",
    url: "https://www.cambridgesu.co.uk/organisation/formal_networking/",
    retrieved: READ,
  },
  churchill: {
    publisher: "Churchill College",
    title: "Undergraduate Handbook 2025–26",
    url: "https://www.chu.cam.ac.uk/wp-content/uploads/2025/12/Undergraduate-Handbook-2025-26.pdf",
    retrieved: READ,
  },
  kings: {
    publisher: "King's College",
    title: "1441 Foundation Dinner 2026",
    url: "https://www.kings.cam.ac.uk/events/1441-foundation-dinner-2026",
    retrieved: READ,
  },
} as const satisfies Record<string, GuideSource>

/** A college's own page, as a source of the guide's table. */
export function collegeSource(college: CollegeInfo): GuideSource {
  return {
    publisher: college.name,
    title: "Formal hall and dining rules",
    url: college.formal.primarySourceUrl,
    retrieved: college.formal.checkedOn,
  }
}

/** Every source the guide cites, general ones first, without repeats. */
export function formalGuideSources(): GuideSource[] {
  const all = [...Object.values(FORMAL_SOURCES), ...COLLEGE_INFO.map(collegeSource)]
  const seen = new Set<string>()
  return all.filter((source) => !seen.has(source.url) && seen.add(source.url))
}
