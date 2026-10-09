"use client"

import { RefreshCwIcon } from "lucide-react"
import Link from "next/link"
import { useState } from "react"
import { BrokerPageHeader } from "@/components/molecules/broker-page-header"
import { StatTile } from "@/components/molecules/stat-tile"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { runWithToast, useBrokerSummary, useRefreshCoverage } from "@/hooks/convex/broker"
import { COVERAGE_FIELDS } from "@/lib/broker/coverage"
import {
  capitalise,
  EVENT_SOURCE_LABELS,
  formatDateTime,
  humanize,
  percent,
} from "@/lib/broker/format"
import { fieldLabel } from "@/lib/broker/outreach"
import { ORG_LEVELS, ORG_STATUSES } from "@/lib/vocab"

const COVERAGE_LABELS: Record<(typeof COVERAGE_FIELDS)[number], string> = {
  email: "Contact address",
  website: "Website",
  instagram: "Instagram",
  description: "Description",
}

const NOT_COMPUTED = (
  <p className="text-sm text-muted-foreground">Not computed yet — refresh the coverage.</p>
)

const RUN_STATUS_VARIANT = {
  success: "secondary",
  running: "outline",
  partial: "outline",
  failed: "destructive",
} as const

/** A thin single-hue bar for a 0..1 share. Decorative: the number beside it is
 * the accessible value. */
function Meter({ share, label }: { share: number; label: string }) {
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      aria-hidden="true"
      title={`${label}: ${percent(share)}`}
    >
      <div className="h-full rounded-full bg-primary" style={{ width: `${share * 100}%` }} />
    </div>
  )
}

/**
 * The broker's overview. Every number is computed on the server
 * (`broker.overview.summary`): directory coverage is the latest snapshot
 * convex/coverage.ts folds over every organisation a page at a time (after
 * each pipeline run, daily, or on "Refresh"), and the quarantine is what the
 * pipeline's last resolve stage reported.
 */
