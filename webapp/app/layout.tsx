import type { Metadata, Viewport } from "next"
import { Figtree, JetBrains_Mono, Young_Serif } from "next/font/google"

import "./globals.css"
import { ConsentBanner } from "@/components/organisms/consent-banner"
import { AuthGuard } from "@/components/providers/auth-guard"
import { ConvexClientProvider } from "@/components/providers/convex-client-provider"
import { SignInTracker } from "@/components/providers/sign-in-tracker"
import { Toaster } from "@/components/ui/sonner"
import { siteVerification } from "@/lib/page-metadata"
import { SITE_DESCRIPTION, SITE_NAME, SITE_TAGLINE, SITE_URL, THEME_COLOR } from "@/lib/site"
import { cn } from "@/lib/utils"

// DESIGN.md "Typography": Figtree for text and UI, JetBrains Mono for times
// and counts, Young Serif (one weight, no italic) for headings and the
// wordmark.
const fontSans = Figtree({
  subsets: ["latin"],
  variable: "--font-sans",
})

const fontMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
})

const fontSerif = Young_Serif({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-serif",
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
    title: `${SITE_NAME} — ${SITE_TAGLINE}`,
    description: SITE_DESCRIPTION,
  },
  twitter: { card: "summary_large_image" },
  // Search Console / Bing Webmaster tags, only when their variables are set.
  verification: siteVerification(),
}

/** The browser's chrome takes the page's paper (light only, DESIGN.md). */
export const viewport: Viewport = { themeColor: THEME_COLOR }

/**
 * ⚠ No session read here (no `getToken()`, no cookies): it would make every
 * route dynamic and `no-store` (UI audit 2026-10-31 §9; SEO audit 2026-11-02,
 * no-cdn-cache). The public pages are one anonymous render, cached at the
 * edge (app/(site)/layout.tsx, docs/webapp.md "Caching"); what a signed-in
 * reader may see beyond it (a `cam_only` event) is added in the browser once
 * the Convex client has the session, which the client asks for itself, so
 * the provider gets no `initialToken`. The broker's dashboard waits for that
 * session (AuthGuard, BrokerGate).
 */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en-GB"
      suppressHydrationWarning
      className={cn(
        "antialiased",
        fontMono.variable,
        fontSerif.variable,
        "font-sans",
        fontSans.variable,
      )}
    >
      <body>
        <ConvexClientProvider>
          <AuthGuard>{children}</AuthGuard>
          {/* Counts a finished Cambridge sign-in (method only, with consent). */}
          <SignInTracker />
          {/* Every page but /dashboard* and /sign-in* (it hides itself there). */}
          <ConsentBanner />
          <Toaster />
        </ConvexClientProvider>
      </body>
    </html>
  )
}
