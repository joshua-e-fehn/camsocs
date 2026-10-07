import type { Metadata } from "next"
import { BrokerReports } from "@/components/organisms/broker-reports"

export const metadata: Metadata = { title: "Missing data" }

export default function ReportsPage() {
  return <BrokerReports />
}
