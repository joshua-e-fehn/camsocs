import { Fragment } from "react"
import { ExternalLink } from "@/components/molecules/external-link"
import { type Inline, parseRichText, shortUrl } from "@/lib/rich-text"
import { cn } from "@/lib/utils"

/**
 * A stored description as readable text: paragraphs, line breaks, lists,
 * bold, italic and links (lib/rich-text.ts reads the markdown; nothing becomes
 * HTML, React writes every word as text). Links leave the site in a new tab
 * with `rel="noopener noreferrer nofollow"`: http(s) through `ExternalLink`,
 * a `mailto:` address as a plain anchor; a bare URL is shown shortened to its
 * host and path.
 */

const LINK_CLASS =
  "inline underline decoration-muted-foreground/50 underline-offset-4 hover:decoration-foreground"

function RichLink({ node }: { node: Extract<Inline, { kind: "link" }> }) {
  const label =
    node.bare || node.children.length === 0 ? (
      shortUrl(node.href)
    ) : (
      <Inlines nodes={node.children} />
    )
  if (node.href.startsWith("mailto:")) {
    return (
      <a href={node.href} target="_blank" rel="noopener noreferrer nofollow" className={LINK_CLASS}>
        {label}
        <span className="sr-only"> (opens your email app)</span>
      </a>
    )
  }
  return (
    // In running text the underline is the affordance; an arrow would wrap
    // onto a line of its own after a long URL.
    <ExternalLink href={node.href} icon={false} className={LINK_CLASS}>
      {label}
    </ExternalLink>
  )
}

function Inlines({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((node, index) => {
        // The tree is rebuilt from the same text on every render: positions are stable.
        const key = `${node.kind}-${index}`
        if (node.kind === "text") return <Fragment key={key}>{node.text}</Fragment>
        if (node.kind === "break") return <br key={key} />
        if (node.kind === "strong") {
          return (
            <strong key={key} className="font-semibold">
              <Inlines nodes={node.children} />
            </strong>
          )
        }
        if (node.kind === "em") {
          return (
            <em key={key}>
              <Inlines nodes={node.children} />
            </em>
          )
        }
        return <RichLink key={key} node={node} />
      })}
    </>
  )
}

export function RichText({ text, className }: { text: string; className?: string }) {
  const blocks = parseRichText(text)
  return (
    <div className={cn("flex max-w-prose flex-col gap-3 text-sm leading-relaxed", className)}>
      {blocks.map((block, index) => {
        const key = `${block.kind}-${index}`
        if (block.kind === "heading") {
          return (
            <p key={key} className="font-semibold">
              <Inlines nodes={block.children} />
            </p>
          )
        }
        if (block.kind === "list") {
          const items = block.items.map((item, itemIndex) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: items have no identity beyond their place
            <li key={itemIndex}>
              <Inlines nodes={item} />
            </li>
          ))
          return block.ordered ? (
            <ol key={key} start={block.start} className="flex list-decimal flex-col gap-1 pl-5">
              {items}
            </ol>
          ) : (
            <ul key={key} className="flex list-disc flex-col gap-1 pl-5">
              {items}
            </ul>
          )
        }
        return (
          <p key={key}>
            <Inlines nodes={block.children} />
          </p>
        )
      })}
    </div>
  )
}
