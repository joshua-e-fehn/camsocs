import { PencilLineIcon } from "lucide-react"
import { ExternalLink } from "@/components/molecules/external-link"
import { formatDate } from "@/lib/calendar"
import { type GuideSlug, REVIEW_NOTES, reviewNote, SOURCES, type SourceId } from "@/lib/guides"

/**
 * The small parts the guides are written with (lib/guides.ts): an inline
 * citation, an editor's note for Joshua, the page's source list and the
 * draft notice.
 */

/** An inline citation: the publisher, linking the source. */
export function Cite({ id }: { id: SourceId }) {
  const source = SOURCES[id]
  return (
    <span className="text-xs whitespace-nowrap">
      {" "}
      [
      <ExternalLink href={source.url} icon={false} className="text-brand-text">
        {source.publisher}
      </ExternalLink>
      ]
    </span>
  )
}

const KIND_LABELS = {
  check: "To check",
  decide: "To decide",
  tip: "First-hand tip to write",
} as const

/**
 * An open review note (`REVIEW_NOTES`), shown where it applies as
 * "[Joshua: …]". Renders nothing once the note is resolved; the guides' test
 * then also asks for the tag to go.
 */
export function EditorNote({ id }: { id: string }) {
  const note = reviewNote(id)
  if (!note) return null
  return (
    <aside
      role="note"
      data-nosnippet
      data-review-note={note.id}
      className="flex gap-2.5 rounded-lg border border-dashed border-foreground/40 bg-muted px-3.5 py-3 text-sm text-foreground"
    >
      <PencilLineIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <p>
        <span className="font-mono text-xs tracking-wide uppercase">{KIND_LABELS[note.kind]}</span>{" "}
        [Joshua: {note.note}]
      </p>
    </aside>
  )
}

/** The page's sources, numbered, each with when it was read. */
export function GuideSourceList({ ids }: { ids: readonly SourceId[] }) {
  return (
    <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-muted-foreground">
      {ids.map((id) => {
        const source = SOURCES[id]
        return (
          <li key={id} id={`source-${id}`}>
            <span className="text-foreground">{source.publisher}</span>,{" "}
            <ExternalLink href={source.url} className="text-foreground underline">
              {source.title}
            </ExternalLink>
            . Read {formatDate(source.retrieved)}.
          </li>
        )
      })}
    </ol>
  )
}

/** While a guide has open review notes: says it is a draft, and how many. */
export function DraftNotice({ slug }: { slug?: GuideSlug }) {
  const open = REVIEW_NOTES.filter((note) => slug === undefined || note.guide === slug).length
  if (open === 0) return null
  return (
    <p
      role="note"
      data-nosnippet
      className="rounded-lg border border-dashed border-foreground/40 bg-muted px-3.5 py-2.5 font-mono text-xs text-foreground"
    >
      Draft for review: {open} open {open === 1 ? "note" : "notes"} for Joshua. Not yet checked; do
      not rely on it.
    </p>
  )
}
