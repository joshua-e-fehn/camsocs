import type { Metadata } from "next"
import Link from "next/link"
import { Cite } from "@/components/molecules/guide-parts"
import { ProseSection } from "@/components/molecules/prose-section"
import { ResearchedGuide } from "@/components/organisms/researched-guide"
import {
  byLetter,
  GLOSSARY,
  GLOSSARY_CHECKED_ON,
  GLOSSARY_INTRO,
  glossaryJsonLd,
  termAnchor,
} from "@/lib/glossary"
import { guide } from "@/lib/guides"
import { pageMetadata } from "@/lib/page-metadata"
import { jsonLdScript } from "@/lib/structured-data"

/**
 * Cambridge words explained (ENG-113): an A–Z of the words students meet,
 * each defined from an institutional page (lib/data/guides/glossary.json)
 * and linked to the CAMsocs page that says more. Every word has its own
 * anchor (`#bedder`), and the page carries a DefinedTermSet.
 */

const GUIDE = guide("glossary")

export const metadata: Metadata = {
  ...pageMetadata({ title: GUIDE.title, description: GUIDE.description, path: GUIDE.path }),
  openGraph: { type: "article" },
}

export default function GlossaryGuide() {
  const letters = byLetter()
  const termSection = {
    id: "words",
    title: "",
    paragraphs: GLOSSARY.map((entry) => ({ text: entry.text, sources: entry.sources })),
  }
  return (
    <ResearchedGuide
      guide={GUIDE}
      sections={GLOSSARY_INTRO}
      extraSections={[termSection]}
      checkedOn={GLOSSARY_CHECKED_ON}
      lede={
        <>
          Cambridge has its own words for almost everything, from the terms of the year to the
          people who clean your room. Here are {GLOSSARY.length} of them, each with where it comes
          from.
        </>
      }
    >
      {(sources) => (
        <>
          <script
            type="application/ld+json"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD, escaped by jsonLdScript
            dangerouslySetInnerHTML={{ __html: jsonLdScript(glossaryJsonLd(GUIDE.path)) }}
          />
          <nav aria-label="Letters" className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-sm">
            {letters.map(([letter]) => (
              <a
                key={letter}
                href={`#letter-${letter}`}
                className="underline-offset-4 hover:underline"
              >
                {letter}
              </a>
            ))}
          </nav>
          {letters.map(([letter, terms]) => (
            <ProseSection key={letter} id={`letter-${letter}`} title={letter}>
              <dl className="flex flex-col gap-3">
                {terms.map((entry) => (
                  <div key={entry.term} id={termAnchor(entry.term)} className="scroll-mt-20">
                    <dt className="font-medium text-foreground">{entry.term}</dt>
                    <dd>
                      {entry.text}
                      {entry.sources.map((url) => {
                        const source = sources.find((s) => s.url === url)
                        return source ? <Cite key={url} source={source} /> : null
                      })}
                      {entry.see && (
                        <>
                          {" "}
                          <Link href={entry.see}>More on CAMsocs</Link>
                        </>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </ProseSection>
          ))}
        </>
      )}
    </ResearchedGuide>
  )
}
