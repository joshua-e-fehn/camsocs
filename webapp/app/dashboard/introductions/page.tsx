import type { Metadata } from "next"
import { BrokerIntroductions } from "@/components/organisms/broker-introductions"

export const metadata: Metadata = { title: "Introductions" }

export default function IntroductionsPage() {
  return <BrokerIntroductions />
}
