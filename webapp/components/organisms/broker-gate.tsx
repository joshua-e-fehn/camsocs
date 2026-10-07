"use client"

import { LockIcon } from "lucide-react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { useBrokerAccess } from "@/hooks/convex"

/**
 * Renders the private area only for a broker; everyone else gets an
 * explanation. UX only — access is enforced in Convex (`requireBrokerUser` in
 * every convex/broker/* function). It exists so the broker queries below are
 * never even mounted for a non-broker, who would otherwise see thrown queries.
 */
export function BrokerGate({ children }: { children: React.ReactNode }) {
  const access = useBrokerAccess()

  if (access === undefined) {
    return (
      <div className="flex flex-col gap-4 p-4 md:p-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-xl" />
      </div>
    )
  }

  if (!access.isBroker) {
    return (
      <Empty className="m-4 border md:m-6">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <LockIcon />
          </EmptyMedia>
          <EmptyTitle>No broker access</EmptyTitle>
          <EmptyDescription>
            This account is signed in but is not on the broker list, so the private area stays
            closed. A Cambridge sign-in unlocks Cambridge-only events on the public site.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild variant="outline">
            <Link href="/">Back to the directory</Link>
          </Button>
        </EmptyContent>
      </Empty>
    )
  }

  return <>{children}</>
}
