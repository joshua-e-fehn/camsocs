"use client"

import { ArrowRightIcon, SearchIcon } from "lucide-react"
import { useState } from "react"
import { openPalette } from "@/lib/palette"
import { cn } from "@/lib/utils"

/**
 * The home hero's one search box (DESIGN.md "River & ink"): it searches
 * societies, events and talks at once, in the ⌘K palette. Without JavaScript
 * it is a plain GET form to /societies.
 */
export function HeroSearch({ className }: { className?: string }) {
  const [q, setQ] = useState("")

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    openPalette({ query: q.trim() })
  }

  return (
    <search className={cn("w-full", className)}>
      <form
        action="/societies"
        onSubmit={submit}
        className="flex h-14 w-full items-center gap-2.5 rounded-[14px] border-[1.5px] border-foreground bg-background pr-1.5 pl-3.5 focus-within:outline-2 focus-within:outline-offset-[3px] focus-within:outline-ring sm:h-15 sm:gap-3 sm:pl-[18px]"
      >
        <label htmlFor="home-search" className="sr-only">
          Search societies, events and talks
        </label>
        <SearchIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
        <input
          id="home-search"
          name="q"
          type="search"
          value={q}
          onChange={(event) => setQ(event.target.value)}
          placeholder="Jazz, robots, rugby…"
          maxLength={200}
          autoComplete="off"
          className="h-full min-w-0 flex-1 bg-transparent text-[1.0625rem] outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
        />
        <button
          type="submit"
          className="group inline-flex size-11 shrink-0 items-center justify-center gap-2 rounded-[10px] bg-primary text-[0.9375rem] font-semibold text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:h-[46px] sm:w-auto sm:px-5"
        >
          <span className="max-sm:sr-only">Search</span>
          <ArrowRightIcon
            aria-hidden
            className="size-5 transition-transform group-hover:translate-x-0.5 sm:size-4"
          />
        </button>
      </form>
    </search>
  )
}
