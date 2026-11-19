"use client"

import { useEffect, useState } from "react"
import type { Weekday } from "@/lib/colleges"
import { dayId, londonWeekday, WEEKDAY_NAMES } from "@/lib/formal-week"

/**
 * The "tonight" line on /formals (formals SEO audit 2026-11-19): how many
 * colleges hold formal hall this evening, with a link to that night's list.
 * The server draws it for the London day it rendered on; the browser checks
 * its own London day once mounted and redraws only if a cached page is from
 * an earlier day, so it never says the wrong night and, on the same day,
 * nothing moves. Out of Full Term (`inFullTerm` false) the line says
 * the nights are term-time ones.
 */
export function FormalsTonight({
  counts,
  serverDay,
  inFullTerm,
}: {
  counts: Readonly<Record<Weekday, { weekly: number; occasional: number }>>
  serverDay: Weekday
  /** True in Full Term, false out of it, null when the term dates are unknown. */
  inFullTerm: boolean | null
}) {
  const [day, setDay] = useState<Weekday>(serverDay)
  useEffect(() => setDay(londonWeekday(Date.now())), [])
  const { weekly, occasional } = counts[day]
  const more =
    occasional > 0
      ? ` (and ${occasional} more ${occasional === 1 ? "holds" : "hold"} one some weeks)`
      : ""
  const colleges = `${weekly} ${weekly === 1 ? "college holds" : "colleges hold"}`
  const name = WEEKDAY_NAMES[day]
  return (
    <p className="text-lg text-pretty">
      {inFullTerm === false ? (
        <>
          Tonight is a {name}. In Full Term, {colleges} formal hall every {name}
          {more};{" "}
        </>
      ) : (
        <>
          Tonight ({name}) {colleges} formal hall{more};{" "}
        </>
      )}
      <a href={`#${dayId(day)}`} className="underline underline-offset-4">
        see {name}’s list
      </a>
      .
    </p>
  )
}
