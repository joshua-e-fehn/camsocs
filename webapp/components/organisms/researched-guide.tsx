import { ClubLinks } from "@/components/molecules/club-links"
import { GuideSections } from "@/components/molecules/guide-sections"
import { GuideArticle } from "@/components/organisms/guide-article"
import { type GuideSection, sectionSources } from "@/lib/guide-content"
import type { Guide, GuideSource } from "@/lib/guides"

/**
 * A guide made of researched sections (lib/data/guides/*.json): the
 * sections in order, each followed by the CAMsocs pages it is about, then
 * anything the page adds (`children`, given the page's sources so it can
 * cite them), then the source list built from the same URLs.
 */
export function ResearchedGuide({
  guide,
  lede,
  sections,
  checkedOn,
  extraSections = [],
  names,
  clubs = {},
  aside,
  children,
}: {
  guide: Guide
  lede: React.ReactNode
  sections: readonly GuideSection[]
  checkedOn: string
  /** Sections the page renders itself whose URLs join the source list. */
  extraSections?: readonly GuideSection[]
  /** Citation labels by host, for publishers the defaults do not know. */
  names?: Record<string, string>
  /** CAMsocs listings per section id: [slug, name]. */
  clubs?: Record<string, readonly (readonly [string, string])[]>
  aside?: React.ReactNode
  children?: (sources: readonly GuideSource[]) => React.ReactNode
}) {
  const sources = sectionSources([...sections, ...extraSections], checkedOn, names)
  return (
    <GuideArticle
      guide={guide}
      sources={sources}
      toc={[
        ...sections.map((s) => [`#${s.id}`, s.title] as const),
        ...extraSections.filter((s) => s.title).map((s) => [`#${s.id}`, s.title] as const),
      ]}
      lede={lede}
      aside={aside}
    >
      {sections.map((section) => (
        <div key={section.id} className="flex flex-col gap-3">
          <GuideSections sections={[section]} sources={sources} />
          <ClubLinks clubs={clubs[section.id] ?? []} />
        </div>
      ))}
      {children?.(sources)}
    </GuideArticle>
  )
}
