"use client"

import type { FunctionReturnType } from "convex/server"
import { Badge } from "@/components/ui/badge"
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
import type { api } from "@/convex/_generated/api"
import { useIndexingSummary } from "@/hooks/convex/broker"
import { formatDateTime } from "@/lib/broker/format"

/**
 * "Google indexing" on the broker overview (convex/indexing.ts): the daily
 * check's counts per kind of page, the pages Google cannot index as they
 * stand (a bug of ours; the VPS monitor pages on them too), the key pages
 * still waiting after ten days (worth a "Request indexing" in Search
 * Console, a few a day), and how Google reads the sitemaps.
 */

type Summary = NonNullable<FunctionReturnType<typeof api.indexing.summary>>

const KIND_LABELS = { page: "Pages", hub: "Category hubs", society: "Societies", event: "Events" }
const count = new Intl.NumberFormat("en-GB")

function pathOf(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

const STATE_LABEL = {
  indexed: "indexed",
  waiting: "waiting for Google",
  not_indexed: "crawled, not indexed",
  problem: "problem",
  unchecked: "not checked yet",
} as const

export function IndexingView({ summary }: { summary: Summary | null | undefined }) {
  return (
    <section aria-labelledby="indexing-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2 border-b-2 border-foreground pb-1">
        <div>
          <h2 id="indexing-heading" className="font-serif text-xl">
            Google indexing
          </h2>
          <p className="text-sm text-muted-foreground">
            What Google says about every URL our sitemaps list, checked daily at 07:00 UTC through
            Search Console (key pages every day, the rest every few days).
          </p>
        </div>
        {summary && (
          <Badge variant={summary.alerts.length > 0 ? "destructive" : "secondary"}>
            {summary.alerts.length > 0 ? `${summary.alerts.length} to fix` : "Nothing to fix"} ·{" "}
            {formatDateTime(summary.runAt)}
          </Badge>
        )}
      </div>

      {summary === undefined && <Skeleton className="h-40" />}
      {summary === null && (
        <p className="text-sm text-muted-foreground">
          Not checked yet: the first check runs at 07:00 UTC.
        </p>
      )}
      {summary && (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Kind</TableHead>
                <TableHead className="text-right">Indexed</TableHead>
                <TableHead className="text-right">Waiting</TableHead>
                <TableHead className="text-right">Crawled, not indexed</TableHead>
                <TableHead className="text-right">Problems</TableHead>
                <TableHead className="text-right">Not checked yet</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(Object.keys(KIND_LABELS) as (keyof typeof KIND_LABELS)[]).map((kind) => {
                const c = summary.counts[kind]
                return (
                  <TableRow key={kind}>
                    <TableCell>{KIND_LABELS[kind]}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {count.format(c.indexed)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {count.format(c.waiting)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {count.format(c.not_indexed)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {count.format(c.problem)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {count.format(c.unchecked)}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Cannot be indexed</CardTitle>
                <CardDescription>
                  A page in our sitemaps that Google (or our own read) finds noindex, blocked,
                  missing, redirected or canonical to another URL. Always a bug to fix.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {summary.problems.length === 0 ? (
                  <p className="text-sm text-muted-foreground">None.</p>
                ) : (
                  <ul className="flex flex-col gap-2 text-sm">
                    {summary.problems.map((p) => (
                      <li key={p.url}>
                        <a href={p.url} className="font-mono underline-offset-4 hover:underline">
                          {pathOf(p.url)}
                        </a>
                        <span className="block text-muted-foreground">{p.problem}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Key pages still waiting</CardTitle>
                <CardDescription>
                  Pages and hubs listed for over ten days that Google has not indexed. In Search
                  Console, inspect each and press “Request indexing” (a few a day).
                </CardDescription>
              </CardHeader>
              <CardContent>
                {summary.lagging.length === 0 ? (
                  <p className="text-sm text-muted-foreground">None.</p>
                ) : (
                  <ul className="flex flex-col gap-2 text-sm">
                    {summary.lagging.map((l) => (
                      <li key={l.url}>
                        <span className="font-mono">{pathOf(l.url)}</span>
                        <span className="block text-muted-foreground">
                          {STATE_LABEL[l.state]}, listed since {formatDateTime(l.listedSince)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>

          <p className="text-sm text-muted-foreground">
            Sitemaps:{" "}
            {summary.sitemaps.length === 0
              ? "status not read."
              : summary.sitemaps
                  .map(
                    (s) =>
                      `${s.path} ${s.issue ?? (s.lastDownloaded ? `read ${formatDateTime(s.lastDownloaded)}` : "")}`,
                  )
                  .join(" · ")}
            . {count.format(summary.inspected)} URLs inspected in the last run.
          </p>
        </>
      )}
    </section>
  )
}

export function BrokerIndexing() {
  return <IndexingView summary={useIndexingSummary()} />
}
