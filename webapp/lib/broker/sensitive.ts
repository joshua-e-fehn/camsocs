import { AUDIENCE_LABELS, type Audience, CATEGORY_LABELS, type Category } from "../vocab"

/**
 * Societies whose officers' names can reveal special category data (Art 9):
 * being listed as an officer of a faith, political, LGBTQ+ or ethnic,
 * national, health or disability identity society says something about a
 * person's belief, opinion, sexuality, origin or health (DPIA-lite §5, R-7;
 * decided by Joshua 2026-11-03, ENG-42). Their officers are kept in the CRM
 * under Art 9(2)(e) only as the society's own pages list them, so the broker
 * dashboard limits what a manual entry or edit may hold
 * (convex/broker/people.ts).
 *
 * The set is the taxonomy's, not a guess per society: the four categories
 * that cover faith, politics, cultural or national identity and identity,
 * health or disability, and the LGBTQ+ audience. It errs wide (an interfaith
 * or a debating society is in it), which only costs the CRM some notes.
 * No server imports, so the dashboard reads the same rules.
 */
export const SENSITIVE_CATEGORIES = [
  "faith",
  "politics_debate",
  "cultural_international",
  "identity_wellbeing",
] as const satisfies readonly Category[]

export const SENSITIVE_AUDIENCES = ["lgbtq"] as const satisfies readonly Audience[]

const CATEGORIES: ReadonlySet<string> = new Set(SENSITIVE_CATEGORIES)
const AUDIENCES: ReadonlySet<string> = new Set(SENSITIVE_AUDIENCES)

export type Classified = { categories: readonly string[]; audiences: readonly string[] }

/** What makes `org` a sensitive society ("Faith & Belief", "LGBTQ+"), in
 * taxonomy order, or an empty list when nothing does. */
export function sensitiveBecause(org: Classified): string[] {
  return [
    ...org.categories
      .filter((category) => CATEGORIES.has(category))
      .map((category) => CATEGORY_LABELS[category as Category]),
    ...org.audiences
      .filter((audience) => AUDIENCES.has(audience))
      .map((audience) => AUDIENCE_LABELS[audience as Audience]),
  ]
}

export function isSensitiveSociety(org: Classified): boolean {
  return sensitiveBecause(org).length > 0
}

function httpUrl(value: string): URL | null {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:" ? url : null
  } catch {
    return null
  }
}

const bareHost = (url: URL) => url.hostname.toLowerCase().replace(/^www\./, "")

/**
 * Whether `url` is a page of the society's own website (`website`, its
 * recorded `website` field): the same host, `www.` aside, and, when the site
 * is a folder on a shared host (a college's site, a Google Site, an SRCF
 * WordPress), a page inside that folder. Another society's page on the same
 * shared host, a profile elsewhere and a missing website are all "no". Every
 * officer the pipeline stored for these societies passes (dev, 2026-11-04:
 * 892 of 892), since it takes them only from the society's own site.
 */
export function isOwnSocietyPage(url: string, website: string | undefined): boolean {
  const page = httpUrl(url)
  const site = website ? httpUrl(website) : null
  if (!page || !site || bareHost(page) !== bareHost(site)) return false
  let folder = site.pathname
  // A site recorded by its start file (`/club/index.html`) is its folder.
  if (folder.slice(folder.lastIndexOf("/") + 1).includes(".")) {
    folder = folder.slice(0, folder.lastIndexOf("/") + 1)
  }
  const prefix = folder.endsWith("/") ? folder : `${folder}/`
  // `/gsb` itself, or anything under `/gsb/`.
  return `${page.pathname}/`.startsWith(prefix)
}

/** A sensitive society as the rules need it: its name, recorded website and
 * what makes it sensitive (`sensitiveBecause`). */
export type SensitiveSociety = { name: string; website?: string; because: readonly string[] }

/** The parts of a person, as they would be stored, that the rules read. */
export type OfficerDraft = {
  sourceUrl: string
  staleAfter: string
  consentBasis: string
  consentRecord?: unknown
  publicLinks: readonly unknown[]
  notes?: string
}

/**
 * Why `draft` may not be kept as an officer of `society`, or null (DPIA-lite
 * §5, ENG-42). Shared by the server's refusal (convex/broker/people.ts) and
 * the dashboard's form, so both say the same thing. `limit`: the latest
 * `staleAfter` R5 allows (the next 30 June); `previousStaleAfter`: the row's
 * date before an edit, which may not move later.
 */
export function sensitiveOfficerProblem(
  society: SensitiveSociety,
  draft: OfficerDraft,
  limit: string,
  previousStaleAfter?: string,
): string | null {
  if (society.because.length === 0) return null
  const why = `${society.name} is a sensitive society (${society.because.join(", ")}): its officers are kept only as its own website lists them (DPIA-lite §5).`
  if (!isOwnSocietyPage(draft.sourceUrl, society.website)) {
    const site = society.website ? httpUrl(society.website) : null
    return site
      ? `${why} Give the page of ${site.hostname} that lists them as the source.`
      : `${why} It has no website on record, so no officer can be added by hand.`
  }
  if (draft.publicLinks.length > 0) return `${why} Remove the profile links.`
  if (draft.notes) return `${why} Remove the notes: only the name and role are kept.`
  if (draft.staleAfter > limit) {
    return `${why} The stale-after date may be no later than ${limit} (the next handover).`
  }
  if (previousStaleAfter !== undefined && draft.staleAfter > previousStaleAfter) {
    return `${why} The stale-after date cannot be moved later.`
  }
  if (draft.consentBasis === "consent" && !draft.consentRecord) {
    return `${why} Hold them on consent only with their explicit consent recorded.`
  }
  return null
}
