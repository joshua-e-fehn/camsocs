import type { Metadata } from "next"
import { BrokerOverview } from "@/components/organisms/broker-overview"

export const metadata: Metadata = { title: "Overview" }

export default function DashboardPage() {
  return <BrokerOverview />
}
