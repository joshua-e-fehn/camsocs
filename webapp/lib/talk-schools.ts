import type { TalkSchool } from "./vocab"

/**
 * How a University School is marked on the talks pillar (spec §5 "School
 * colours"): its ink on its tint for chips, and a solid rule. Class names are
 * written out whole so Tailwind sees them; the colours are the `--school-*`
 * tokens of app/globals.css (≥ 5.8:1 ink on tint in both themes).
 */

export type SchoolStyle = {
  /** Text in the School's ink: `text-school-arts`. */
  ink: string
  /** The School's tint, for a chip's ground: `bg-school-arts-tint`. */
  tint: string
  /** A solid mark or rule in the School's ink: `bg-school-arts`. */
  rule: string
}

export const SCHOOL_STYLES: Record<TalkSchool, SchoolStyle> = {
  arts_humanities: {
    ink: "text-school-arts",
    tint: "bg-school-arts-tint",
    rule: "bg-school-arts",
  },
  humanities_social_sciences: {
    ink: "text-school-hss",
    tint: "bg-school-hss-tint",
    rule: "bg-school-hss",
  },
  biological_sciences: {
    ink: "text-school-bio",
    tint: "bg-school-bio-tint",
    rule: "bg-school-bio",
  },
  clinical_medicine: {
    ink: "text-school-clinical",
    tint: "bg-school-clinical-tint",
    rule: "bg-school-clinical",
  },
  physical_sciences: {
    ink: "text-school-physical",
    tint: "bg-school-physical-tint",
    rule: "bg-school-physical",
  },
  technology: {
    ink: "text-school-tech",
    tint: "bg-school-tech-tint",
    rule: "bg-school-tech",
  },
  other: {
    ink: "text-school-other",
    tint: "bg-school-other-tint",
    rule: "bg-school-other",
  },
}
