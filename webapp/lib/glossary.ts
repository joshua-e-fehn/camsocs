import data from "@/lib/data/guides/glossary.json"
import type { GuideSection } from "./guide-content"
import { GUIDES_PATH } from "./guides"
import { pageId } from "./structured-data"

/**
 * The Cambridge glossary (ENG-113): words students meet, each defined from an
 * institutional page (the University Library's glossary first), with a link
 * to the CAMsocs page that says more where there is one (`see`).
 */

export type GlossaryTerm = { term: string; text: string; sources: string[]; see: string | null }

export const GLOSSARY_CHECKED_ON: string = data.checkedOn
export const GLOSSARY_INTRO: readonly GuideSection[] = data.sections
export const GLOSSARY: readonly GlossaryTerm[] = [...(data.entries as GlossaryTerm[])].sort(
  (a, b) => a.term.localeCompare(b.term, "en-GB", { sensitivity: "base" }),
)

/** A term's anchor on the page: "Porters' Lodge" → "porters-lodge". */
export function termAnchor(term: string): string {
  return term
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}

/** The terms by first letter, A to Z. */
export function byLetter(terms: readonly GlossaryTerm[] = GLOSSARY): [string, GlossaryTerm[]][] {
  const groups = new Map<string, GlossaryTerm[]>()
  for (const term of terms) {
    const letter = term.term[0].toUpperCase()
    groups.set(letter, [...(groups.get(letter) ?? []), term])
  }
  return [...groups.entries()]
}

/** schema.org DefinedTermSet for the page, so each word can be cited. */
export function glossaryJsonLd(path: string): Record<string, unknown> {
  const url = pageId(path)
  return {
    "@context": "https://schema.org",
    "@type": "DefinedTermSet",
    "@id": `${url}#terms`,
    name: "Cambridge words explained",
    url,
    isPartOf: pageId(GUIDES_PATH),
    hasDefinedTerm: GLOSSARY.map((entry) => ({
      "@type": "DefinedTerm",
      name: entry.term,
      description: entry.text,
      url: `${url}#${termAnchor(entry.term)}`,
    })),
  }
}