export function BrokerOverview() {
  const summary = useBrokerSummary()
  const refreshCoverage = useRefreshCoverage()
  const [refreshing, setRefreshing] = useState(false)
  const stats = summary?.coverage?.stats
  // Only the statuses that occur, so the table fits a narrow card.
  const statuses = ORG_STATUSES.filter((status) => stats?.byStatus[status])

  const refresh = async () => {
    setRefreshing(true)
    await runWithToast(refreshCoverage({}), "Recomputing coverage — the numbers update shortly")
    setRefreshing(false)
  }

  return (
    <>
      <BrokerPageHeader
        title="Overview"
        description="Directory coverage, upcoming events, pipeline runs and what needs attention."
      >
        {summary?.coverage && (
          <Badge variant="outline" className="font-mono">
            coverage {formatDateTime(summary.coverage.computedAt)}
          </Badge>
        )}
        <Button size="sm" variant="outline" onClick={refresh} disabled={refreshing}>
          <RefreshCwIcon className={refreshing ? "animate-spin" : undefined} />
          Refresh coverage
        </Button>
      </BrokerPageHeader>

      {summary && !summary.coverage && (
        <p className="text-sm text-muted-foreground">
          No coverage computed yet: it is computed after each pipeline run and daily — or now, with
          “Refresh coverage”.
        </p>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-5">
        {summary ? (
          <>
            <StatTile
              emphasis
              label="Listed organisations"
              value={stats ? stats.total : "…"}
              hint={
                stats
                  ? `${stats.byStatus.active ?? 0} active · ${stats.hidden} hidden · ${stats.counterparts} counterpart${stats.counterparts === 1 ? "" : "s"}`
                  : ""
              }
            />
            <StatTile
              label="Events, next 14 days"
              value={summary.events.total}
              hint={`${summary.events.byVisibility.cam_only ?? 0} Cambridge-only`}
            />
            <StatTile
              label="Open requests"
              value={summary.openRequests.total}
              hint={
                <Link className="underline-offset-4 hover:underline" href="/dashboard/requests">
                  {summary.openRequests.byKind.remove ?? 0} removal ·{" "}
                  {summary.openRequests.byKind.object ?? 0} objection
                </Link>
              }
            />
            <StatTile
              label="Follow-ups due"
              value={summary.followUpsDue}
              hint={`${summary.stalePeople} stale contacts`}
            />
            <StatTile
              label="Quarantined"
              value={summary.quarantine ? summary.quarantine.held : "—"}
              hint={
                summary.quarantine
                  ? `${summary.quarantine.review} to review · ${summary.quarantine.dropped} dropped · run ${formatDateTime(summary.quarantine.startedAt)}`
                  : "No resolve stage reported yet"
              }
            />
          </>
        ) : (
          [0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Field coverage</CardTitle>
            <CardDescription>Share of listed organisations holding each field.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {stats
              ? COVERAGE_FIELDS.map((field) => (
                  <div key={field} className="flex flex-col gap-1.5">
                    <div className="flex items-baseline justify-between text-sm">
                      <span>{COVERAGE_LABELS[field]}</span>
                      <span className="font-mono tabular-nums">{percent(stats.share[field])}</span>
                    </div>
                    <Meter share={stats.share[field]} label={COVERAGE_LABELS[field]} />
                  </div>
                ))
              : summary === undefined
                ? [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-8" />)
                : NOT_COMPUTED}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>By level and status</CardTitle>
            <CardDescription>
              Listed organisations; status is derived daily. Empty statuses are left out.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {stats ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Level</TableHead>
                    {statuses.map((status) => (
                      <TableHead key={status} className="text-right">
                        {humanize(status)}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...ORG_LEVELS, "unknown"]
                    .filter((level) => stats.byLevel[level])
                    .map((level) => (
                      <TableRow key={level}>
                        <TableCell>{humanize(level)}</TableCell>
                        {statuses.map((status) => (
                          <TableCell key={status} className="text-right font-mono tabular-nums">
                            {stats.byLevelStatus[level]?.[status] ?? 0}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            ) : summary === undefined ? (
              <Skeleton className="h-40" />
            ) : (
              NOT_COMPUTED
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Events in the next 14 days</CardTitle>
            <CardDescription>By source (cancelled events left out).</CardDescription>
          </CardHeader>
          <CardContent>
            {summary ? (
              <Table>
                <TableBody>
                  {Object.entries(summary.events.bySource)
                    .filter(([, count]) => count > 0)
                    .sort((a, b) => b[1] - a[1])
                    .map(([source, count]) => (
                      <TableRow key={source}>
                        <TableCell>{EVENT_SOURCE_LABELS[source] ?? humanize(source)}</TableCell>
                        <TableCell className="text-right font-mono tabular-nums">{count}</TableCell>
                      </TableRow>
                    ))}
                  {summary.events.total === 0 && (
                    <TableRow>
                      <TableCell className="text-muted-foreground">
                        No events harvested for the next two weeks yet.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            ) : (
              <Skeleton className="h-40" />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Most often missing</CardTitle>
            <CardDescription>
              Tracked fields listed organisations lack —{" "}
              <Link href="/dashboard/reports" className="underline-offset-4 hover:underline">
                the outreach report
              </Link>
              .
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {stats ? (
              stats.missingTop.slice(0, 8).map(({ field, count }) => (
                <div key={field} className="flex flex-col gap-1">
                  <div className="flex items-baseline justify-between text-sm">
                    <span>{capitalise(fieldLabel(field))}</span>
                    <span className="font-mono tabular-nums text-muted-foreground">{count}</span>
                  </div>
                  <Meter share={stats.total ? count / stats.total : 0} label={fieldLabel(field)} />
                </div>
              ))
            ) : summary === undefined ? (
              <Skeleton className="h-40" />
            ) : (
              NOT_COMPUTED
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Latest pipeline runs</CardTitle>
          <CardDescription>
            What the harvester last did (
            <code className="font-mono">pixi run pipeline -- sync</code>).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {summary ? (
            summary.runs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No runs recorded yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Started</TableHead>
                    <TableHead>Command</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden md:table-cell">Stages</TableHead>
                    <TableHead className="text-right">Written</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {summary.runs.map((run) => (
                    <TableRow key={run.runKey}>
                      <TableCell className="font-mono text-xs">
                        {formatDateTime(run.startedAt)}
                      </TableCell>
                      <TableCell>{run.command}</TableCell>
                      <TableCell>
                        <Badge variant={RUN_STATUS_VARIANT[run.status]}>{run.status}</Badge>
                      </TableCell>
                      <TableCell className="hidden max-w-xs truncate text-xs text-muted-foreground md:table-cell">
                        {run.stages.map((stage) => `${stage.name} ${stage.status}`).join(" · ")}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {run.stages.reduce((sum, stage) => sum + stage.inserted + stage.updated, 0)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )
          ) : (
            <Skeleton className="h-32" />
          )}
        </CardContent>
      </Card>
    </>
  )
}
