"use client"

import type { FunctionReturnType } from "convex/server"
import { RefreshCwIcon } from "lucide-react"
import { useState } from "react"
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { api } from "@/convex/_generated/api"
import { runWithToast, useBrokerTraffic, useRefreshTraffic } from "@/hooks/convex/broker"
import { formatDateTime } from "@/lib/broker/format"
import { DAY_MS, londonIsoDate } from "@/lib/calendar"

type Traffic = NonNullable<FunctionReturnType<typeof api.broker.overview.traffic>>
type Source = Traffic["posthog"] | Traffic["searchConsole"]

const count = new Intl.NumberFormat("en-GB")
const DAY_LABEL = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: "UTC",
})

function dayLabel(day: string): string {
  return DAY_LABEL.format(new Date(`${day}T00:00:00Z`))
}

/** Every day from `from` to `to` (ISO dates, inclusive). */
function daysBetween(from: string, to: string): string[] {
  const days: string[] = []
  for (
    let ms = Date.parse(`${from}T00:00:00Z`);
    ms <= Date.parse(`${to}T00:00:00Z`);
    ms += DAY_MS
  ) {
    days.push(new Date(ms).toISOString().slice(0, 10))
  }
  return days
}

/** The sources' state in a word, for the header badges. */
function SourceBadge({ name, source }: { name: string; source: Source | undefined }) {
  if (!source) return null
  const text =
    source.status === "ok"
      ? `${name} ${formatDateTime(source.fetchedAt)}`
      : source.status === "not_configured"
        ? `${name} not set up`
        : `${name} failed`
  return (
    <Badge
      variant={source.status === "failed" ? "destructive" : "outline"}
      className="font-mono"
      title={source.error}
    >
      {text}
    </Badge>
  )
}

/** Why a source shows no (or old) numbers. */
function SourceNote({ name, source, setup }: { name: string; source: Source; setup: string }) {
  if (source.status === "ok") return null
  if (source.status === "not_configured") {
    return (
      <p className="text-sm text-muted-foreground">
        {name} is not connected on this deployment: {setup} (docs/deploy.md “Website traffic”).
      </p>
    )
  }
  return (
    <p className="text-sm text-destructive">
      {name} could not be read ({source.error ?? "unknown error"}) at{" "}
      {formatDateTime(source.checkedAt)}
      {source.data ? `; showing the numbers from ${formatDateTime(source.fetchedAt)}.` : "."}
    </p>
  )
}

/**
 * One measure per day as thin bars on a zero baseline, every day of the
 * window present (a day without data is a zero). Hovering or focusing a bar
 * names its day and value in the caption; the table under it is the
 * accessible view.
 */
