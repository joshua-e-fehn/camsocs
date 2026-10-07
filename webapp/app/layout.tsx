import type { Metadata } from "next"
import { Geist, Geist_Mono } from "next/font/google"

import "./globals.css"
import { AuthGuard } from "@/components/providers/auth-guard"
import { ConvexClientProvider } from "@/components/providers/convex-client-provider"
import { ThemeProvider } from "@/components/providers/theme-provider"
import { Toaster } from "@/components/ui/sonner"
import { getToken } from "@/lib/auth-server"
import { SITE_DESCRIPTION, SITE_NAME, SITE_TAGLINE, SITE_URL } from "@/lib/site"
import { cn } from "@/lib/utils"

const fontSans = Geist({
  subsets: ["latin"],
  variable: "--font-sans",
})

const fontMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
})

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${SITE_NAME} — ${SITE_TAGLINE}`,
    template: `%s · ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  // Open Graph without any University branding: our wordmark only
  // (app/opengraph-image.tsx).
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    locale: "en_GB",
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
  },
  twitter: { card: "summary_large_image" },
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  // Null for the signed-out majority — expected, not a failure.
  const token = await getToken()

  return (
    <html
      lang="en-GB"
      suppressHydrationWarning
      className={cn("antialiased", fontMono.variable, "font-sans", fontSans.variable)}
    >
      <body>
        <ConvexClientProvider initialToken={token}>
          <ThemeProvider>
            <AuthGuard>{children}</AuthGuard>
            <Toaster />
          </ThemeProvider>
        </ConvexClientProvider>
      </body>
    </html>
  )
}
