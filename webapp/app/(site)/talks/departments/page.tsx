import { fetchQuery } from "convex/nextjs"
import { ArrowLeftIcon } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { api } from "@/convex/_generated/api"
import { formatDayShort, londonIsoDate } from "@/lib/calendar"
import { pageMetadata } from "@/lib/page-metadata"
import { SCHOOL_TONE, type TalkDepartment } from "@/lib/talks"
import { talksHref } from "@/lib/talks-url-state"
import { firstParam, type SearchParams } from "@/lib/url-state"
import { cn } from "@/lib/utils"
import { TALK_SCHOOL_LABELS, TALK_SCHOOLS, type TalkSchool } from "@/lib/vocab"

type Props = { searchParams: Promise<SearchParams> }

export const metadata: Metadata = pageMetadata({
  title: "Talks by department",
  description:
    "Every Cambridge department and institute whose public talks we list, by School or A–Z, with how many are coming up in the next four weeks.",
  path: "/talks/departments",
})

/** "School of Technology"; the seventh group is not a School. */
const SCHOOL_HEADINGS: Record<TalkSchool, string> = {
  arts_humanities: "School of Arts and Humanities",
  humanities_social_sciences: "School of the Humanities and Social Sciences",
  biological_sciences: "School of the Biological Sciences",
  clinical_medicine: "School of Clinical Medicine",
  physical_sciences: "School of the Physical Sciences",
  technology: "School of Technology",
  other: "Institutes, museums, colleges and other series",
}

function letterOf(name: string): string {
  const first = name.normalize("NFKD").replace(/[^A-Za-z]/g, "")[0]
  return first ? first.toUpperCase() : "#"
}

function Row({ department, number }: { department: TalkDepartment; number: number }) {
  const tone = SCHOOL_TONE[department.school]
  const quiet = department.upcomingCount === 0
  const longName = department.name !== department.shortName ? department.name : undefined
  return (
    <li className="border-b">
      <Link
        href={talksHref({ dept: department.slug })}
        className="group grid min-h-14 grid-cols-[2.75rem_minmax(0,1fr)_auto] items-baseline gap-x-3 py-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <span className="font-mono text-[0.6875rem] text-muted-foreground tabular-nums">
          N°&nbsp;{String(number).padStart(3, "0")}
        </span>
        <span className="flex min-w-0 flex-col">
          <span
            className={cn(
              "flex items-baseline gap-2 font-serif text-lg leading-snug group-hover:underline group-hover:decoration-1 group-hover:underline-offset-4",
              quiet && "text-muted-foreground",
            )}
          >
            <span
              aria-hidden
              className={cn("size-1.5 shrink-0 translate-y-[-0.2em] rounded-full", tone.dot)}
            />
            <span className="min-w-0">{department.shortName}</span>
          </span>
          {longName && (
            <span className="truncate pl-3.5 text-xs text-muted-foreground">{longName}</span>
          )}
          <span className="pl-3.5 text-sm text-muted-foreground">
            {quiet
              ? department.virtual
                ? "No unplaced series in the next 4 weeks"
                : "Nothing listed in the next 4 weeks"
              : `${department.upcomingCount} ${department.upcomingCount === 1 ? "talk" : "talks"} in the next 4 weeks`}
          </span>
        </span>
        <span className="text-right font-mono text-xs text-muted-foreground tabular-nums">
          {department.nextStartsAt !== null ? (
            <>
              <span className="sr-only">Next: </span>
              {formatDayShort(londonIsoDate(department.nextStartsAt))}
            </>
          ) : (
            <span aria-hidden>—</span>
          )}
        </span>
      </Link>
    </li>
  )
}

/**
 * The department index (talks-redesign-spec §6): every department, institute
 * and series bucket whose talks we list, grouped by School — or A–Z with a
 * letter bar — as N°-numbered ruled rows with the next four weeks' count and
 * the next date. Each row opens /talks for that department. "Other series"
 * holds talks.cam series we could not place in a department. No client
 * JavaScript: the view is a link (`?view=az`).
 */