function DailyBars({
  days,
  values,
  unit,
  detail,
}: {
  days: string[]
  values: Map<string, number>
  unit: string
  detail?: (day: string) => string
}) {
  const [active, setActive] = useState<string | null>(null)
  const max = Math.max(1, ...days.map((day) => values.get(day) ?? 0))
  const shown = active ?? days.at(-1)
  const caption = shown
    ? `${dayLabel(shown)}: ${count.format(values.get(shown) ?? 0)} ${unit}${detail ? ` · ${detail(shown)}` : ""}`
    : ""
  return (
    <figure className="flex flex-col gap-2">
      <div
        className="flex h-28 items-end gap-0.5 border-b border-border"
        onMouseLeave={() => setActive(null)}
        aria-hidden="true"
      >
        {days.map((day) => {
          const value = values.get(day) ?? 0
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: hover only names a bar in the caption; the sr-only table is the accessible view
            <div
              key={day}
              className="group flex h-full flex-1 items-end"
              onMouseEnter={() => setActive(day)}
            >
              <div
                className={`w-full rounded-t-[4px] ${active === day ? "bg-primary" : "bg-primary/70"} ${value === 0 ? "h-px bg-border" : ""}`}
                style={value === 0 ? undefined : { height: `${(value / max) * 100}%` }}
              />
            </div>
          )
        })}
      </div>
      <figcaption className="flex justify-between gap-2 text-xs text-muted-foreground">
        <span aria-live="polite" className="font-mono tabular-nums">
          {caption}
        </span>
        <span className="shrink-0">max {count.format(max)}</span>
      </figcaption>
      <table className="sr-only">
        <caption>{unit} per day</caption>
        <tbody>
          {days.map((day) => (
            <tr key={day}>
              <th scope="row">{dayLabel(day)}</th>
              <td>{values.get(day) ?? 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  )
}

function NumberCell({ children }: { children: React.ReactNode }) {
  return <TableCell className="text-right font-mono tabular-nums">{children}</TableCell>
}

const CONSENTED = "Counts only visitors who accepted analytics, so it undercounts."

/** The server's kinds of source and page (lib/visit-count.ts), as read. */
const SOURCE_LABELS: Record<string, string> = {
  google: "Google",
  bing: "Bing",
  other_search: "Other search engines",
  ai_assistant: "AI assistants",
  social: "Social media",
  cambridge: "Cambridge sites (cam.ac.uk, SU)",
  internal: "Within CAMsocs",
  direct: "Direct / no referrer",
  other_site: "Other websites",
}
const PAGE_LABELS: Record<string, string> = {
  home: "Home",
  societies: "Society directory",
  society: "Society pages",
  categories: "Category hubs",
  events: "Events calendar",
  event: "Event pages",
  talks: "Talks",
  term_dates: "Term dates",
  info: "About, privacy, terms, request",
  other: "Other",
}

function KindTable({
  rows,
  heading,
  labels,
}: {
  rows: { kind: string; visits: number; visits7d: number }[]
  heading: string
  labels: Record<string, string>
}) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No page loads yet.</p>
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{heading}</TableHead>
          <TableHead className="text-right">30 days</TableHead>
          <TableHead className="text-right">7 days</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.kind}>
            <TableCell>{labels[row.kind] ?? row.kind}</TableCell>
            <NumberCell>{count.format(row.visits)}</NumberCell>
            <NumberCell>{count.format(row.visits7d)}</NumberCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

/**
 * The overview's website traffic: PostHog's consented visitors (last 30
 * days) and Google Search Console (28 days to yesterday), as the latest
 * `trafficSnapshots` row (convex/traffic.ts, refreshed hourly).
 */
export function BrokerTraffic() {
  const traffic = useBrokerTraffic()
  const refreshTraffic = useRefreshTraffic()
  const [refreshing, setRefreshing] = useState(false)

  const refresh = async () => {
    setRefreshing(true)
    await runWithToast(
      refreshTraffic({}),
      "Reading PostHog and Search Console — the numbers update shortly",
    )
    setRefreshing(false)
  }

  return <TrafficView traffic={traffic} onRefresh={refresh} refreshing={refreshing} />
}

/** The section itself, from a snapshot (`undefined` while loading, `null`
 * before the first read). */
export function TrafficView({
  traffic,
  onRefresh,
  refreshing,
}: {
  traffic: Traffic | null | undefined
  onRefresh: () => void
  refreshing: boolean
}) {
  const posthog = traffic?.posthog.data
  const gsc = traffic?.searchConsole.data
  const server = posthog?.serverVisits
  const now = traffic?.computedAt ?? Date.now()
  // Loaded, but neither source has numbers: the notes above say why.
  const empty = traffic !== undefined && !posthog && !gsc

  const posthogDays = posthog
    ? daysBetween(londonIsoDate(now - (posthog.windowDays - 1) * DAY_MS), londonIsoDate(now))
    : []
  const visitorsByDay = new Map(posthog?.daily.map((d) => [d.day, d.visitors]))
  const pageviewsByDay = new Map(posthog?.daily.map((d) => [d.day, d.pageviews]))
  const gscDays = gsc ? daysBetween(gsc.startDate, gsc.endDate) : []
  const loadsByDay = new Map(server?.daily.map((d) => [d.day, d.visits]))
  const clicksByDay = new Map(gsc?.daily.map((d) => [d.day, d.clicks]))
  const impressionsByDay = new Map(gsc?.daily.map((d) => [d.day, d.impressions]))

  return (
    <section aria-labelledby="traffic-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2 border-b-2 border-foreground pb-1">
        <div>
          <h2 id="traffic-heading" className="font-serif text-xl">
            Website traffic
          </h2>
          <p className="text-sm text-muted-foreground">
            Page loads counted by our server and consented visitors from PostHog (last 30 days),
            Google Search from Search Console (28 days to yesterday).
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SourceBadge name="PostHog" source={traffic?.posthog} />
          <SourceBadge name="Search Console" source={traffic?.searchConsole} />
          <Button size="sm" variant="outline" onClick={onRefresh} disabled={refreshing}>
            <RefreshCwIcon className={refreshing ? "animate-spin" : undefined} />
            Refresh traffic
          </Button>
        </div>
      </div>

      {traffic === null && (
        <p className="text-sm text-muted-foreground">
          Not read yet: it is read hourly — or now, with “Refresh traffic”.
        </p>
      )}
      {traffic && (
        <>
          <SourceNote
            name="PostHog"
            source={traffic.posthog}
            setup="set POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID"
          />
          <SourceNote
            name="Search Console"
            source={traffic.searchConsole}
            setup="set GSC_CLIENT_ID, GSC_CLIENT_SECRET and GSC_REFRESH_TOKEN"
          />
        </>
      )}

      {!empty && (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
            {traffic === undefined ? (
              [0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)
            ) : (
              <>
                <StatTile
                  emphasis
                  label="Page loads, 30 days"
                  value={server ? count.format(server.visits) : "—"}
                  hint={
                    server
                      ? `${count.format(server.visits7d)} in 7 days · every visitor, counted by our server`
                      : "server count"
                  }
                />
                <StatTile
                  label="Visitors, 30 days"
                  value={posthog ? count.format(posthog.visitors) : "—"}
                  hint={
                    posthog
                      ? `${count.format(posthog.visitors7d)} in the last 7 days · consented only`
                      : "PostHog"
                  }
                />
                <StatTile
                  label="Pageviews, 30 days"
                  value={posthog ? count.format(posthog.pageviews) : "—"}
                  hint={
                    posthog
                      ? `${count.format(posthog.pageviews7d)} in 7 days · ${count.format(posthog.sessions)} sessions`
                      : "PostHog"
                  }
                />
                <StatTile
                  label="Google clicks, 28 days"
                  value={gsc ? count.format(gsc.clicks) : "—"}
                  hint={gsc ? `${count.format(gsc.impressions)} impressions` : "Search Console"}
                />
                <StatTile
                  label="Google CTR"
                  value={gsc ? `${(gsc.ctr * 100).toFixed(1)}%` : "—"}
                  hint={gsc ? "clicks ÷ impressions" : "Search Console"}
                />
                <StatTile
                  label="Average position"
                  value={gsc && gsc.impressions > 0 ? gsc.position.toFixed(1) : "—"}
                  hint={gsc ? "in Google results (1 = top)" : "Search Console"}
                />
              </>
            )}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Visitors per day</CardTitle>
                <CardDescription>Unique visitors, London days. {CONSENTED}</CardDescription>
              </CardHeader>
              <CardContent>
                {posthog ? (
                  <DailyBars
                    days={posthogDays}
                    values={visitorsByDay}
                    unit="visitors"
                    detail={(day) => `${count.format(pageviewsByDay.get(day) ?? 0)} pageviews`}
                  />
                ) : traffic === undefined ? (
                  <Skeleton className="h-36" />
                ) : (
                  <p className="text-sm text-muted-foreground">No PostHog numbers yet.</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Google search clicks per day</CardTitle>
                <CardDescription>
                  Clicks from Google Search to the site; the last days are not final yet.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {gsc ? (
                  <DailyBars
                    days={gscDays}
                    values={clicksByDay}
                    unit="clicks"
                    detail={(day) => `${count.format(impressionsByDay.get(day) ?? 0)} impressions`}
                  />
                ) : traffic === undefined ? (
                  <Skeleton className="h-36" />
                ) : (
                  <p className="text-sm text-muted-foreground">No Search Console numbers yet.</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Where visitors come from</CardTitle>
                <CardDescription>
                  Sessions by the site they arrived from; “direct” is typed, bookmarked or an app
                  that sends no referrer. {CONSENTED}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {posthog ? (
                  posthog.referrers.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No sessions yet.</p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Source</TableHead>
                          <TableHead className="text-right">Sessions</TableHead>
                          <TableHead className="text-right">Visitors</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {posthog.referrers.map((row) => (
                          <TableRow key={row.domain}>
                            <TableCell className="max-w-56 truncate">
                              {row.domain === "$direct" ? (
                                <span className="text-muted-foreground">direct</span>
                              ) : (
                                row.domain
                              )}
                            </TableCell>
                            <NumberCell>{count.format(row.sessions)}</NumberCell>
                            <NumberCell>{count.format(row.visitors)}</NumberCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )
                ) : traffic === undefined ? (
                  <Skeleton className="h-40" />
                ) : (
                  <p className="text-sm text-muted-foreground">No PostHog numbers yet.</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Google search terms</CardTitle>
                <CardDescription>
                  What people searched for when the site appeared in Google, by clicks. Google
                  leaves out rare searches.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {gsc ? (
                  <Tabs defaultValue="queries">
                    <TabsList>
                      <TabsTrigger value="queries">Search terms</TabsTrigger>
                      <TabsTrigger value="pages">Landing pages</TabsTrigger>
                    </TabsList>
                    <TabsContent value="queries">
                      <SearchTable
                        rows={gsc.queries.map((row) => ({ label: row.query, ...row }))}
                        heading="Search term"
                        empty="No search terms in this window yet."
                      />
                    </TabsContent>
                    <TabsContent value="pages">
                      <SearchTable
                        rows={gsc.pages.map((row) => ({ label: row.path, ...row }))}
                        heading="Page"
                        empty="No pages in Google results in this window yet."
                      />
                    </TabsContent>
                  </Tabs>
                ) : traffic === undefined ? (
                  <Skeleton className="h-40" />
                ) : (
                  <p className="text-sm text-muted-foreground">No Search Console numbers yet.</p>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Page loads, every visitor</CardTitle>
              <CardDescription>
                Counted by our server, so no consent is needed and nothing is stored in the browser:
                each page a browser loads from us (not clicks inside the site), by the kind of site
                it came from. Known bots are left out.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {server ? (
                <>
                  <DailyBars days={posthogDays} values={loadsByDay} unit="page loads" />
                  <Tabs defaultValue="sources">
                    <TabsList>
                      <TabsTrigger value="sources">Where from</TabsTrigger>
                      <TabsTrigger value="pages">Which pages</TabsTrigger>
                    </TabsList>
                    <TabsContent value="sources">
                      <KindTable
                        rows={server.sources.map((row) => ({ kind: row.source, ...row }))}
                        heading="Came from"
                        labels={SOURCE_LABELS}
                      />
                    </TabsContent>
                    <TabsContent value="pages">
                      <KindTable
                        rows={server.pages.map((row) => ({ kind: row.page, ...row }))}
                        heading="Kind of page"
                        labels={PAGE_LABELS}
                      />
                    </TabsContent>
                  </Tabs>
                </>
              ) : traffic === undefined ? (
                <Skeleton className="h-36" />
              ) : (
                <p className="text-sm text-muted-foreground">
                  No server count yet: it starts with the first page load after this release and
                  shows at the next hourly read.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Top pages</CardTitle>
              <CardDescription>Pageviews by path, last 30 days. {CONSENTED}</CardDescription>
            </CardHeader>
            <CardContent>
              {posthog ? (
                posthog.pages.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No pageviews yet.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Path</TableHead>
                        <TableHead className="text-right">Pageviews</TableHead>
                        <TableHead className="text-right">Visitors</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {posthog.pages.map((row) => (
                        <TableRow key={row.path}>
                          <TableCell className="max-w-md truncate font-mono text-xs">
                            {row.path}
                          </TableCell>
                          <NumberCell>{count.format(row.pageviews)}</NumberCell>
                          <NumberCell>{count.format(row.visitors)}</NumberCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )
              ) : traffic === undefined ? (
                <Skeleton className="h-32" />
              ) : (
                <p className="text-sm text-muted-foreground">No PostHog numbers yet.</p>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </section>
  )
}

function SearchTable({
  rows,
  heading,
  empty,
}: {
  rows: { label: string; clicks: number; impressions: number; ctr: number; position: number }[]
  heading: string
  empty: string
}) {
  if (rows.length === 0) return <p className="pt-2 text-sm text-muted-foreground">{empty}</p>
  return (
    <div className="max-h-96 overflow-y-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{heading}</TableHead>
            <TableHead className="text-right">Clicks</TableHead>
            <TableHead className="text-right">Impr.</TableHead>
            <TableHead className="hidden text-right sm:table-cell">CTR</TableHead>
            <TableHead className="text-right">Pos.</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.label}>
              <TableCell className="max-w-56 truncate" title={row.label}>
                {row.label}
              </TableCell>
              <NumberCell>{count.format(row.clicks)}</NumberCell>
              <NumberCell>{count.format(row.impressions)}</NumberCell>
              <TableCell className="hidden text-right font-mono tabular-nums sm:table-cell">
                {(row.ctr * 100).toFixed(1)}%
              </TableCell>
              <NumberCell>{row.position.toFixed(1)}</NumberCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
