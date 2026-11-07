import Link from "next/link"
import { cn } from "@/lib/utils"

const FINDERS = [
  { href: "/finder", label: "Societies", emoji: "🧭" },
  { href: "/finder/events", label: "Events", emoji: "🎟️" },
  { href: "/talks/finder", label: "Talks", emoji: "🎓" },
] as const

/** A Finder page's heading and the switch between the three finders. */
export function FinderHero({
  current,
  title,
  lede,
}: {
  current: (typeof FINDERS)[number]["href"]
  title: string
  lede: string
}) {
  return (
    <header className="flex flex-col gap-4">
      <nav aria-label="Finders" className="flex flex-wrap gap-2">
        {FINDERS.map((finder) => (
          <Link
            key={finder.href}
            href={finder.href}
            aria-current={finder.href === current ? "page" : undefined}
            className={cn(
              "inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3.5 text-sm transition-colors",
              finder.href === current
                ? "border-brand bg-accent font-medium"
                : "hover:border-brand/60",
            )}
          >
            <span aria-hidden>{finder.emoji}</span>
            {finder.label}
          </Link>
        ))}
      </nav>
      <h1 className="font-serif text-4xl leading-tight font-normal tracking-[-0.02em] text-balance sm:text-5xl">
        {title}
      </h1>
      <p className="max-w-2xl text-lg text-muted-foreground">{lede}</p>
    </header>
  )
}
