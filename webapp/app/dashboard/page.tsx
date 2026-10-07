import type { Metadata } from "next"
import { BrokerAccessNotice } from "@/components/organisms/broker-access-notice"

export const metadata: Metadata = { title: "Dashboard" }

export default function DashboardPage() {
  return (
    <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
      <BrokerAccessNotice />
    </div>
  )
}
