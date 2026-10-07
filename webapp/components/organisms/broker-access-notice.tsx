"use client"

import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useBrokerAccess } from "@/hooks/convex"

/**
 * What the private area shows before the CRM exists: whether this account has
 * broker access. Access itself is enforced in Convex (`requireBrokerUser`);
 * this only explains the state to the person looking at it.
 */
export function BrokerAccessNotice() {
  const access = useBrokerAccess()

  if (access === undefined) {
    return <Skeleton className="h-24 w-full max-w-xl rounded-xl" />
  }

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>{access.isBroker ? "Broker access" : "No broker access"}</CardTitle>
        <CardDescription>
          {access.isBroker
            ? "You can use the private brokering area. It has no data yet."
            : "This account is signed in but is not on the broker list, so private data stays hidden."}
        </CardDescription>
      </CardHeader>
    </Card>
  )
}
