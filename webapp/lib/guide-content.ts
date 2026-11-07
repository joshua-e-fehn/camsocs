import type { GuideSource } from "./guides"

/**
 * Researched guide text kept as data (lib/data/guides/*.json): sections of
 * plain paragraphs, each paragraph with the pages it comes from. The pages
 * render it with `GuideSections`, so every paragraph shows its citations and
 * the source list is built from the same URLs. Pure.
 */

export type GuideParagraph = { text: string; sources: string[] }
export type GuideSection = { id: string; title: string; paragraphs: GuideParagraph[] }

/** Who published a page, short, from its host and path (no "www."): shown as
 * the citation. Specific entries first: a college's subdomain of cam.ac.uk
 * is the college, not the University. */
const PUBLISHERS: readonly [RegExp, string][] = [
  [/^sites\.google\.com\/view\/crabumps/, "Cambridgeshire Rowing Association"],
  [/^firstandthird\.org/, "First and Third Trinity BC"],
  [/^ladymargaretboatclub\.org/, "Lady Margaret BC"],
  [/^jesusboatclub\.co\.uk/, "Jesus College BC"],
  [/(^|\.)cucbc\.org$/, "CUCBC"],
  [/(^|\.)cubc\.org\.uk$/, "CUBC"],
  [/(^|\.)theboatrace\.org$/, "The Boat Race"],
  [/(^|\.)cambridgesu\.co\.uk$/, "Cambridge SU"],
  [/(^|\.)sport\.cam\.ac\.uk$/, "University Sport"],
  [/(^|\.)cam\.ac\.uk$/, "University of Cambridge"],
  [/(^|\.)varsitytrip\.com$/, "The Varsity Trip"],
  [/(^|\.)cambridge\.gov\.uk$/, "Cambridge City Council"],
  [/(^|\.)adctheatre\.com$/, "ADC Theatre"],
  [/(^|\.)help\.uis\.cam\.ac\.uk$/, "University IT help"],
  [/(^|\.)proctors\.cam\.ac\.uk$/, "The Proctors"],
  [/(^|\.)reporter\.admin\.cam\.ac\.uk$/, "Cambridge University Reporter"],
  [/(^|\.)cambridgestudents\.cam\.ac\.uk$/, "Cambridgestudents"],
  [/(^|\.)alumni\.cam\.ac\.uk$/, "Cambridge alumni"],
  [/(^|\.)cus\.org$/, "Cambridge Union"],
  [/(^|\.)qmcr\.org$/, "Queens' College MCR"],
  [/(^|\.)varsity\.co\.uk$/, "Varsity"],
  [/(^|\.)wikipedia\.org$/, "Wikipedia"],
  [/(^|\.)cuadc\.org$/, "CUADC"],
  [/(^|\.)cambridgefootlights\.org$/, "Footlights"],
  [/(^|\.)cumts\.co\.uk$/, "CUMTS"],
  [/(^|\.)camdram\.net$/, "Camdram"],
  [/(^|\.)cuetg\.co\.uk$/, "ETG"],
  [/(^|\.)gands\.org\.uk$/, "CUGSS"],
  [/(^|\.)pembrokeplayers\.co\.uk$/, "Pembroke Players"],
  [/(^|\.)postgraduate\.study\.cam\.ac\.uk$/, "University postgraduate admissions"],
  [/(^|\.)undergraduate\.study\.cam\.ac\.uk$/, "University undergraduate admissions"],
  [/(^|\.)thevarsitymatches\.com$/, "The Varsity Matches"],
  [/(^|\.)ourfc\.org$/, "OURFC"],
  [/(^|\.)sport\.site\.ox\.ac\.uk$/, "Oxford University Sport"],
  [/(^|\.)hawksclub\.co\.uk$/, "Hawks' Club"],
  [/(^|\.)ouhc\.co\.uk$/, "OUHC"],
  [/(^|\.)cussc\.co\.uk$/, "CUSSC"],
]

/** The colleges' and the Library's own hosts under cam.ac.uk ("magd" in
 * www.magd.cam.ac.uk, "clare" in ucs.clare.cam.ac.uk). */
const CAM_HOSTS: Record<string, string> = {
  chu: "Churchill College",
  christs: "Christ's College",
  clare: "Clare College",
  clarehall: "Clare Hall",
  corpus: "Corpus Christi College",
  dar: "Darwin College",
  dow: "Downing College",
  emma: "Emmanuel College",
  fitz: "Fitzwilliam College",
  girton: "Girton College",
  cai: "Gonville & Caius College",
  homerton: "Homerton College",
  hughes: "Hughes Hall",
  jesus: "Jesus College",
  kings: "King's College",
  lucy: "Lucy Cavendish College",
  magd: "Magdalene College",
  murrayedwards: "Murray Edwards College",
  newn: "Newnham College",
  pem: "Pembroke College",
  pet: "Peterhouse",
  queens: "Queens' College",
  robinson: "Robinson College",
  sel: "Selwyn College",
  sid: "Sidney Sussex College",
  caths: "St Catharine's College",
  "st-edmunds": "St Edmund's College",
  joh: "St John's College",
  trin: "Trinity College",
  trinhall: "Trinity Hall",
  wolfson: "Wolfson College",
  lib: "Cambridge University Library",
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}

/** The citation label for a URL: a known publisher, else its host. */
export function publisherOf(url: string, names: Record<string, string> = {}): string {
  const h = host(url)
  if (names[h]) return names[h]
  const cam = h.match(/([a-z-]+)\.cam\.ac\.uk$/)?.[1]
  if (cam && CAM_HOSTS[cam]) return CAM_HOSTS[cam]
  const where = url.replace(/^https?:\/\/(www\.)?/, "")
  for (const [pattern, name] of PUBLISHERS) if (pattern.test(h) || pattern.test(where)) return name
  return h
}

/** Every URL a set of sections cites, once each, in reading order, as sources. */
export function sectionSources(
  sections: readonly GuideSection[],
  retrieved: string,
  names: Record<string, string> = {},
  titles: Record<string, string> = {},
): GuideSource[] {
  const urls = [...new Set(sections.flatMap((s) => s.paragraphs.flatMap((p) => p.sources)))]
  return urls.map((url) => ({
    publisher: publisherOf(url, names),
    title: titles[url] ?? host(url) + new URL(url).pathname.replace(/\/$/, ""),
    url,
    retrieved,
  }))
}
