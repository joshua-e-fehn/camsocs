"use client"

import { CopyIcon, DownloadIcon, FileTextIcon } from "lucide-react"
import Link from "next/link"
import { useMemo, useState } from "react"
import { toast } from "sonner"
import { BrokerPageHeader } from "@/components/molecules/broker-page-header"
import { StatTile } from "@/components/molecules/stat-tile"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { type BrokerOrgRow, useAllBrokerOrgRows } from "@/hooks/convex/broker"
import { humanize, todayIso } from "@/lib/broker/format"
import { fieldLabel, isOutreachCandidate, outreachCsv, outreachNotice } from "@/lib/broker/outreach"

type Scope = "address" | "no_address" | "complete"

const STEP = 100

/** The public origin the notices link to: this deployment's own. */
const siteUrl = () => (typeof window === "undefined" ? "" : window.location.origin)

/**
 * The missing-data report and the phase-2 outreach export (PLAN §2.4). The
 * CSV holds one row per listed, non-suppressed organisation with a published
 * non-personal address: what is missing, and a personalised notice that is
 * also the Art 14 notice. Export only — nothing is sent from here.
 */
export function BrokerReports() {
  const { rows, complete } = useAllBrokerOrgRows()
  const [scope, setScope] = useState<Scope>("address")
  const [limit, setLimit] = useState(STEP)
  const [preview, setPreview] = useState<BrokerOrgRow | null>(null)

  const groups = useMemo(() => {
    if (!rows) return undefined
    const candidates = rows.filter(isOutreachCandidate)
    const incomplete = candidates.filter((row) => row.missingFields.length > 0)
    return {
      address: incomplete.filter((row) => row.bestAddress),
      no_address: incomplete.filter((row) => !row.bestAddress),
      complete: candidates.filter((row) => row.missingFields.length === 0),
      excluded: rows.filter((row) => !row.isCounterpart && !isOutreachCandidate(row)).length,
      withAddress: candidates.filter((row) => row.bestAddress).length,
    }
  }, [rows])

  const shown = useMemo(
    () =>
      groups?.[scope]
        .slice()
        .sort(
          (a, b) => b.missingFields.length - a.missingFields.length || a.name.localeCompare(b.name),
        ),
    [groups, scope],
  )

  const download = () => {
    if (!rows) return
    const csv = outreachCsv(rows, siteUrl())
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }))
    const link = document.createElement("a")
    link.href = url
    link.download = `camsocs-outreach-${todayIso()}.csv`
    link.click()
    URL.revokeObjectURL(url)
    toast.success(`Exported ${groups?.withAddress ?? 0} organisations`)
  }

  return (
    <>
      <BrokerPageHeader
        title="Missing data"
        description="What each listing lacks, and the phase-2 outreach export (also the Art 14 notice). Send by about 13 Nov 2026."
      >
        <Button onClick={download} disabled={!complete}>
          <DownloadIcon />
          {complete ? "Download outreach CSV" : "Loading…"}
        </Button>
      </BrokerPageHeader>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {groups ? (
          <>
            <StatTile
              emphasis
              label="In the export"
              value={groups.withAddress}
              hint="Listed, not suppressed, with an address"
            />
            <StatTile
              label="Missing data, no address"
              value={groups.no_address.length}
              hint="Need another route (form, socials)"
            />
            <StatTile label="Complete listings" value={groups.complete.length} />
            <StatTile
              label="Left out"
              value={groups.excluded}
              hint="Hidden or suppressed — never contacted"
            />
          </>
        ) : (
          ["a", "b", "c", "d"].map((key) => <Skeleton key={key} className="h-24 rounded-xl" />)
        )}
      </div>

      <ToggleGroup
        type="single"
        variant="outline"
        value={scope}
        onValueChange={(value) => {
          if (!value) return
          setScope(value as Scope)
          setLimit(STEP)
        }}
        aria-label="Which organisations"
      >
        <ToggleGroupItem value="address">Missing data, with address</ToggleGroupItem>
        <ToggleGroupItem value="no_address">No address</ToggleGroupItem>
        <ToggleGroupItem value="complete">Complete</ToggleGroupItem>
      </ToggleGroup>

      {shown === undefined ? (
        <Skeleton className="h-96 rounded-xl" />
      ) : shown.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          Nothing in this group.
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Organisation</TableHead>
                <TableHead className="text-right">Missing</TableHead>
                <TableHead className="hidden md:table-cell">Fields</TableHead>
                <TableHead className="hidden lg:table-cell">Address</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Notice</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.slice(0, limit).map((row) => (
                <TableRow key={row.key}>
                  <TableCell className="max-w-56 align-top">
                    <Link
                      href={`/dashboard/organisations?org=${row.key}`}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {row.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right align-top font-mono tabular-nums">
                    {row.missingFields.length}
                  </TableCell>
                  <TableCell className="hidden max-w-md align-top md:table-cell">
                    <div className="flex flex-wrap gap-1">
                      {row.missingFields.slice(0, 6).map((field) => (
                        <Badge key={field} variant="outline">
                          {fieldLabel(field)}
                        </Badge>
                      ))}
                      {row.missingFields.length > 6 && (
                        <Badge variant="ghost">+{row.missingFields.length - 6}</Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="hidden align-top text-xs lg:table-cell">
                    {row.bestAddress ? (
                      <>
                        <div className="font-mono">{row.bestAddress.email}</div>
                        <div className="text-muted-foreground">
                          {humanize(row.bestAddress.role)}
                        </div>
                      </>
                    ) : (
                      <span className="text-muted-foreground">none published</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right align-top">
                    <Button variant="ghost" size="sm" onClick={() => setPreview(row)}>
                      <FileTextIcon />
                      Notice
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {shown.length > limit && (
            <div className="flex justify-center border-t p-2">
              <Button variant="ghost" size="sm" onClick={() => setLimit((n) => n + STEP)}>
                Show more ({shown.length - limit} left)
              </Button>
            </div>
          )}
        </div>
      )}

      <Dialog open={preview !== null} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="sm:max-w-2xl">
          {preview && <NoticePreview row={preview} />}
        </DialogContent>
      </Dialog>
    </>
  )
}

function NoticePreview({ row }: { row: BrokerOrgRow }) {
  const text = outreachNotice(row, siteUrl())
  return (
    <>
      <DialogHeader>
        <DialogTitle>Notice for {row.name}</DialogTitle>
        <DialogDescription>
          {row.bestAddress
            ? `To ${row.bestAddress.email} (${humanize(row.bestAddress.role).toLowerCase()}). Send it yourself; nothing is sent from here.`
            : "No published address: this listing is not in the export."}
        </DialogDescription>
      </DialogHeader>
      <pre className="max-h-96 overflow-auto rounded-lg border bg-muted/40 p-4 font-sans text-sm whitespace-pre-wrap">
        {text}
      </pre>
      <div>
        <Button
          variant="outline"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text)
              toast.success("Copied")
            } catch {
              toast.error("Copy failed; select the text instead")
            }
          }}
        >
          <CopyIcon />
          Copy text
        </Button>
      </div>
    </>
  )
}
