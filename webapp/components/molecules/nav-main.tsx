"use client"

import { ChevronRightIcon } from "lucide-react"
import Link from "next/link"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar"

export function NavMain({
  items,
  label = "Platform",
}: {
  label?: string
  items: {
    title: string
    url: string
    icon?: React.ReactNode
    isActive?: boolean
    /** A count shown beside the entry (e.g. open requests); hidden at 0. */
    badge?: number
    /** What the badge counts, for screen readers ("3 open requests"). */
    badgeLabel?: string
    items?: {
      title: string
      url: string
    }[]
  }[]
}) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item) =>
          item.items && item.items.length > 0 ? (
            <Collapsible
              key={item.title}
              asChild
              defaultOpen={item.isActive}
              className="group/collapsible"
            >
              <SidebarMenuItem>
                <CollapsibleTrigger asChild>
                  <SidebarMenuButton tooltip={item.title}>
                    {item.icon}
                    <span>{item.title}</span>
                    <ChevronRightIcon className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
                  </SidebarMenuButton>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <SidebarMenuSub>
                    {item.items.map((subItem) => (
                      <SidebarMenuSubItem key={subItem.title}>
                        <SidebarMenuSubButton asChild>
                          <Link href={subItem.url} prefetch={false}>
                            <span>{subItem.title}</span>
                          </Link>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    ))}
                  </SidebarMenuSub>
                </CollapsibleContent>
              </SidebarMenuItem>
            </Collapsible>
          ) : (
            <SidebarMenuItem key={item.title}>
              <SidebarMenuButton tooltip={item.title} isActive={item.isActive} asChild>
                <Link href={item.url} prefetch={false}>
                  {item.icon}
                  <span>{item.title}</span>
                  {item.badge ? (
                    <span className="sr-only">
                      {" "}
                      ({item.badge} {item.badgeLabel ?? "new"})
                    </span>
                  ) : null}
                </Link>
              </SidebarMenuButton>
              {item.badge ? (
                // The collapsed (icon-only) sidebar hides the count: a dot.
                <span
                  aria-hidden
                  className="pointer-events-none absolute top-1 right-1 hidden size-2 rounded-full bg-destructive group-data-[collapsible=icon]:block"
                />
              ) : null}
              {item.badge ? (
                <SidebarMenuBadge
                  aria-hidden
                  className="rounded-full bg-destructive px-1.5 text-white peer-hover/menu-button:text-white peer-data-[active=true]/menu-button:text-white"
                >
                  {item.badge >= 100 ? "99+" : item.badge}
                </SidebarMenuBadge>
              ) : null}
            </SidebarMenuItem>
          ),
        )}
      </SidebarMenu>
    </SidebarGroup>
  )
}
