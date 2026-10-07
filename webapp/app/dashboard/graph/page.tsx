import type { Metadata } from "next"
import { BrokerGraph } from "@/components/organisms/broker-graph"

export const metadata: Metadata = { title: "Graph" }

export default function GraphPage() {
  return <BrokerGraph />
}