export default async function TalkDepartmentsPage({ searchParams }: Props) {
  const view = firstParam(await searchParams, "view") === "az" ? "az" : "school"
  let departments: TalkDepartment[] = []
  try {
    departments = await fetchQuery(api.talks.departments, {})
  } catch (error) {
    unstable_rethrow(error)
    departments = []
  }
  const real = departments.filter((department) => !department.virtual)
  const active = real.filter((department) => department.upcomingCount > 0).length
  const upcoming = departments.reduce((sum, department) => sum + department.upcomingCount, 0)

  const groups =
    view === "school"
      ? TALK_SCHOOLS.map((school) => ({
          id: `school-${school}`,
          title: SCHOOL_HEADINGS[school],
          jump: school === "other" ? "Other" : TALK_SCHOOL_LABELS[school],
          school: school as TalkSchool | undefined,
          rows: departments.filter((department) => department.school === school),
        })).filter((group) => group.rows.length > 0)
      : [...new Set(departments.map((department) => letterOf(department.shortName)))]
          .sort()
          .map((letter) => ({
            id: `letter-${letter}`,
            title: letter,
            jump: letter,
            school: undefined as TalkSchool | undefined,
            rows: departments
              .filter((department) => letterOf(department.shortName) === letter)
              .sort((a, b) => a.shortName.localeCompare(b.shortName)),
          }))
  const letters = new Set(groups.map((group) => group.jump))
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")
  let number = 0

  const tab = (value: "school" | "az", label: string) => (
    <Link
      href={value === "az" ? "/talks/departments?view=az" : "/talks/departments"}
      aria-current={view === value ? "page" : undefined}
      className={cn(
        "inline-flex h-11 items-center rounded-full px-4 text-sm font-medium transition-colors sm:h-9",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        view === value
          ? "bg-foreground text-background"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </Link>
  )

  return (
    <>
      <header className="border-b bg-card/40">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 px-4 pt-8 pb-6 sm:px-6 sm:pt-12">
          <Link
            href="/talks"
            className="inline-flex min-h-11 items-center gap-1.5 self-start text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring sm:min-h-8"
          >
            <ArrowLeftIcon aria-hidden className="size-3.5" />
            All talks
          </Link>
          <p className="flex items-center gap-2 font-mono text-[0.6875rem] font-medium tracking-[0.14em] text-talks uppercase">
            <span aria-hidden className="h-px w-6 bg-talks" />
            The department index
          </p>
          <h1 className="font-serif text-[clamp(2.4rem,6.4vw,4.25rem)] leading-[1.02] font-normal tracking-[-0.025em]">
            Talks by department
          </h1>
          <p className="max-w-2xl text-pretty text-muted-foreground sm:text-lg">
            {real.length > 0
              ? `${real.length} departments and institutes across the six Schools and beyond; ${active} have talks in the next four weeks — ${upcoming} in all.`
              : "The department index could not be read just now. Try again in a moment."}
          </p>
        </div>
      </header>

      <div className="sticky top-[var(--site-header-height,4rem)] z-30 border-b bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/80">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-2 px-4 py-2.5 sm:px-6 lg:flex-row lg:items-center lg:gap-6">
          <nav aria-label="Order" className="flex items-center gap-1">
            {tab("school", "By School")}
            {tab("az", "A–Z")}
          </nav>
          <nav
            aria-label={view === "az" ? "Jump to a letter" : "Jump to a School"}
            className="-mx-4 flex items-center gap-1 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden"
          >
            {view === "az"
              ? alphabet.map((letter) =>
                  letters.has(letter) ? (
                    <a
                      key={letter}
                      href={`#letter-${letter}`}
                      className="inline-flex size-11 shrink-0 items-center justify-center rounded-md font-serif text-lg hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring sm:size-8 sm:text-base"
                    >
                      {letter}
                    </a>
                  ) : (
                    <span
                      key={letter}
                      aria-hidden
                      className="inline-flex size-11 shrink-0 items-center justify-center font-serif text-lg text-muted-foreground/40 sm:size-8 sm:text-base"
                    >
                      {letter}
                    </span>
                  ),
                )
              : groups.map((group) => (
                  <a
                    key={group.id}
                    href={`#${group.id}`}
                    className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] whitespace-nowrap text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring sm:h-8"
                  >
                    {group.school && (
                      <span
                        aria-hidden
                        className={cn("size-1.5 rounded-full", SCHOOL_TONE[group.school].dot)}
                      />
                    )}
                    {group.jump}
                  </a>
                ))}
          </nav>
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-7xl flex-col gap-14 px-4 pt-10 pb-20 sm:px-6">
        {groups.map((group) => {
          const talks = group.rows.reduce((sum, department) => sum + department.upcomingCount, 0)
          return (
            <section
              key={group.id}
              id={group.id}
              aria-labelledby={`${group.id}-heading`}
              className="scroll-mt-[calc(var(--site-header-height,4rem)+7rem)] lg:scroll-mt-[calc(var(--site-header-height,4rem)+4.5rem)]"
            >
              <div
                className={cn(
                  "flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b-2 pb-2",
                  group.school ? SCHOOL_TONE[group.school].border : "border-foreground",
                )}
              >
                <h2
                  id={`${group.id}-heading`}
                  className={cn(
                    "font-serif font-normal tracking-tight",
                    view === "az" ? "text-4xl" : "text-[1.75rem] leading-tight sm:text-3xl",
                  )}
                >
                  {group.title}
                </h2>
                <p className="font-mono text-[0.6875rem] tracking-wide text-muted-foreground uppercase">
                  {group.rows.length} {group.rows.length === 1 ? "entry" : "entries"} · {talks}{" "}
                  {talks === 1 ? "talk" : "talks"}
                </p>
              </div>
              <ol className="grid lg:grid-cols-2 lg:gap-x-12">
                {group.rows.map((department) => {
                  number += 1
                  return <Row key={department.key} department={department} number={number} />
                })}
              </ol>
            </section>
          )
        })}
      </div>
    </>
  )
}
