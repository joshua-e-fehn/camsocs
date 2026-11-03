import { dayName, formatInstantDate } from "./calendar"
import { categoryHubPath, listWords } from "./directory-hubs"
import { fitTitle, MAX_TITLE } from "./directory-title"
import { eventHasStructuredData } from "./events"
import type { EventListItem, OrgPublic, SessionPublic } from "./public-api"
import { plainLine, summary } from "./rich-text"
import { displayHost } from "./source-line"
import {
  breadcrumbList,
  eventId,
  organizationId,
  PUBLISHER_ID,
  pageId,
  WEBSITE_ID,
} from "./structured-data"
import { isTalksCamUrl } from "./talks-boundary"
import {
  CATEGORY_LABELS,
  ORGANISATION_FIELD_LABELS,
  type OrganisationField,
  type OrgType,
  SOCIAL_PLATFORM_LABELS,
} from "./vocab"

/**
 * What a society's profile says about itself to search engines and answer
 * engines: its title, its other names, a lead sentence built from its facts,
 * whether it is worth indexing, its sources and its JSON-LD (SEO audit
 * 2026-11-02). Pure functions of the public projection, so every rule is
 * unit-tested and nothing is invented: a fact we do not hold is left out of
 * the sentence, never guessed (AGENTS.md "Data honesty rules").
 */

type Org = Pick<
  OrgPublic,
  | "key"
  | "slug"
  | "name"
  | "aliases"
  | "shortName"
  | "orgType"
  | "level"
  | "collegeKeys"
  | "isCounterpart"
  | "status"
  | "categories"
  | "sport"
  | "shortDescription"
  | "description"
  | "website"
  | "email"
  | "roleEmails"
  | "socials"
  | "mailingList"
  | "joinUrl"
  | "contactFormUrl"
  | "logo"
  | "meta"
  | "updatedAt"
>

const CAMBRIDGE = /\bCambridge\b/
/** A name that would read as the University speaking (AGENTS.md: never as
 * branding). We never build one: no alias or short name of this form becomes
 * a full name or a title. A society registered under such a name keeps it as
 * its title when the sources give no shorter one, since that quotes its own
 * name and implies no University branding (review of the SEO audit 2026-11-02,
 * affiliation-copy). */
const UNIVERSITY_OF_CAMBRIDGE = /\bUniversity of Cambridge\b/i

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/** Whether the listing is a student group in Cambridge (not a sponsor
 * company, a public body or a society at another university), so "in
 * Cambridge" is a fact about it. */
export function isInCambridge(org: Pick<Org, "isCounterpart" | "level" | "orgType">): boolean {
  if (org.orgType === "college") return true
  return (
    !org.isCounterpart && org.level !== "external" && org.orgType !== "other_university_society"
  )
}

/**
 * The society's own published full name, when a source gives one that names
 * Cambridge (owner decision G2): its name if that already does, else an
 * alias such as the Proctors' register's "Cambridge University Chess Club"
 * (pipeline sources/proctors.py), preferring one that contains the name.
 * Never a "University of Cambridge …" form. Undefined when there is none.
 */
export function societyFullName(org: Pick<Org, "name" | "aliases" | "shortName">) {
  const usable = (name: string | undefined): boolean =>
    name !== undefined &&
    CAMBRIDGE.test(name) &&
    !UNIVERSITY_OF_CAMBRIDGE.test(name) &&
    name.length <= 120
  if (usable(org.name)) return org.name
  const candidates = [...org.aliases, org.shortName].filter(
    (name): name is string => name !== undefined && usable(name),
  )
  const core = org.name.toLowerCase()
  return candidates.find((alias) => alias.toLowerCase().includes(core)) ?? candidates[0]
}

