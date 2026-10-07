import type { Metadata } from "next"
import { Suspense } from "react"
import { BrokerOrgDrawer } from "@/components/organisms/broker-org-drawer"
import { BrokerOrgTable } from "@/components/organisms/broker-org-table"
import { Skeleton } from "@/components/ui/skeleton"

export const metadata: Metadata = { title: "Organisations" }

/** The table and the drawer share the open organisation through `?org=<key>`. */
export default function OrganisationsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 rounded-xl" />}>
      <BrokerOrgTable />
      <BrokerOrgDrawer />
    </Suspense>
  )
}
