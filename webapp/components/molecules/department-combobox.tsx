"use client"

import { CheckIcon, ChevronsUpDownIcon, XIcon } from "lucide-react"
import { useState } from "react"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { SCHOOL_TONE, type TalkDepartment } from "@/lib/talks"
import { cn } from "@/lib/utils"
import { TALK_SCHOOL_LABELS, TALK_SCHOOLS, type TalkSchool } from "@/lib/vocab"

/**
 * Every word typed must appear in the slug, short name or full name; a short
 * name that starts with the text ranks first. (cmdk's default fuzzy score
 * ranks "Interfaith Programme" over "Computer Science" for "comp".)
 */
export function departmentFilter(value: string, search: string, keywords: string[] = []): number {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return 1
  const hay = [value, ...keywords].join(" ").toLowerCase()
  if (!words.every((word) => hay.includes(word))) return 0
  const short = (keywords[0] ?? value).toLowerCase()
  if (short.startsWith(search.toLowerCase().trim())) return 1
  const wordStart = hay.split(/[\s,()-]+/).some((part) => part.startsWith(words[0]))
  return wordStart ? 0.7 : 0.4
}

/**
 * The department list as a searchable command menu (cmdk), grouped by
 * School, each department with its count of talks in the next four weeks.
 * A School narrows it to that School's departments. Matches the short name,
 * the full name and the slug, so "DAMTP", "Applied Mathematics" and "cst"
 * all find something.
 */
function DepartmentList({
  departments,
  value,
  school,
  onSelect,
  autoFocus,
}: {
  departments: readonly TalkDepartment[]
  value?: string
  school?: TalkSchool
  onSelect: (slug: string | undefined) => void
  autoFocus?: boolean
}) {
  const [search, setSearch] = useState("")
  const shown = school
    ? departments.filter((department) => department.school === school)
    : departments
  const item = (department: TalkDepartment) => (
    <CommandItem
      key={department.key}
      value={department.slug}
      keywords={[department.shortName, department.name]}
      onSelect={() => onSelect(department.slug)}
      className="min-h-11 sm:min-h-10"
    >
      <CheckIcon
        aria-hidden
        className={cn("size-4", value === department.slug ? "opacity-100" : "opacity-0")}
      />
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 rounded-full", SCHOOL_TONE[department.school].dot)}
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          department.upcomingCount === 0 && "text-muted-foreground",
        )}
      >
        {department.shortName}
      </span>
      <span className="font-mono text-xs text-muted-foreground tabular-nums">
        {department.upcomingCount || "–"}
      </span>
    </CommandItem>
  )
  // While searching, one flat list ranked by the filter (best match first);
  // otherwise the Schools as headed groups.
  return (
    <Command className="bg-transparent" filter={departmentFilter}>
      <CommandInput
        placeholder="Find a department…"
        autoFocus={autoFocus}
        value={search}
        onValueChange={setSearch}
        className="text-base sm:text-sm"
      />
      <CommandList className="max-h-[min(22rem,60svh)]">
        <CommandEmpty>No department matches.</CommandEmpty>
        {search.trim() ? (
          <CommandGroup>{shown.map(item)}</CommandGroup>
        ) : (
          <>
            <CommandGroup>
              <CommandItem
                value="all"
                onSelect={() => onSelect(undefined)}
                className="min-h-11 sm:min-h-10"
              >
                <CheckIcon
                  aria-hidden
                  className={cn("size-4", value ? "opacity-0" : "opacity-100")}
                />
                {school ? `All of ${TALK_SCHOOL_LABELS[school]}` : "All departments"}
              </CommandItem>
            </CommandGroup>
            {TALK_SCHOOLS.map((group) => {
              const rows = shown.filter((department) => department.school === group)
              if (rows.length === 0) return null
              return (
                <CommandGroup key={group} heading={TALK_SCHOOL_LABELS[group]}>
                  {rows.map(item)}
                </CommandGroup>
              )
            })}
          </>
        )}
      </CommandList>
    </Command>
  )
}

/**
 * A "Department ▾" pill that opens the searchable list in a popover; with a
 * department chosen it shows its name and a × that clears it. `inline`
 * renders the list itself (inside the phone's filter sheet).
 */
export function DepartmentCombobox({
  departments,
  value,
  school,
  onChange,
  inline = false,
  className,
}: {
  departments: readonly TalkDepartment[]
  /** A department slug. */
  value?: string
  school?: TalkSchool
  onChange: (slug: string | undefined) => void
  inline?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const current = departments.find((department) => department.slug === value)

  if (inline) {
    return (
      <div className={cn("overflow-hidden rounded-xl border bg-card", className)}>
        <DepartmentList
          departments={departments}
          value={value}
          school={school}
          onSelect={onChange}
        />
      </div>
    )
  }

  return (
    <div className={cn("flex items-center", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={
              current ? `Department: ${current.shortName}. Change` : "Choose a department"
            }
            className={cn(
              "inline-flex h-11 max-w-[16rem] min-w-0 items-center gap-2 border px-3.5 text-[13px] whitespace-nowrap transition-colors duration-150 sm:h-9",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              current
                ? cn(
                    "rounded-l-full border-r-0 font-medium",
                    SCHOOL_TONE[current.school].chip,
                    SCHOOL_TONE[current.school].border,
                  )
                : "rounded-full bg-card hover:border-foreground/40",
            )}
          >
            {current && (
              <span
                aria-hidden
                className={cn("size-2 shrink-0 rounded-full", SCHOOL_TONE[current.school].dot)}
              />
            )}
            <span className="truncate">{current ? current.shortName : "Department"}</span>
            <ChevronsUpDownIcon aria-hidden className="size-3.5 shrink-0 opacity-60" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[min(22rem,calc(100vw-2rem))] p-0">
          <DepartmentList
            departments={departments}
            value={value}
            school={school}
            autoFocus
            onSelect={(slug) => {
              onChange(slug)
              setOpen(false)
            }}
          />
        </PopoverContent>
      </Popover>
      {current && (
        <button
          type="button"
          aria-label={`Clear department ${current.shortName}`}
          onClick={() => onChange(undefined)}
          className={cn(
            "inline-flex h-11 items-center rounded-r-full border border-l-0 pr-3 pl-1.5 sm:h-9",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            SCHOOL_TONE[current.school].chip,
            SCHOOL_TONE[current.school].border,
          )}
        >
          <XIcon aria-hidden className="size-3.5" />
        </button>
      )}
    </div>
  )
}