/**
 * A profile's `<title>` (G2), never more than `MAX_TITLE` (60)
 * characters, " · CAMsocs" dropped first (`fitTitle`). The first that fits:
 *  1. the full name (`societyFullName`);
 *  2. "<Name>, Cambridge" for a group in Cambridge (the name alone when it
 *     names Cambridge, or the group is elsewhere);
 *  3. a shorter name the sources give (short name, alias), the longest
 *     first: one naming Cambridge as is, else as "<Short>, Cambridge" for a
 *     group in Cambridge — so a long name keeps "Cambridge" where it can;
 *  4. the name alone;
 *  5. the name cut at a word with "…", then ", Cambridge" for a group in
 *     Cambridge.
 * Never a "University of Cambridge …" form of our making (AGENTS.md): a
 * society whose own registered name is one keeps it, as is or cut at a
 * word, when no shorter name is given (step 2 is skipped for it, so it never
 * gains ", Cambridge"); that title leads with "University of Cambridge"
 * because the society does (affiliation-copy). Review of the SEO audit
 * (title-length-overflow-minor): a name longer than 60 characters used to
 * be kept whole.
 */
export function societyTitle(org: Org): string | { absolute: string } {
  const local = isInCambridge(org)
  const placed = (name: string) => (CAMBRIDGE.test(name) || !local ? name : `${name}, Cambridge`)
  const fits = (title: string) => title.length <= MAX_TITLE
  const shorter = [org.shortName, ...org.aliases]
    .map((name) => name?.replace(/\s+/g, " ").trim())
    .filter(
      (name): name is string =>
        !!name && name.length >= 2 && !same(name, org.name) && !UNIVERSITY_OF_CAMBRIDGE.test(name),
    )
    .sort((a, b) => b.length - a.length)
  const own = UNIVERSITY_OF_CAMBRIDGE.test(org.name) ? undefined : placed(org.name)
  const candidates = [societyFullName(org), own, ...shorter.map(placed), org.name]
  const title = candidates.find((candidate) => candidate !== undefined && fits(candidate))
  if (title) return fitTitle(title)
  const suffix = CAMBRIDGE.test(org.name) || !local ? "" : ", Cambridge"
  return fitTitle(`${clipAtWord(org.name, MAX_TITLE - suffix.length)}${suffix}`)
}

/** `text` cut at a word to at most `max` characters, ending in "…". */
function clipAtWord(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim()
  if (line.length <= max) return line
  const cut = line.slice(0, max - 1)
  const space = cut.lastIndexOf(" ")
  return `${(space > max * 0.5 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, "")}…`
}

/** Other names for the listing, each once and never the name itself
 * (entity-aliases-missing): the full name first, then the short name and
 * aliases. For the "Also known as" line and JSON-LD `alternateName`. */
export function alternateNames(org: Pick<Org, "name" | "aliases" | "shortName">): string[] {
  const full = societyFullName(org)
  const out: string[] = []
  for (const name of [full, org.shortName, ...org.aliases]) {
    if (!name?.trim() || same(name, org.name) || out.some((seen) => same(seen, name))) continue
    out.push(name.trim())
  }
  return out
}

// --- the lead ----------------------------------------------------------------------------

const article = (word: string) =>
  /^(?:[aeio]|u(?!ni|se|s[aeiu])|MCR|NGO)/i.test(word) ? "an" : "a"

const LEVEL_WORDS: Partial<Record<NonNullable<Org["level"]>, string>> = {
  university: "university-wide",
  intercollegiate: "intercollegiate",
  department: "departmental",
}

/**
 * The bare noun for each kind, for the lead's "is a/an …" (a table of its
 * own, not TYPE_WORDS with the article cut off: "another group" has no
 * article to cut, which gave "an another group"). Typed over every OrgType,
 * so a new type cannot be left out.
 */
export const KIND_NOUNS: Record<OrgType, string> = {
  society: "society",
  sports_club: "sports club",
  college_club: "college club",
  jcr: "JCR",
  mcr: "MCR",
  college_boat_club: "boat club",
  college: "college",
  department: "department",
  uni_office: "University office",
  student_union: "students' union",
  company: "company",
  ngo: "charity",
  public_body: "public body",
  other_university_society: "society at another university",
  media: "student publication",
  theatre_company: "theatre company",
  other: "group",
}

