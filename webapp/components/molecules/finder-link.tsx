import Link from "next/link"
import { cn } from "@/lib/utils"

/**
 * A Finder entry point (ENG-133): a small pill that starts the quiz, for
 * the directory, the events calendar and the guides.
 */
export function FinderLink({
  href = "/finder",
  emoji = "🧭",
  children,
  className,
}: {
  href?: "/finder" | "/finder/events" | "/talks/finder"
  emoji?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <Link
      href={href}
      className={cn(
        "group inline-flex min-h-11 items-center gap-2.5 self-start rounded-full border-2 border-brand/40 bg-accent/40 px-4 py-1.5 text-sm transition-colors hover:border-brand sm:min-h-9",
        className,
      )}
    >
      <span aria-hidden className="text-base transition-transform group-hover:rotate-12">
        {emoji}
      </span>
      <span>{children}</span>
    </Link>
  )
}
