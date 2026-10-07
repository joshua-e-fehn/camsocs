"use client"

import { SearchIcon, XIcon } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { cn } from "@/lib/utils"

const DEBOUNCE_MS = 350

/**
 * A search box that reports its text after a pause in typing (or at once on
 * Enter), so a URL-driven page re-queries once per thought, not per key. It
 * follows `value` when the URL changes underneath it (back button, a cleared
 * filter).
 */
export function SearchField({
  value,
  onSearch,
  label,
  placeholder,
  className,
}: {
  value: string
  onSearch: (q: string) => void
  label: string
  placeholder?: string
  className?: string
}) {
  const [text, setText] = useState(value)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef(onSearch)
  latest.current = onSearch

  useEffect(() => setText(value), [value])
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const schedule = (next: string, delay: number) => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      if (next.trim() !== value.trim()) latest.current(next.trim())
    }, delay)
  }

  return (
    <search className={cn("w-full", className)}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          schedule(text, 0)
        }}
      >
        <InputGroup className="h-10">
          <InputGroupAddon>
            <SearchIcon aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            aria-label={label}
            placeholder={placeholder}
            value={text}
            maxLength={200}
            onChange={(event) => {
              setText(event.target.value)
              schedule(event.target.value, DEBOUNCE_MS)
            }}
          />
          {text && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                aria-label="Clear search"
                size="icon-xs"
                onClick={() => {
                  setText("")
                  schedule("", 0)
                }}
              >
                <XIcon />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>
      </form>
    </search>
  )
}
