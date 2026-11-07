import type { Metadata } from "next"
import { BrokerStatus } from "@/components/organisms/broker-status"

export const metadata: Metadata = { title: "Status" }

export default function StatusPage() {
  return <BrokerStatus />
}
