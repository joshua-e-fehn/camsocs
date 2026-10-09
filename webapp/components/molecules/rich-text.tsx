import { Fragment } from "react"
import { ExternalLink } from "@/components/molecules/external-link"
import { type Inline, parseRichText, shortUrl } from "@/lib/rich-text"
import { cn } from "@/lib/utils"

/**
 * A stored description as readable text: paragraphs, lists, bold, italic and
 * links (lib/rich-text.ts reads the markdown; nothing becomes HTML). Links
 * leave the site through `ExternalLink` (new tab, nofollow); a bare URL is
 * shown shortened to its host and path.
 */

function Inlines({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((node, index) => {
        // The tree is rebuilt from the same text on every render: positions are stable.
        const key = `${node.kind}-${index}`
        if (node.kind === "text") return <Fragment key={key}>{node.text}</Fragment>
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
        const bare = node.children.length === 1 && node.children[0].kind === "text"
        const label =
          bare && node.children[0].kind === "text" && node.children[0].text === node.href
            ? shortUrl(node.href)
            : null
        return (
          <ExternalLink
            key={key}
            href={node.href}
            // In running text the underline is the affordance; an arrow would
            // wrap onto a line of its own after a long URL.
            icon={false}
            className="inline underline decoration-muted-foreground/50 underline-offset-4 hover:decoration-foreground"
          >
            {label ?? <Inlines nodes={node.children} />}
          </ExternalLink>
        )
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
          const List = block.ordered ? "ol" : "ul"
          return (
            <List
              key={key}
              className={cn(
                "flex flex-col gap-1 pl-5",
                block.ordered ? "list-decimal" : "list-disc",
              )}
            >
              {block.items.map((item, itemIndex) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: items have no identity beyond their place
                <li key={itemIndex}>
                  <Inlines nodes={item} />
                </li>
              ))}
            </List>
          )
        }
        return (
          <p key={key}>
            {block.lines.map((line, lineIndex) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity beyond their place
              <Fragment key={lineIndex}>
                {lineIndex > 0 && <br />}
                <Inlines nodes={line} />
              </Fragment>
            ))}
          </p>
        )
      })}
    </div>
  )
}
