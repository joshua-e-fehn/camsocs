"use client"

import { BanIcon, EyeIcon, EyeOffIcon, InboxIcon } from "lucide-react"
import Link from "next/link"
import { useState } from "react"
import { BrokerPageHeader } from "@/components/molecules/broker-page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  type BrokerListingRequest,
  runWithToast,
  useBrokerListingRequests,
  useBrokerOrgMutations,
  useSetListingRequestStatus,
} from "@/hooks/convex/broker"
import { formatDateTime, humanize } from "@/lib/broker/format"
import { LISTING_REQUEST_STATUSES } from "@/lib/vocab"

type Filter = BrokerListingRequest["status"] | "all"

const KIND_HINT: Record<BrokerListingRequest["kind"], string> = {
  claim: "Wants to manage the listing",
  correct: "Proposes corrections",
  remove: "Asks for the listing to be removed",
  object: "Objects to the processing",
  add: "Asks for a new listing",
}

/**
 * The inbox of requests from the public claim / correct / remove / object /
 * add form. A remove or object request is acted on here: hide the listing
 * from the public site, suppress it from outreach, then mark the request done.
 */
export function BrokerRequests() {
  const [filter, setFilter] = useState<Filter>("open")
  const requests = useBrokerListingRequests(filter === "all" ? undefined : filter)

  return (
    <>
      <BrokerPageHeader
        title="Requests"
        description="Claims, corrections, removals and objections from the listing form."
      />
      <ToggleGroup
        type="single"
        variant="outline"
        value={filter}
        onValueChange={(value) => value && setFilter(value as Filter)}
        aria-label="Status"
      >
        {LISTING_REQUEST_STATUSES.map((status) => (
          <ToggleGroupItem key={status} value={status}>
            {humanize(status)}
          </ToggleGroupItem>
        ))}
        <ToggleGroupItem value="all">All</ToggleGroupItem>
      </ToggleGroup>

      {requests === undefined ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : requests.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <InboxIcon />
            </EmptyMedia>
            <EmptyTitle>Inbox clear</EmptyTitle>
            <EmptyDescription>No {filter === "all" ? "" : `${filter} `}requests.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-4">
          {requests.map((request) => (
            <RequestCard key={request.key} request={request} />
          ))}
        </div>
      )}
    </>
  )
}

function RequestCard({ request }: { request: BrokerListingRequest }) {
  const setStatus = useSetListingRequestStatus()
  const { setHidden, updateProfile } = useBrokerOrgMutations()
  const removal = request.kind === "remove" || request.kind === "object"
  const fields = Object.entries(request.fields ?? {})

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Badge variant={removal ? "destructive" : "secondary"}>{request.kind}</Badge>
          {request.org ? (
            <Link
              href={`/dashboard/organisations?org=${request.org.key}`}
              className="underline-offset-4 hover:underline"
            >
              {request.org.name}
            </Link>
          ) : (
            <span>{request.orgKey ?? "New listing"}</span>
          )}
          {request.org?.hidden && (
            <Badge variant="outline">
              <EyeOffIcon />
              hidden
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          {KIND_HINT[request.kind]} · {formatDateTime(request.createdAt)} ·{" "}
          <span className="font-mono">{request.submitterEmail}</span>
          {request.role && ` (${request.role})`}
        </CardDescription>
        <CardAction>
          <Select
            value={request.status}
            onValueChange={(status) =>
              runWithToast(
                setStatus({ key: request.key, status: status as BrokerListingRequest["status"] }),
                `Marked ${status}`,
              )
            }
          >
            <SelectTrigger size="sm" aria-label="Request status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LISTING_REQUEST_STATUSES.map((status) => (
                <SelectItem key={status} value={status}>
                  {humanize(status)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm whitespace-pre-wrap">{request.message}</p>
        {fields.length > 0 && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg border bg-muted/30 p-3 text-sm">
            {fields.map(([name, value]) => (
              <div key={name} className="contents">
                <dt className="font-mono text-xs text-muted-foreground">{name}</dt>
                <dd className="break-words">{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {request.org && removal && (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant={request.org.hidden ? "outline" : "destructive"}
              onClick={() =>
                request.org &&
                runWithToast(
                  setHidden({ orgKey: request.org.key, hidden: !request.org.hidden }),
                  request.org.hidden
                    ? "Listing shown again"
                    : "Listing hidden from the public site",
                )
              }
            >
              {request.org.hidden ? <EyeIcon /> : <EyeOffIcon />}
              {request.org.hidden ? "Show listing again" : "Hide listing"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                request.org &&
                runWithToast(
                  updateProfile({ orgKey: request.org.key, suppressed: true }),
                  "Suppressed from outreach",
                )
              }
            >
              <BanIcon />
              Suppress outreach
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
