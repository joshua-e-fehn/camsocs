import type { Metadata } from "next"
import { BrokerPipeline } from "@/components/organisms/broker-pipeline"

export const metadata: Metadata = { title: "Pipeline" }

export default function PipelinePage() {
  return <BrokerPipeline />
}
