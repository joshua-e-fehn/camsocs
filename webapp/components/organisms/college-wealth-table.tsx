"use client"

import { ArrowDownIcon, ArrowUpDownIcon } from "lucide-react"
import Link from "next/link"
import { useMemo, useState } from "react"
import { CollegeCrest } from "@/components/molecules/college-crest"
import { CollegeWealthBar } from "@/components/molecules/college-wealth-bar"
import { ExternalLink } from "@/components/molecules/external-link"
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { WealthSortKey, WealthTable, WealthTableRow } from "@/lib/college-wealth"
import { cn } from "@/lib/utils"

const LINK =
  "underline decoration-muted-foreground/50 underline-offset-4 hover:decoration-foreground"

/**
 * The colleges ranked (/colleges/wealth, ENG-272). Highest first by the
 * chosen figure: endowment (the default, which the server's HTML shows),
 * endowment per student, income, net assets or the 1-year change. Every
 * number and order arrives worked out from lib/college-wealth.ts, so this
 * only switches between them. On a phone the table keeps rank, college and
 * the chosen figure, with the other four on a line under the name.
 */
/** How the phone summary line words each figure. */
const SUMMARY: Record<WealthSortKey, (value: string) => string> = {
  endowment: (value) => `${value} endowment`,
  perStudent: (value) => `${value} a student`,
  income: (value) => `${value} income`,
  netAssets: (value) => `${value} net assets`,
  change: (value) => `${value} on the year`,
}

/** Sticky under the public header (h-15, sm:h-17), on each cell so it sticks in every browser. */
const STICKY_HEAD =
  "[&_th]:sticky [&_th]:top-15 [&_th]:z-10 [&_th]:border-b-2 [&_th]:border-foreground [&_th]:bg-background sm:[&_th]:top-17"

export function CollegeWealthTable({ table }: { table: WealthTable }) {
  const [sortKey, setSortKey] = useState<WealthSortKey>("endowment")
  const bySlug = useMemo(() => new Map(table.rows.map((row) => [row.slug, row])), [table.rows])
  const rows = table.orders[sortKey].flatMap((slug) => bySlug.get(slug) ?? [])
  const scale = table.scales[sortKey]
  const cut = rows.filter((row) => Math.abs(row.values[sortKey]) > scale)
  const label = table.columns.find((column) => column.key === sortKey)?.label ?? ""

  return (
    <div className="flex flex-col gap-3">
      <fieldset className="flex flex-wrap gap-2 sm:hidden">
        <legend className="sr-only">Rank by</legend>
        {table.columns.map((column) => (
          <button
            key={column.key}
            type="button"
            aria-pressed={column.key === sortKey}
            onClick={() => setSortKey(column.key)}
            className={cn(
              "min-h-11 rounded-lg border px-3 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring",
              column.key === sortKey
                ? "border-brand bg-brand text-brand-foreground"
                : "bg-background hover:bg-muted",
            )}
          >
            {column.label}
          </button>
        ))}
      </fieldset>
      <p aria-live="polite" className="sr-only">
        Ranked by {label.toLowerCase()}, highest first.
      </p>

      {/* The shadcn Table primitives without its `overflow-x-auto` wrapper,
          which would make its own scroll box and stop the header sticking.
          The table fits the page at every width (columns hide on a phone). */}
      <table
        data-slot="table"
        className="w-full border-separate border-spacing-0 text-sm [&_td]:border-b"
      >
        <caption className="sr-only">
          Cambridge colleges ranked by {label.toLowerCase()}, highest first. Column headers sort the
          table.
        </caption>
        <TableHeader className={STICKY_HEAD}>
          <TableRow className="border-0 hover:bg-transparent">
            <TableHead
              scope="col"
              className="h-auto w-8 px-0 py-2 pr-2 font-mono text-xs font-medium"
            >
              <span aria-hidden>#</span>
              <span className="sr-only">Rank</span>
            </TableHead>
            <TableHead
              scope="col"
              className="h-auto px-0 py-2 pr-3 text-xs font-semibold tracking-[0.06em] text-muted-foreground uppercase"
            >
              College
            </TableHead>
            {table.columns.map((column) => (
              <TableHead
                key={column.key}
                scope="col"
                aria-sort={column.key === sortKey ? "descending" : undefined}
                className={cn(
                  "h-auto px-0 py-1 pl-3 text-right whitespace-normal",
                  column.key === sortKey ? "table-cell" : "hidden sm:table-cell",
                )}
              >
                <button
                  type="button"
                  onClick={() => setSortKey(column.key)}
                  className={cn(
                    "inline-flex min-h-11 items-center justify-end gap-1 text-right text-xs font-semibold tracking-[0.06em] uppercase transition-colors focus-visible:outline-2 focus-visible:outline-ring sm:min-h-8",
                    column.key === sortKey
                      ? "text-brand-text"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <span className="sr-only">Rank by </span>
                  {column.label}
                  {column.key === sortKey ? (
                    <ArrowDownIcon aria-hidden className="size-3.5 shrink-0" />
                  ) : (
                    <ArrowUpDownIcon aria-hidden className="size-3.5 shrink-0 opacity-60" />
                  )}
                </button>
              </TableHead>
            ))}
            <TableHead
              scope="col"
              className="hidden h-auto px-0 py-2 pl-3 text-right text-xs font-semibold tracking-[0.06em] text-muted-foreground uppercase md:table-cell"
            >
              Source
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, index) => (
            <WealthRow
              key={row.slug}
              row={row}
              rank={index + 1}
              sortKey={sortKey}
              scale={scale}
              columns={table.columns}
            />
          ))}
        </TableBody>
      </table>

      {cut.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {cut.map((row) => (
            <span key={row.slug}>
              {row.shortName}’s bar is cut off: to scale it would be{" "}
              <span className="font-mono tabular-nums">
                {(Math.abs(row.values[sortKey]) / scale).toFixed(1)}
              </span>{" "}
              times as long as the next college’s.{" "}
            </span>
          ))}
        </p>
      )}
    </div>
  )
}

