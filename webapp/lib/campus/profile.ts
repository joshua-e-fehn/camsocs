import type { EmailType, RegistrationBody } from "../vocab"

/**
 * The shape of a campus (decision D8, docs/campuses/README.md): one
 * university as a tenant, served by its own Convex deployment and Vercel
 * project. Pure types, no React and no server imports, so Convex
 * (`convex/lib/*`) and Next can both import this folder. Convex reads it as
 * TS only (its tsconfig has no `resolveJsonModule`): the JSON fixture is read
 * by tests alone.
 *
 * Tenancy crosses the three pillars (Societies, Events, Talks) and never
 * merges them.
 */

/** A campus's term model (`campuses.fixtures.json` `terms`). */
export type TermModel = {
  /** Term names in academic-year order. */
  order: readonly string[]
  /** The code a week label starts with, per term ("MT"). */
  codes: Readonly<Record<string, string>>
  /** Python `weekday()` of the day a student week starts (3 = Thursday). */
  weekStartPy: number
  /** JS `getUTCDay()` of the same day (4 = Thursday, 0 = Sunday). */
  weekStartJs: number
  minWeek: number
  maxWeek: number
  /** `{code}`, `{yy}` (two-digit year of the term's start) and `{week}`. */
  labelFormat: string
}

/** Which addresses belong to the campus's members
 * (`campuses.fixtures.json` `memberEmail`). */
export type MemberEmailFacts = {
  /** The members' mail domains. The sign-in tier takes exactly these; the
   * personal-address rule always takes their subdomains too, as the
   * pipeline's `_is_member_domain` does (no campus may narrow it: a narrower
   * rule would show members' addresses in the public projection). */
  domains: readonly string[]
  /** Hosts under `domains` whose addresses are lists, never a person's. */
  excluded: readonly string[]
  /** A member id local part (Cambridge's CRSid). `null`: the campus has no
   * id-shaped addresses, so a name-shaped local part on its domains is a
   * person's. */
  idPattern: string | null
  /** Domains outside `domains` that give every member an address at their id. */
  forwarding: readonly string[]
  /** Alumni forwarding domains: one graduate per address unless named after a post. */
  alumni: readonly string[]
  /** Whether any unfamiliar `*.ac.uk` address counts as a person's. False for
   * cam (its output stays byte-identical); true for every new campus. */
  strictForeignAcademic: boolean
}

/** One campus's facts, exactly as `webapp/lib/campus/campuses.fixtures.json`
 * (`camsocs.campus-facts/1`) states them; a test holds the two equal. */
export type CampusFacts = {
  /** Present (true) only on the synthetic test campus. */
  synthetic?: boolean
  name: string
  site: string
  universityDomains: readonly string[]
  terms: TermModel
  memberEmail: MemberEmailFacts
  /** Event sources that are the university's own programme (ENG-24). */
  officialEventSources: readonly string[]
}

/** A campus-specific email kind for a domain, checked after the personal
 * and alumni rules and before the generic ones (`classifyEmail`). */
export type EmailDomainRule = {
  type: EmailType
  matches: (domain: string) => boolean
}

export type CampusProfile = {
  /** `^[a-z]{2,8}$`: `cam` (live) or the synthetic `zz`. */
  id: string
  facts: CampusFacts
  brand: {
    /** The product name ("CAMsocs"). */
    name: string
    /** How the wordmark splits the name: "CAM" + "socs". */
    wordmark: { lead: string; rest: string }
    tagline: string
    /** The site's meta description (≤ 155 characters). */
    description: string
    /** The home hero's first sentence. */
    intro: string
    /** The generic share card's two headline lines. */
    shareHeadline: readonly [string, string]
    shareAlt: string
    /** The share card's foot line. */
    footerLine: string
    /** `/llms.txt`'s own summary (no talks pillar, owner decision G1). */
    llmsSummary: string
    /** The one-line non-affiliation statement (footer, About). */
    disclaimer: string
    /** The sign-in email's closing line. */
    emailDisclaimer: string
  }
  /** The public origin's fallback (`NEXT_PUBLIC_SITE_URL` overrides it). */
  origin: string
  /** The domain of every ICS UID (`<key>@<domain>`). */
  icsUidDomain: string
  botUserAgent: string
  contactEmail: string
  university: { name: string; url: string; studentUnion: string }
  place: {
    name: string
    addressLocality: string
    addressRegion: string
    country: string
    timeZone: string
    /** Appended to a venue for a maps search (", Cambridge"). */
    mapsSuffix: string
  }
  /** The members-only tier (`cam_only`: members of this deployment's campus). */
  memberTier: {
    label: string
    placeholder: string
    tierLabel: string
    idName: string
    loginSystem: string
    signInHref: string
    /** The server's refusal of an address outside the tier. */
    rejectMessage: string
  }
  terms: {
    names: Readonly<Record<string, string>>
    short: Readonly<Record<string, string>>
    teachingWeeks: number
  }
  collegiate: { enabled: boolean }
  pillars: { societies: boolean; events: boolean; talks: boolean }
  /** Registers that list only the current year's groups (`deriveOrgStatus`). */
  currentYearRegisters: readonly RegistrationBody[]
  /** Words that say nothing about what a group does (related listings). */
  nameStopwords: readonly string[]
  /** Campus-specific email kinds by domain, in order (`classifyEmail`). */
  emailDomainTypes: readonly EmailDomainRule[]
}
