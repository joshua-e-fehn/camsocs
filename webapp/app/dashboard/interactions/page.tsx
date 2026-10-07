import type { Metadata } from "next"
import { BrokerInteractions } from "@/components/organisms/broker-interactions"

export const metadata: Metadata = { title: "Interactions" }

export default function InteractionsPage() {
  return <BrokerInteractions />
}