/** Kinds a level word would only repeat or garble ("a university-wide
 * University office", "a departmental department"): an institution, not a
 * student group, so it is named without one. */
const NO_LEVEL_WORD: ReadonlySet<OrgType> = new Set([
  "college",
  "department",
  "uni_office",
  "student_union",
  "company",
  "ngo",
  "public_body",
  "other_university_society",
])

/** "a society", "an MCR": the noun with its article. */
export function withArticle(words: string): string {
  return `${article(words)} ${words}`
}

/** "a university-wide sports club (rowing)", "an MCR at Clare College". */
function kindPhrase(org: Org, collegeNames: Record<string, string>): string {
  const noun = org.orgType ? KIND_NOUNS[org.orgType] : "student group"
  const sport =
    org.sport?.sport && /club|team/.test(noun) ? ` (${org.sport.sport.toLowerCase()})` : ""
  const level =
    org.level && !(org.orgType && NO_LEVEL_WORD.has(org.orgType))
      ? LEVEL_WORDS[org.level]
      : undefined
  const words = [level, noun].filter(Boolean).join(" ")
  const colleges = org.collegeKeys.map((key) => collegeNames[key]).filter(Boolean)
  const at = colleges.length > 0 ? ` at ${listWords(colleges)}` : ""
  return `${withArticle(words)}${sport}${at}`
}

/** "Tuesdays and Thursdays" from sessions' days (0 = Sunday), Monday first. */
function sessionDays(sessions: readonly Pick<SessionPublic, "dayOfWeek">[]): string | undefined {
  const days = [
    ...new Set(sessions.flatMap((s) => (s.dayOfWeek === undefined ? [] : [s.dayOfWeek]))),
  ]
    .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
    .map((day) => `${dayName(day)}s`)
    .filter((day) => day !== "s")
  return days.length > 0 ? listWords(days) : undefined
}

/** The ways to reach the listing we hold, as words: "email or Instagram". */
function channels(org: Org): string[] {
  const out: string[] = []
  if (org.website) out.push("its website")
  if (org.email || org.roleEmails.length > 0) out.push("email")
  const platforms = [...new Set(org.socials.map((social) => social.platform))]
  for (const platform of platforms.slice(0, 2)) out.push(SOCIAL_PLATFORM_LABELS[platform])
  if (org.mailingList?.signupUrl) out.push("a mailing list")
  return out
}

export type ProfileLead = {
  /** One or two sentences under the H1. */
  lead: string
  /** The meta and JSON-LD description: the lead, or its first sentence,
   * within 160 characters. */
  description: string
}

/**
 * A listing's lead, generated from its structured facts only — never a model,
 * never the source's prose (unique-lead-text): the society's own text is
 * shared word for word with its SU page, so the snippet engines quote should
 * be what CAMsocs adds — the kind of group, its college, its categories, when
 * it meets, how many events are coming up and how to reach it.
 */
export function profileLead({
  org,
  collegeNames,
  sessions,
  upcomingEvents,
}: {
  org: Org
  collegeNames: Record<string, string>
  sessions: readonly Pick<SessionPublic, "dayOfWeek">[]
  upcomingEvents: number
}): ProfileLead {
  const name = societyFullName(org) ?? org.name
  const categories = org.categories.slice(0, 2).map((category) => CATEGORY_LABELS[category])
  let first: string
  if (org.isCounterpart && org.orgType !== "college") {
    first = `${name} is ${withArticle(org.orgType ? KIND_NOUNS[org.orgType] : "organisation")} that Cambridge student societies name as a sponsor, host or partner.`
  } else {
    const place = isInCambridge(org) && !org.collegeKeys.length ? " in Cambridge" : ""
    const town = org.collegeKeys.length > 0 && isInCambridge(org) ? ", Cambridge" : ""
    const listed = categories.length > 0 ? `, listed under ${listWords(categories)}` : ""
    first = `${name} is ${kindPhrase(org, collegeNames)}${town}${place}${listed}.`
  }
  const facts: string[] = []
  if (org.status === "archived") {
    facts.push("A source lists it as no longer active.")
  } else {
    const parts: string[] = []
    const days = sessionDays(sessions)
    if (days) parts.push(`meets on ${days}`)
    else if (sessions.length > 0)
      parts.push(
        `lists ${sessions.length === 1 ? "a regular session" : `${sessions.length} regular sessions`}`,
      )
    if (upcomingEvents > 0) {
      parts.push(
        `has ${upcomingEvents === 1 ? "1 upcoming event" : `${upcomingEvents} upcoming events`} listed`,
      )
    }
    const ways = channels(org)
    if (ways.length > 0) parts.push(`can be reached through ${listWords(ways, "or")}`)
    if (parts.length > 0) facts.push(`It ${listWords(parts)}.`)
  }
  const lead = [first, ...facts].join(" ")
  const description = lead.length <= 160 ? lead : first.length <= 160 ? first : summary(first, 160)
  return { lead, description }
}

