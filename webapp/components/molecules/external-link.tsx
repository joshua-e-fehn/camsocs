import { ArrowUpRightIcon } from "lucide-react"
import { displayHost } from "@/lib/source-line"
import { cn } from "@/lib/utils"

/**
 * A link off-site: new tab, `rel="noopener noreferrer nofollow"` (we pass no
 * referrer and no ranking to pages we merely cite), and an announced "opens in
 * a new tab". Anything that is not an http(s) URL renders as plain text, so a
 * bad value can never become a `javascript:` link.
 */
export function ExternalLink({
  href,
  children,
  className,
  icon = true,
}: {
  href: string
  children?: React.ReactNode
  className?: string
  icon?: boolean
}) {
  const host = displayHost(href)
  if (host === null) return <span className={className}>{children ?? href}</span>
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className={cn(
        "inline-flex items-center gap-0.5 break-all underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring",
        className,
      )}
    >
      {children ?? host}
      {icon && <ArrowUpRightIcon aria-hidden className="size-3 shrink-0 opacity-70" />}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}
