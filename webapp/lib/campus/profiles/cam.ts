import { REGISTRATION_BODIES } from "../../vocab"
import type { CampusProfile } from "../profile"

/**
 * Cambridge, the live campus. Every value is today's literal from the module
 * that used to hold it, and stays byte-identical (decision D8): changing one
 * here changes the live site. `facts` deep-equals the `cam` entry of
 * `campuses.fixtures.json` (campus.test.ts).
 */
export const CAMBRIDGE: CampusProfile = {
  id: "cam",
  facts: {
    name: "University of Cambridge",
    site: "https://camsocs.uk",
    universityDomains: ["cam.ac.uk"],
    terms: {
      order: ["michaelmas", "lent", "easter"],
      codes: { michaelmas: "MT", lent: "LT", easter: "ET" },
      weekStartPy: 3,
      weekStartJs: 4,
      minWeek: 0,
      maxWeek: 10,
      labelFormat: "{code}{yy} Wk {week}",
    },
    memberEmail: {
      domains: ["cam.ac.uk"],
      excluded: ["lists.cam.ac.uk"],
      idPattern: "^[a-z]{2,5}[0-9]{1,5}$",
      forwarding: ["srcf.net", "srcf.ucam.org", "cantab.ac.uk", "cantab.net"],
      alumni: ["cantab.ac.uk", "cantab.net", "oxon.org"],
      strictForeignAcademic: false,
    },
    officialEventSources: ["uni_events_api"],
  },
  brand: {
    name: "CAMsocs",
    wordmark: { lead: "CAM", rest: "socs" },
    tagline: "Cambridge societies, events and talks, sourced",
    description:
      "Cambridge student societies, sports clubs and their events, plus public academic talks, in one place. Every fact links to its source. Unofficial.",
    intro:
      "CAMsocs is an unofficial, independent directory of Cambridge student societies and clubs, their events, and public academic talks.",
    shareHeadline: ["Everything on in", "Cambridge, in one place."],
    shareAlt:
      "CAMsocs: Everything on in Cambridge, in one place. Events, talks and societies. Unofficial.",
    footerLine: "Unofficial · every fact sourced",
    llmsSummary:
      "Cambridge student societies and sports clubs and the events they run, in one place. Every fact links to the page it came from.",
    disclaimer:
      "CAMsocs is an independent, unofficial project. It is not affiliated with, endorsed by or run by the University of Cambridge, any of its colleges or Cambridge SU.",
    emailDisclaimer:
      "CAMsocs is an unofficial directory of Cambridge student societies. It is not affiliated with the University of Cambridge or Cambridge SU.",
  },
  origin: "https://camsocs.uk",
  icsUidDomain: "camsocs.uk",
  botUserAgent: "camsocs-bot/0.1 (+https://camsocs.uk/about)",
  contactEmail: "privacy@camsocs.uk",
  university: {
    name: "University of Cambridge",
    url: "https://www.cam.ac.uk",
    studentUnion: "Cambridge SU",
  },
  place: {
    name: "Cambridge",
    addressLocality: "Cambridge",
    addressRegion: "Cambridgeshire",
    country: "GB",
    timeZone: "Europe/London",
    mapsSuffix: ", Cambridge",
  },
  memberTier: {
    label: "Cambridge email",
    placeholder: "crsid@cam.ac.uk",
    tierLabel: "Cambridge-only",
    idName: "CRSid",
    loginSystem: "Raven",
    signInHref: "/sign-in?cam=1",
    rejectMessage: "Use your @cam.ac.uk address",
  },
  terms: {
    names: { michaelmas: "Michaelmas", lent: "Lent", easter: "Easter" },
    short: { michaelmas: "Mich", lent: "Lent", easter: "Easter" },
    teachingWeeks: 8,
  },
  collegiate: { enabled: true },
  pillars: { societies: true, events: true, talks: true },
  // Camdram keeps every society that ever put on a show (ENG-36), so a
  // Camdram listing is no current registration (convex/lib/derived.ts).
  currentYearRegisters: REGISTRATION_BODIES.filter((body) => body !== "camdram"),
  nameStopwords: [
    "a",
    "and",
    "association",
    "cambridge",
    "club",
    "college",
    "cu",
    "for",
    "group",
    "in",
    "of",
    "society",
    "soc",
    "student",
    "students",
    "team",
    "the",
    "uni",
    "university",
  ],
  // In `classifyEmail`'s order; `lists_cam` comes from `memberEmail.excluded`.
  emailDomainTypes: [
    {
      type: "legacy_cusu",
      matches: (domain) => /(^|\.)cusu\./.test(domain) || domain === "cusu.org",
    },
    {
      type: "cambridgesu",
      matches: (domain) => domain === "cambridgesu.co.uk" || domain.endsWith(".cambridgesu.co.uk"),
    },
    { type: "srcf", matches: (domain) => /(^|\.)srcf\.(net|ucam\.org)$/.test(domain) },
  ],
}