// --- indexing ----------------------------------------------------------------------------

export { isThinProfile } from "./directory-indexing"

// --- provenance --------------------------------------------------------------------------

export type ProfileSource = {
  url: string
  host: string
  /** The facts it backs, as their labels. */
  fields: string[]
  /** When it was last read (epoch ms). */
  retrievedAt?: number
}

/**
 * The public pages the listing's facts came from, each once with the facts
 * it backs and when it was read, most-used first (provenance-not-crawlable):
 * "every fact links to the page it came from" (lib/site.ts) as plain links
 * in the HTML, not only inside the client-side Sourced popovers. Internal
 * sources (no URL) and talks.cam (G1) are left out.
 */
export function profileSources(meta: Org["meta"], limit = 12): ProfileSource[] {
  const bySource = new Map<string, ProfileSource>()
  for (const [field, entry] of Object.entries(meta)) {
    if (!entry.sourceUrl || entry.status === "missing" || entry.status === "not_applicable") {
      continue
    }
    const host = displayHost(entry.sourceUrl)
    if (!host || isTalksCamUrl(entry.sourceUrl)) continue
    const label = ORGANISATION_FIELD_LABELS[field as OrganisationField] ?? field
    const source = bySource.get(entry.sourceUrl) ?? { url: entry.sourceUrl, host, fields: [] }
    if (!source.fields.includes(label)) source.fields.push(label)
    if (entry.retrievedAt !== undefined) {
      source.retrievedAt = Math.max(source.retrievedAt ?? 0, entry.retrievedAt)
    }
    bySource.set(entry.sourceUrl, source)
  }
  return [...bySource.values()]
    .sort((a, b) => b.fields.length - a.fields.length || a.host.localeCompare(b.host))
    .slice(0, limit)
}

/** Where the About text came from, for the line under it: "From the
 * society's Cambridge SU profile" (unique-lead-text: the text is theirs, said
 * so in the HTML). Undefined without a public URL. */
export function descriptionAttribution(
  meta: Org["meta"],
): { url: string; label: string; own: boolean; retrievedOn?: string } | undefined {
  const entry = meta.description
  if (!entry?.sourceUrl || isTalksCamUrl(entry.sourceUrl)) return undefined
  const host = displayHost(entry.sourceUrl)
  if (!host) return undefined
  const su = entry.sourceType === "su_profile" || entry.sourceType === "su_directory"
  const own = su || entry.sourceType === "society_website"
  const label = su
    ? "the society’s Cambridge SU profile"
    : entry.sourceType === "society_website"
      ? `the society’s website (${host})`
      : host
  return {
    url: entry.sourceUrl,
    label,
    own,
    retrievedOn: entry.retrievedAt === undefined ? undefined : formatInstantDate(entry.retrievedAt),
  }
}

// --- JSON-LD -----------------------------------------------------------------------------

/** schema.org type by org type (org-jsonld-thin). Never CollegeOrUniversity
 * or EducationalOrganization: CAMsocs lists student groups, and those types
 * would describe them as the institution. */
