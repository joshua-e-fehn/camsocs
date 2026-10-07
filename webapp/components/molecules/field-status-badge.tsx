import {
  AlertTriangleIcon,
  CheckIcon,
  CircleDashedIcon,
  MinusIcon,
  UserCheckIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import type { FieldStatus } from "@/lib/vocab"

const LOOK: Record<
  FieldStatus,
  {
    label: string
    variant: "default" | "secondary" | "outline" | "destructive"
    icon?: React.ReactNode
  }
> = {
  found: { label: "found", variant: "secondary", icon: <CheckIcon /> },
  inferred: { label: "inferred", variant: "outline", icon: <CircleDashedIcon /> },
  owner_confirmed: { label: "owner confirmed", variant: "default", icon: <UserCheckIcon /> },
  manual: { label: "manual", variant: "default", icon: <UserCheckIcon /> },
  conflicting: { label: "conflicting", variant: "destructive", icon: <AlertTriangleIcon /> },
  missing: { label: "missing", variant: "outline", icon: <MinusIcon /> },
  not_applicable: { label: "n/a", variant: "outline" },
}

/** A field's provenance status (data-model §1) as a chip with an icon. */
export function FieldStatusBadge({ status }: { status: FieldStatus }) {
  const look = LOOK[status]
  return (
    <Badge
      variant={look.variant}
      className={status === "missing" || status === "not_applicable" ? "text-muted-foreground" : ""}
    >
      {look.icon}
      {look.label}
    </Badge>
  )
}
