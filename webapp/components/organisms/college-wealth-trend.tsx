import Link from "next/link"
import type { TrendPoint } from "@/lib/college-finances"
import { formatGbp, formatPct, NO_FIGURE } from "@/lib/college-wealth"
import { type TrendRow, trendRows, trendTotals, type WealthView } from "@/lib/college-wealth-view"
import { collegeHubPath } from "@/lib/directory-hubs"

/**
 * How each college's endowment changed over the years the data holds
 * (/colleges/wealth, ENG-272): a server-rendered table, one row per college
 * in ranking order, one column per financial year, and the change from the
 * first year to the last. The shown year and the one before come from the
 * accounts; earlier years from the Charity Commission register, marked. A
 * year without an accepted figure is a dash, never estimated. The small line
 * beside each name repeats the row's numbers for the eye (hidden from screen
 * readers, which read the cells).
 */

const TH =
  "px-2 py-2 text-right text-xs font-semibold tracking-[0.06em] text-muted-foreground uppercase whitespace-nowrap"

export function CollegeWealthTrend({ view }: { view: WealthView }) {
  const rows = trendRows(view)
  const totals = trendTotals(view)
  const years = view.trendYears
  const first = years[0]
  const fromRegister = rows.some((row) =>
    row.cells.some((cell) => cell && cell.basis !== "verified"),
  )
  return (
    <div className="flex flex-col gap-3">
      {/* Wider than a phone: a scroll box keyboard users can reach and scroll. */}
      <section
        aria-label={`Endowments by year, ${first} to ${years.at(-1)}`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be focusable to scroll by keyboard (WCAG 2.1.1)
        tabIndex={0}
        className="overflow-x-auto rounded-xl border focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <table className="w-full text-sm">
          <caption className="sr-only">
            Each college’s endowment by financial year, {first} to {years.at(-1)}, in ranking order
          </caption>
          <thead className="border-b bg-muted/40">
            <tr>
              <th scope="col" className={`${TH} text-left`}>
                College
              </th>
              {years.map((year) => (
                <th key={year} scope="col" className={TH}>
                  {year}
                </th>
              ))}
              {years.length > 1 && (
                <th scope="col" className={TH}>
                  Since {first}
                </th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row) => (
              <TrendTableRow key={row.row.slug} row={row} withChange={years.length > 1} />
            ))}
          </tbody>
          {totals.some((total) => total !== null) && (
            <tfoot className="border-t-2 border-foreground">
              <tr>
                <th scope="row" className="px-2 py-2 text-left font-medium">
                  All {view.rows.length} colleges
                </th>
                {totals.map((total, index) => (
                  <td key={years[index]} className="px-2 py-2 text-right font-mono tabular-nums">
                    {total === null ? NO_FIGURE : formatGbp(total)}
                  </td>
                ))}
                {years.length > 1 && <td />}
              </tr>
            </tfoot>
          )}
        </table>
      </section>
      <p className="text-xs text-muted-foreground">
        {view.financialYear === view.verifiedYear
          ? `${view.verifiedYear} and the year before: read from each college’s accounts.`
          : `${view.verifiedYear} and the year before: read from each college’s accounts; later years as filed with the Charity Commission.`}
        {fromRegister
          ? " Figures marked * are as filed in the college’s annual return on the Charity Commission register."
          : ""}{" "}
        {NO_FIGURE} means no figure for that year: not filed, or held back because it failed a check
        and has not been reviewed. A total is given only for years every college has a figure.
      </p>
    </div>
  )
}

function TrendTableRow({ row, withChange }: { row: TrendRow; withChange: boolean }) {
  return (
    <tr>
      <th scope="row" className="px-2 py-2 text-left font-normal">
        <span className="flex items-center gap-3">
          <Sparkline cells={row.cells} />
          <Link
            href={collegeHubPath(row.row.college)}
            className="underline-offset-4 hover:underline"
          >
            {row.row.college.shortName}
          </Link>
        </span>
      </th>
      {row.cells.map((cell, index) => (
        <td
          // biome-ignore lint/suspicious/noArrayIndexKey: one cell per year, in order
          key={index}
          className="px-2 py-2 text-right font-mono whitespace-nowrap text-muted-foreground tabular-nums"
        >
          {cell === null ? NO_FIGURE : formatGbp(cell.endowmentGbp)}
          {cell && cell.basis !== "verified" ? (
            <>
              <span aria-hidden>*</span>
              <span className="sr-only"> (register)</span>
            </>
          ) : null}
        </td>
      ))}
      {withChange && (
        <td className="px-2 py-2 text-right font-mono whitespace-nowrap tabular-nums">
          {row.changePct === null ? NO_FIGURE : formatPct(row.changePct)}
        </td>
      )}
    </tr>
  )
}

/** The row's figures as a small line, scaled to its own range. */
function Sparkline({ cells }: { cells: readonly (TrendPoint | null)[] }) {
  const width = 56
  const height = 18
  const points = cells
    .map((cell, index) => (cell ? { index, value: cell.endowmentGbp } : null))
    .filter((point): point is { index: number; value: number } => point !== null)
  if (points.length < 2 || cells.length < 2) return <span aria-hidden className="w-14 shrink-0" />
  const values = points.map((point) => point.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const x = (index: number) => (index / (cells.length - 1)) * (width - 4) + 2
  const y = (value: number) => height - 2 - ((value - min) / range) * (height - 4)
  const d = points
    .map(
      (point, i) =>
        `${i === 0 ? "M" : "L"}${x(point.index).toFixed(1)},${y(point.value).toFixed(1)}`,
    )
    .join(" ")
  return (
    <svg
      aria-hidden
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="shrink-0 text-brand-text"
    >
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  )
}
