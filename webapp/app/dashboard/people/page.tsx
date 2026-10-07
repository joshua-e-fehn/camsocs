import type { Metadata } from "next"
import { BrokerPeople } from "@/components/organisms/broker-people"

export const metadata: Metadata = { title: "People" }

export default function PeoplePage() {
  return <BrokerPeople />
}
