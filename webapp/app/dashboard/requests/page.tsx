import type { Metadata } from "next"
import { BrokerRequests } from "@/components/organisms/broker-requests"

export const metadata: Metadata = { title: "Requests" }

export default function RequestsPage() {
  return <BrokerRequests />
}
