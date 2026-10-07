"use client"

import {
  ClipboardListIcon,
  FileWarningIcon,
  HandshakeIcon,
  InboxIcon,
  LayoutDashboardIcon,
  MessageSquareTextIcon,
  NetworkIcon,
  UsersIcon,
} from "lucide-react"
import { usePathname } from "next/navigation"
import type * as React from "react"
import { NavMain } from "@/components/molecules/nav-main"
import { NavUser } from "@/components/molecules/nav-user"
import { TeamSwitcher } from "@/components/molecules/team-switcher"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
} from "@/components/ui/sidebar"
import { authClient } from "@/lib/auth-client"

const teams = [{ name: "camsocs", logo: <UsersIcon />, plan: "Broker" }]

/** The broker area's sections (app/dashboard/*). */
const SECTIONS = [
  { title: "Overview", url: "/dashboard", icon: <LayoutDashboardIcon /> },
  { title: "Organisations", url: "/dashboard/organisations", icon: <ClipboardListIcon /> },
  { title: "People", url: "/dashboard/people", icon: <UsersIcon /> },
  { title: "Interactions", url: "/dashboard/interactions", icon: <MessageSquareTextIcon /> },
  { title: "Introductions", url: "/dashboard/introductions", icon: <HandshakeIcon /> },
  { title: "Graph", url: "/dashboard/graph", icon: <NetworkIcon /> },
  { title: "Missing data", url: "/dashboard/reports", icon: <FileWarningIcon /> },
  { title: "Requests", url: "/dashboard/requests", icon: <InboxIcon /> },
] as const

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { data: session } = authClient.useSession()
  const pathname = usePathname()

  const user = {
    name: session?.user?.name || session?.user?.email || "User",
    email: session?.user?.email ?? "",
    avatar: session?.user?.image ?? "",
  }

  const items = SECTIONS.map((section) => ({
    ...section,
    isActive:
      section.url === "/dashboard"
        ? pathname === "/dashboard"
        : pathname === section.url || pathname.startsWith(`${section.url}/`),
  }))

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <TeamSwitcher teams={teams} />
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={items} label="Broker" />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
