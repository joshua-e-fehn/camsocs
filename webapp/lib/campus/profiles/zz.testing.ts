import type { CampusProfile } from "../profile"

/**
 * "Testford University", the synthetic campus `zz` (decision D8): made up,
 * for tests only, never in `CAMPUS_IDS` or a production registry. The
 * two-dot name keeps it out of every deploy. It exists to prove the seams
 * hold for a campus unlike Cambridge: a Sunday week start, other term names,
 * no id-shaped member addresses and the strict foreign-academic rule.
 * `facts` deep-equals the `zz` entry of `campuses.fixtures.json`.
 */
export const TESTFORD: CampusProfile = {
  id: "zz",
  facts: {
    synthetic: true,
    name: "Testford University",
    site: "https://zz.localhost",
    universityDomains: ["testford.ac.uk"],
    terms: {
      order: ["michaelmas", "hilary", "trinity"],
      codes: { michaelmas: "MT", hilary: "HT", trinity: "TT" },
      weekStartPy: 6,
      weekStartJs: 0,
      minWeek: 0,
      maxWeek: 10,
      labelFormat: "{code}{yy} Wk {week}",
    },
    memberEmail: {
      domains: ["testford.ac.uk"],
      includeSubdomains: true,
      excluded: ["lists.testford.ac.uk"],
      idPattern: null,
      forwarding: [],
      alumni: ["testford-alumni.org"],
      strictForeignAcademic: true,
    },
    officialEventSources: [],
  },
  brand: {
    name: "ZZsocs",
    wordmark: { lead: "ZZ", rest: "socs" },
    tagline: "Testford societies, events and talks, sourced",
    description: "Synthetic Testford societies and events, for tests only.",
    intro: "ZZsocs is a synthetic directory of Testford societies, for tests only.",
    shareHeadline: ["Everything on in", "Testford, in one place."],
    shareAlt: "ZZsocs: Everything on in Testford, in one place. Synthetic.",
    footerLine: "Synthetic · tests only",
    llmsSummary: "Synthetic Testford societies, for tests only.",
    disclaimer: "ZZsocs is synthetic test data. Testford University does not exist.",
    emailDisclaimer: "ZZsocs is synthetic test data.",
  },
  origin: "https://zz.localhost",
  icsUidDomain: "zz.localhost",
  botUserAgent: "camsocs-bot/0.1 (+https://zz.localhost/about)",
  contactEmail: "contact@zz.localhost",
  university: {
    name: "Testford University",
    url: "https://www.testford.ac.uk",
    studentUnion: "Testford SU",
  },
  place: {
    name: "Testford",
    addressLocality: "Testford",
    addressRegion: "Testshire",
    country: "GB",
    timeZone: "Europe/London",
    mapsSuffix: ", Testford",
  },
  memberTier: {
    label: "Testford email",
    placeholder: "name@testford.ac.uk",
    tierLabel: "Testford-only",
    idName: "username",
    loginSystem: "Testford SSO",
    signInHref: "/sign-in?cam=1",
    rejectMessage: "Use your @testford.ac.uk address",
  },
  terms: {
    names: { michaelmas: "Michaelmas", hilary: "Hilary", trinity: "Trinity" },
    short: { michaelmas: "Mich", hilary: "Hilary", trinity: "Trinity" },
    teachingWeeks: 8,
  },
  collegiate: { enabled: false },
  pillars: { societies: true, events: true, talks: false },
  currentYearRegisters: ["su"],
  nameStopwords: ["a", "and", "club", "of", "society", "testford", "the", "university"],
  emailDomainTypes: [],
}