function WealthRow({
  row,
  rank,
  sortKey,
  scale,
  columns,
}: {
  row: WealthTableRow
  rank: number
  sortKey: WealthSortKey
  scale: number
  columns: WealthTable["columns"]
}) {
  const summary = columns
    .filter((column) => column.key !== sortKey)
    .map((column) => SUMMARY[column.key](row.display[column.key]))
  return (
    <TableRow className="align-top">
      <TableCell className="px-0 py-3 pr-2 align-top font-mono text-xs text-muted-foreground tabular-nums">
        {rank}
      </TableCell>
      <TableCell className="px-0 py-3 pr-3 align-top whitespace-normal">
        <div className="flex items-center gap-3">
          <CollegeCrest crest={row.crest} size={32} decorative />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Link href={row.href} className={cn("font-medium", LINK)}>
              {row.shortName}
            </Link>
            <CollegeWealthBar value={row.values[sortKey]} scale={scale} />
            <p className="font-mono text-xs text-muted-foreground tabular-nums sm:hidden">
              {summary.join(" · ")} ·{" "}
              <ExternalLink href={row.sourceUrl} className="underline" icon={false}>
                {row.sourcePage}
                <span className="sr-only">: {row.sourceRef}</span>
              </ExternalLink>
            </p>
          </div>
        </div>
      </TableCell>
      {columns.map((column) => (
        <TableCell
          key={column.key}
          className={cn(
            "px-0 py-3 pl-3 text-right align-top font-mono tabular-nums",
            column.key === sortKey
              ? "table-cell font-medium text-foreground"
              : "hidden text-muted-foreground sm:table-cell",
          )}
        >
          {row.display[column.key]}
        </TableCell>
      ))}
      <TableCell className="hidden px-0 py-3 pl-3 text-right align-top text-xs md:table-cell">
        <ExternalLink href={row.sourceUrl} className="underline">
          <span title={row.sourceRef}>Accounts, {row.sourcePage}</span>
          <span className="sr-only">: {row.sourceRef}</span>
        </ExternalLink>
      </TableCell>
    </TableRow>
  )
}
