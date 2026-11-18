/**
 * One headline figure on /colleges/wealth: a mono number over a short label,
 * with a line saying what it is.
 */
export function CollegeWealthStat({
  label,
  value,
  note,
}: {
  label: string
  value: string
  note: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1 border-t-2 border-foreground pt-3">
      <dt className="text-xs font-semibold tracking-[0.06em] text-muted-foreground uppercase">
        {label}
      </dt>
      <dd className="font-mono text-2xl font-medium tabular-nums sm:text-3xl">{value}</dd>
      <dd className="text-sm text-muted-foreground">{note}</dd>
    </div>
  )
}
