"use client"

import { ArrowRightIcon, SearchIcon } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { openPalette } from "@/lib/palette"
import { cn } from "@/lib/utils"

const SCOPES = [
  { value: "all", label: "All", placeholder: "Rowing, jazz, a college, a talk…" },
  { value: "societies", label: "Societies", placeholder: "Chess, rowing, German…" },
  { value: "events", label: "Events", placeholder: "Formal, open mic, bop…" },
  { value: "talks", label: "Talks", placeholder: "A speaker, a topic, a series…" },
] as const

type Scope = (typeof SCOPES)[number]["value"]

/** Where each scope's search lands. "All" opens the ⌘K palette instead. */
const TARGETS: Record<Exclude<Scope, "all">, string> = {
  societies: "/societies",
  events: "/events",
  talks: "/talks",
}

/**
 * The home hero's one search box (spec §6 "Home"), scoped All / Societies /
 * Events / Talks. "All" searches everything at once in the palette; the
 * others go to their page with `?q=`. Without JavaScript it is a plain GET
 * form to /societies.
 */
export function HeroSearch({ className }: { className?: string }) {
  const router = useRouter()
  const [scope, setScope] = useState<Scope>("all")
  const [q, setQ] = useState("")
  const current = SCOPES.find((item) => item.value === scope) ?? SCOPES[0]

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const text = q.trim()
    if (scope === "all") {
      openPalette({ query: text })
      return
    }
    router.push(text ? `${TARGETS[scope]}?q=${encodeURIComponent(text)}` : TARGETS[scope])
  }

  return (
    <search className={cn("flex w-full flex-col gap-3", className)}>
      <fieldset
        aria-label="Search in"
        className="no-scrollbar min-w-0 -mx-4 flex gap-1.5 overflow-x-auto px-4 sm:mx-0 sm:px-0"
      >
        {SCOPES.map((item) => (
          <button
            key={item.value}
            type="button"
            aria-pressed={scope === item.value}
            onClick={() => setScope(item.value)}
            className="min-h-11 shrink-0 rounded-full border border-transparent px-4 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring aria-pressed:border-border aria-pressed:bg-card aria-pressed:text-foreground aria-pressed:shadow-xs sm:min-h-9"
          >
            {item.label}
          </button>
        ))}
      </fieldset>
      <form
        action="/societies"
        onSubmit={submit}
        className="flex w-full items-center gap-1.5 rounded-2xl border bg-card p-1.5 shadow-[0_1px_0_var(--border),0_12px_32px_-18px_color-mix(in_oklab,var(--foreground)_35%,transparent)] focus-within:border-primary/50"
      >
        <label htmlFor="home-search" className="sr-only">
          Search {scope === "all" ? "everything" : current.label.toLowerCase()}
        </label>
        <SearchIcon aria-hidden className="ml-2.5 size-5 shrink-0 text-muted-foreground" />
        <input
          id="home-search"
          name="q"
          type="search"
          value={q}
          onChange={(event) => setQ(event.target.value)}
          placeholder={current.placeholder}
          maxLength={200}
          autoComplete="off"
          className="h-12 min-w-0 flex-1 bg-transparent px-1 text-base outline-none placeholder:text-muted-foreground/80"
        />
        <button
          type="submit"
          className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <span className="max-sm:sr-only">Search</span>
          <ArrowRightIcon aria-hidden className="size-4" />
        </button>
      </form>
    </search>
  )
}
