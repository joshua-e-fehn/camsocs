import type { Metadata } from "next"
import { Suspense } from "react"
import { BrokerRequests } from "@/components/organisms/broker-requests"

export const metadata: Metadata = { title: "Requests" }

export default function RequestsPage() {
  // BrokerRequests reads `?request=` (a notification's link).
  return (
    <Suspense>
      <BrokerRequests />
    </Suspense>
  )
}
