"use client"

import { ArrowDownWideNarrowIcon, EyeOffIcon, SearchIcon } from "lucide-react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useDeferredValue, useMemo, useState } from "react"
import { BrokerPageHeader } from "@/components/molecules/broker-page-header"
import { NeedOfferChips } from "@/components/molecules/need-offer-chips"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { type BrokerOrgRow, useAllBrokerOrgRows } from "@/hooks/convex/broker"
import { formatDate, humanize } from "@/lib/broker/format"
import { ORG_LEVELS, ORG_STATUSES } from "@/lib/vocab"

type Scope = "listed" | "counterparts" | "hidden" | "all"
type Sort = "name" | "missing" | "updated"

const STEP = 50
const SKELETON_ROWS = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"]
const ANY = "any"

function inScope(row: BrokerOrgRow, scope: Scope): boolean {
  if (scope === "all") return true
  if (scope === "hidden") return row.hidden
  if (scope === "counterparts") return row.isCounterpart
  return !row.isCounterpart && !row.hidden
}

/**
 * Every organisation, filterable and sortable in the browser (the rows are
 * small and all loaded). A row opens the detail drawer (`BrokerOrgDrawer`,
 * rendered beside this by the page) through the URL — `?org=<key>` — so other
 * pages can link straight to an organisation.
 */
