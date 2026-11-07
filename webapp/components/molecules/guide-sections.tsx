import { Cite } from "@/components/molecules/guide-parts"
import { ProseSection } from "@/components/molecules/prose-section"
import type { GuideSection } from "@/lib/guide-content"
import type { GuideSource } from "@/lib/guides"

/** Researched sections (lib/guide-content.ts): each paragraph with its citations. */
export function GuideSections({
  sections,
  sources,
}: {
  sections: readonly GuideSection[]
  sources: readonly GuideSource[]
}) {
  const byUrl = new Map(sources.map((source) => [source.url, source]))
  return sections.map((section) => (
    <ProseSection key={section.id} id={section.id} title={section.title}>
      {section.paragraphs.map((paragraph) => (
        <p key={paragraph.text.slice(0, 40)}>
          {paragraph.text}
          {paragraph.sources.map((url) => {
            const source = byUrl.get(url)
            return source ? <Cite key={url} source={source} /> : null
          })}
        </p>
      ))}
    </ProseSection>
  ))
}
