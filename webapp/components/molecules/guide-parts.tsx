import { ExternalLink } from "@/components/molecules/external-link"
import { formatDate } from "@/lib/calendar"
import type { GuideSource } from "@/lib/guides"

/**
 * The small parts the guides are written with (lib/guides.ts): an inline
 * citation and the page's source list.
 */

/** An inline citation: the publisher, linking the source. */
export function Cite({ source }: { source: GuideSource }) {
  // The space sits outside the unbreakable part, so a run of citations can
  // wrap between them on a phone.
  return (
    <>
      {" "}
      <span className="text-xs whitespace-nowrap">
        [
        <ExternalLink href={source.url} icon={false} className="text-brand-text">
          {source.publisher}
        </ExternalLink>
        ]
      </span>
    </>
  )
}

/** The page's sources, numbered, each with when it was read. */
export function GuideSourceList({ sources }: { sources: readonly GuideSource[] }) {
  return (
    <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-muted-foreground">
      {sources.map((source) => (
        <li key={source.url}>
          <span className="text-foreground">{source.publisher}</span>,{" "}
          <ExternalLink href={source.url} className="text-foreground underline">
            {source.title}
          </ExternalLink>
          . Read {formatDate(source.retrieved)}.
        </li>
      ))}
    </ol>
  )
}
