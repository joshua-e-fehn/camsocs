"use client"

import { ChevronsUpDownIcon, XIcon } from "lucide-react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { useOrgSearch } from "@/hooks/convex"
import type { OrgRef } from "@/lib/public-api"
import { cn } from "@/lib/utils"

/**
 * Pick one society by typing part of its name (server-side search over the
 * directory). `value` is the current choice; `onChange(null)` clears it.
 * Without a `<label htmlFor={id}>`, pass `label`: a `role="combobox"` button
 * takes no name from its text, so it would be announced as nothing.
 */
export function OrgPicker({
  value,
  onChange,
  placeholder = "Any society",
  id,
  label,
  className,
  "aria-invalid": invalid,
}: {
  value: OrgRef | null
  onChange: (org: OrgRef | null) => void
  placeholder?: string
  id?: string
  /** The accessible name when no `<label>` points at `id`. */
  label?: string
  className?: string
  "aria-invalid"?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const results = useOrgSearch(query)

  return (
    <div className={cn("flex items-center gap-1", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-invalid={invalid}
            aria-label={label ? `${label}: ${value ? value.name : placeholder}` : undefined}
            className="h-9 min-w-0 flex-1 justify-between font-normal"
          >
            <span className={cn("truncate", !value && "text-muted-foreground")}>
              {value ? value.name : placeholder}
            </span>
            <ChevronsUpDownIcon aria-hidden className="opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-(--radix-popover-trigger-width) min-w-72 p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="Type a society's name…"
              value={query}
              onValueChange={setQuery}
            />
            <CommandList>
              {query.trim() === "" ? (
                <p className="px-3 py-4 text-sm text-muted-foreground">Start typing to search.</p>
              ) : results === undefined ? (
                <div className="flex justify-center py-4">
                  <Spinner />
                </div>
              ) : (
                <>
                  <CommandEmpty>No society matches “{query.trim()}”.</CommandEmpty>
                  <CommandGroup>
                    {results.page.map((card) => (
                      <CommandItem
                        key={card.key}
                        value={card.key}
                        onSelect={() => {
                          onChange({ key: card.key, slug: card.slug, name: card.name })
                          setOpen(false)
                        }}
                      >
                        <span className="truncate">{card.name}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {value && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`Clear ${value.name}`}
          onClick={() => onChange(null)}
        >
          <XIcon />
        </Button>
      )}
    </div>
  )
}
