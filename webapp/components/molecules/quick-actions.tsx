import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * A profile's student-first actions. On a phone they are a row of round
 * icon buttons with a word under each (Website, Instagram, Email, Calendar,
 * Share); from `sm` up, a row of pill buttons. The first `primary` one is
 * filled. Every target is at least 44 px. Share is a client island
 * (share-action.tsx) in the same style.
 */
export function quickActionClass(primary = false) {
  return cn(
    "group flex min-w-0 flex-col items-center gap-1.5 text-xs font-medium outline-none sm:h-10 sm:flex-row sm:gap-2 sm:rounded-full sm:border sm:px-4 sm:text-sm",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:transition-colors sm:duration-150",
    primary
      ? "sm:border-primary sm:bg-primary sm:text-primary-foreground sm:hover:bg-primary/90"
      : "sm:bg-card sm:hover:border-foreground/40",
  )
}

export function quickActionIconClass(primary = false) {
  return cn(
    "flex size-11 items-center justify-center rounded-full border sm:size-auto sm:border-0 sm:bg-transparent [&>svg]:size-5 sm:[&>svg]:size-4",
    primary ? "border-primary bg-primary text-primary-foreground" : "bg-card",
  )
}

export function QuickAction({
  href,
  icon: Icon,
  label,
  external = false,
  primary = false,
}: {
  href: string
  icon: LucideIcon
  label: string
  external?: boolean
  primary?: boolean
}) {
  return (
    <a
      href={href}
      className={quickActionClass(primary)}
      {...(external ? { target: "_blank", rel: "noopener noreferrer nofollow" } : {})}
    >
      <span className={quickActionIconClass(primary)}>
        <Icon aria-hidden />
      </span>
      <span className="truncate">{label}</span>
      {external && <span className="sr-only"> (opens in a new tab)</span>}
    </a>
  )
}
