import { CalendarDaysIcon, LinkIcon, UsersIcon } from "lucide-react"
import { PublicHeader } from "@/components/organisms/public-header"

const FEATURES = [
  {
    icon: UsersIcon,
    title: "Societies and clubs",
    body: "University, college and sports societies in one directory, each fact linked to the page it came from.",
  },
  {
    icon: CalendarDaysIcon,
    title: "Events",
    body: "Upcoming talks, socials and sessions, collected from the societies' own published calendars.",
  },
  {
    icon: LinkIcon,
    title: "Sourced, not guessed",
    body: "Every field carries a source URL, a retrieval date and a verification status. Unknown stays unknown.",
  },
] as const

export default function HomePage() {
  return (
    <div className="flex min-h-svh flex-col">
      <PublicHeader />

      <section className="flex flex-1 flex-col items-center justify-center gap-6 px-6 py-24 text-center">
        <div className="flex max-w-3xl flex-col gap-4">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            Cambridge societies, in one place.
          </h1>
          <p className="text-lg text-muted-foreground">
            camsocs is a sourced directory of Cambridge societies and sports clubs. The directory is
            being built — nothing is published yet.
          </p>
        </div>
      </section>

      <section className="border-t bg-muted/40 px-6 py-16">
        <div className="mx-auto grid max-w-5xl gap-10 md:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <div key={title} className="flex flex-col gap-3">
              <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Icon className="size-5" />
              </div>
              <h2 className="text-base font-semibold">{title}</h2>
              <p className="text-sm text-muted-foreground">{body}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="border-t px-6 py-8">
        <div className="mx-auto flex max-w-7xl items-center justify-between text-sm text-muted-foreground">
          <span>camsocs</span>
        </div>
      </footer>
    </div>
  )
}