export function schemaType(orgType: Org["orgType"]): string {
  switch (orgType) {
    case "sports_club":
    case "college_boat_club":
      return "SportsOrganization"
    case "theatre_company":
      return "TheaterGroup"
    case "ngo":
      return "NGO"
    default:
      return "Organization"
  }
}

const CAMBRIDGE_PLACE = {
  "@type": "Place",
  name: "Cambridge",
  address: { "@type": "PostalAddress", addressLocality: "Cambridge", addressCountry: "GB" },
}

/** The upcoming events a profile's JSON-LD links to by `@id`: exactly those
 * whose own page has the Event node (`eventHasStructuredData`: public,
 * confirmed, a start time read rather than inferred, no "TBC" in the title,
 * never talks.cam-derived), so no reference dangles (review of the SEO
 * audit, profile-jsonld-dangling-event-ids). getBySlug leaves talks.cam-
 * derived events out already; this is the second pass. */
export function jsonLdEvents(events: readonly EventListItem[], limit = 20): string[] {
  return events
    .filter(eventHasStructuredData)
    .slice(0, limit)
    .map((event) => event.key)
}

/**
 * A profile's JSON-LD (org-jsonld-thin, jsonld-graph-breadcrumbs): one
 * `@graph` of the ProfilePage, the Organization it is about and its
 * BreadcrumbList, joined to the site's WebSite and publisher by `@id`
 * (lib/structured-data.ts). Public facts only: the projected general address
 * (never a personal one), no person, no registration as `memberOf` (that
 * would read as an affiliation).
 */
export function societyJsonLd({
  org,
  title,
  description,
  eventKeys,
}: {
  org: Org
  /** The page title as shown (without " · CAMsocs"). */
  title: string
  description: string
  eventKeys: string[]
}): Record<string, unknown> {
  const path = `/societies/${org.slug}`
  const orgId = organizationId(org.slug)
  const category = org.categories[0]
  const alternate = alternateNames(org)
  const contactUrl = org.joinUrl ?? org.contactFormUrl
  const type = schemaType(org.orgType)
  const organization: Record<string, unknown> = {
    "@type": type,
    "@id": orgId,
    name: org.name,
    alternateName: alternate.length > 0 ? alternate : undefined,
    description,
    url: org.website,
    logo: org.logo?.url,
    email: org.email,
    sameAs: org.socials.length > 0 ? org.socials.map((social) => social.url) : undefined,
    contactPoint: contactUrl
      ? { "@type": "ContactPoint", contactType: "membership", url: contactUrl }
      : undefined,
    sport: type === "SportsOrganization" ? org.sport?.sport : undefined,
    location: isInCambridge(org) ? CAMBRIDGE_PLACE : undefined,
    keywords:
      org.categories.length > 0
        ? org.categories.map((item) => CATEGORY_LABELS[item]).join(", ")
        : undefined,
    event: eventKeys.length > 0 ? eventKeys.map((key) => ({ "@id": eventId(key) })) : undefined,
  }
  const crumbs = [
    { name: "Societies", path: "/societies" },
    ...(category ? [{ name: CATEGORY_LABELS[category], path: categoryHubPath(category) }] : []),
    { name: org.name, path },
  ]
  const sources = profileSources(org.meta).map((source) => source.url)
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "ProfilePage",
        "@id": pageId(path),
        url: pageId(path),
        name: title,
        isPartOf: { "@id": WEBSITE_ID },
        publisher: { "@id": PUBLISHER_ID },
        mainEntity: { "@id": orgId },
        breadcrumb: { "@id": `${pageId(path)}#breadcrumb` },
        dateModified: new Date(org.updatedAt).toISOString(),
        isBasedOn: sources.length > 0 ? sources : undefined,
      },
      organization,
      breadcrumbList(path, crumbs),
    ].map(withoutUndefined),
  }
}

/** A plain lead line for a hub's list: the listing's short description, one
 * line, or nothing. */
export function cardLine(card: { shortDescription?: string }): string | undefined {
  return card.shortDescription ? summary(plainLine(card.shortDescription), 140) : undefined
}

function withoutUndefined(node: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(node).filter(([, value]) => value !== undefined))
}