export function BrokerOrgTable() {
  const { rows, complete } = useAllBrokerOrgRows()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const openKey = searchParams.get("org")

  const [query, setQuery] = useState("")
  const deferredQuery = useDeferredValue(query)
  const [level, setLevel] = useState<string>(ANY)
  const [status, setStatus] = useState<string>(ANY)
  const [scope, setScope] = useState<Scope>("listed")
  const [brokering, setBrokering] = useState<string>(ANY)
  const [sort, setSort] = useState<Sort>("name")
  const [limit, setLimit] = useState(STEP)

  const filtered = useMemo(() => {
    if (!rows) return undefined
    const needle = deferredQuery.trim().toLowerCase()
    const out = rows.filter(
      (row) =>
        inScope(row, scope) &&
        (level === ANY || (row.level ?? "unknown") === level) &&
        (status === ANY || row.status === status) &&
        (brokering === ANY ||
          (brokering === "needs" && row.needs.length > 0) ||
          (brokering === "offers" && row.offers.length > 0) ||
          (brokering === "suppressed" && row.suppressed) ||
          (brokering === "no_address" && !row.bestAddress)) &&
        (!needle || row.name.toLowerCase().includes(needle) || row.key.includes(needle)),
    )
    return out.sort((a, b) =>
      sort === "missing"
        ? b.missingFields.length - a.missingFields.length || a.name.localeCompare(b.name)
        : sort === "updated"
          ? b.updatedAt - a.updatedAt
          : a.name.localeCompare(b.name, "en", { numeric: true }),
    )
  }, [rows, deferredQuery, level, status, scope, brokering, sort])

  const open = (key: string | null) => {
    const params = new URLSearchParams(searchParams.toString())
    if (key) params.set("org", key)
    else params.delete("org")
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  return (
    <>
      <BrokerPageHeader
        title="Organisations"
        description="Every organisation the pipeline knows, with what is missing and what it needs or offers."
      >
        {filtered && (
          <Badge variant="outline" className="font-mono tabular-nums">
            {filtered.length} shown{complete ? "" : " · loading…"}
          </Badge>
        )}
      </BrokerPageHeader>

      <div className="flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center">
        <InputGroup className="lg:w-72">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setLimit(STEP)
            }}
            placeholder="Search by name or key"
            aria-label="Search organisations"
          />
        </InputGroup>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          <FilterSelect
            label="Show"
            value={scope}
            onChange={(v) => setScope(v as Scope)}
            options={[
              ["listed", "Listed"],
              ["counterparts", "Counterparts"],
              ["hidden", "Hidden"],
              ["all", "All"],
            ]}
          />
          <FilterSelect
            label="Level"
            value={level}
            onChange={setLevel}
            options={[
              [ANY, "Any level"],
              ...[...ORG_LEVELS, "unknown"].map((l) => [l, humanize(l)] as [string, string]),
            ]}
          />
          <FilterSelect
            label="Status"
            value={status}
            onChange={setStatus}
            options={[
              [ANY, "Any status"],
              ...ORG_STATUSES.map((s) => [s, humanize(s)] as [string, string]),
            ]}
          />
          <FilterSelect
            label="Brokering"
            value={brokering}
            onChange={setBrokering}
            options={[
              [ANY, "Any"],
              ["needs", "Has needs"],
              ["offers", "Has offers"],
              ["no_address", "No address"],
              ["suppressed", "Suppressed"],
            ]}
          />
          <FilterSelect
            label="Sort"
            icon={<ArrowDownWideNarrowIcon />}
            value={sort}
            onChange={(v) => setSort(v as Sort)}
            options={[
              ["name", "Name"],
              ["missing", "Most missing"],
              ["updated", "Recently updated"],
            ]}
          />
        </div>
      </div>

      {filtered === undefined ? (
        <div className="flex flex-col gap-2">
          {SKELETON_ROWS.map((key) => (
            <Skeleton key={key} className="h-10" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchIcon />
            </EmptyMedia>
            <EmptyTitle>No organisation matches</EmptyTitle>
            <EmptyDescription>Loosen a filter or clear the search.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="overflow-hidden rounded-xl border">
          <Table>
            <TableHeader className="sticky top-0 bg-background">
              <TableRow>
                <TableHead>Organisation</TableHead>
                <TableHead className="hidden md:table-cell">Level</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Missing</TableHead>
                <TableHead className="hidden lg:table-cell">Needs · offers</TableHead>
                <TableHead className="hidden xl:table-cell">Address</TableHead>
                <TableHead className="hidden sm:table-cell text-right">Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.slice(0, limit).map((row) => (
                <TableRow
                  key={row.key}
                  className="cursor-pointer"
                  data-state={openKey === row.key ? "selected" : undefined}
                  onClick={() => open(row.key)}
                >
                  <TableCell className="max-w-64">
                    <button
                      type="button"
                      className="flex flex-col items-start text-left focus-visible:outline-none focus-visible:underline"
                      onClick={(event) => {
                        event.stopPropagation()
                        open(row.key)
                      }}
                    >
                      <span className="flex items-center gap-1.5 truncate font-medium">
                        {row.hidden && (
                          <EyeOffIcon className="size-3.5 shrink-0" aria-label="Hidden" />
                        )}
                        {row.name}
                      </span>
                      <span className="font-mono text-xs text-muted-foreground">{row.slug}</span>
                    </button>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    {row.level ? humanize(row.level) : "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={row.status === "active" ? "secondary" : "outline"}>
                      {row.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {row.isCounterpart ? "—" : row.missingFields.length}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    <NeedOfferChips needs={row.needs} offers={row.offers} max={3} />
                  </TableCell>
                  <TableCell className="hidden max-w-48 truncate text-xs xl:table-cell">
                    {row.bestAddress ? (
                      <span title={row.bestAddress.email}>{humanize(row.bestAddress.role)}</span>
                    ) : (
                      <span className="text-muted-foreground">none</span>
                    )}
                    {row.suppressed && (
                      <Badge variant="outline" className="ml-1.5">
                        suppressed
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="hidden text-right font-mono text-xs text-muted-foreground sm:table-cell">
                    {formatDate(row.updatedAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {filtered.length > limit && (
            <div className="flex justify-center border-t p-2">
              <Button variant="ghost" size="sm" onClick={() => setLimit((n) => n + STEP * 2)}>
                Show more ({filtered.length - limit} left)
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  )
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
  icon,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: [string, string][]
  icon?: React.ReactNode
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full sm:w-auto sm:min-w-36" aria-label={label}>
        {icon}
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map(([optionValue, optionLabel]) => (
          <SelectItem key={optionValue} value={optionValue}>
            {optionLabel}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
