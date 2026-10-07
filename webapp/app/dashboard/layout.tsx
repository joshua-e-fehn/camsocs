import { AppSidebar } from "@/components/organisms/app-sidebar"
import { BrokerGate } from "@/components/organisms/broker-gate"
import { Header } from "@/components/organisms/header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"

/**
 * The private brokering area. AuthGuard (root layout) sends a signed-out
 * visitor to /sign-in; BrokerGate shows a non-broker why the area is closed.
 * Neither is security: every convex/broker/* function calls requireBrokerUser.
 */
export default function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar />
        {/* min-w-0: wide content (the introductions board, tables) scrolls in
            place instead of stretching the page past the viewport. */}
        <SidebarInset className="min-w-0">
          <Header />
          <BrokerGate>
            <div className="mx-auto flex w-full max-w-7xl min-w-0 flex-1 flex-col gap-6 p-4 md:p-6">
              {children}
            </div>
          </BrokerGate>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}
