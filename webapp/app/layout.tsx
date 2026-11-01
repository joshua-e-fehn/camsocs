import type { Metadata } from "next"
import { Figtree, JetBrains_Mono, Young_Serif } from "next/font/google"

import "./globals.css"
import { ConsentBanner } from "@/components/organisms/consent-banner"
import { AuthGuard } from "@/components/providers/auth-guard"
import { ConvexClientProvider } from "@/components/providers/convex-client-provider"
import { ThemeProvider } from "@/components/providers/theme-provider"
import { Toaster } from "@/components/ui/sonner"
import { getToken } from "@/lib/auth-server"
import { SITE_DESCRIPTION, SITE_NAME, SITE_TAGLINE, SITE_URL } from "@/lib/site"
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
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  // Null for the signed-out majority — expected, not a failure.
  //
  // ⚠ This read (cookies) makes every route dynamic and `no-store` (UI audit
  // 2026-10-31 §9). It stays, for now, on purpose:
  //  - `initialToken` is what lets the first client queries run signed in.
  //    Without it a verified @cam.ac.uk reader's `cam_only` events on /events
  //    and a profile drop out on hydration and come back once the session
  //    resolves, and the broker's dashboard starts signed out.
  //  - Public pages would then prerender at build time, and CI builds against
  //    a placeholder deployment (scripts/build-env-defaults.sh promises it is
  //    never contacted), so `fetchQuery` in a static page fails the build.
  // Moving it needs both solved together: a route-scoped provider (or Cache
  // Components with the token read inside a Suspense boundary) plus
  // `connection()` / ISR for the pages that query Convex.
  const token = await getToken()

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
        <ConvexClientProvider initialToken={token}>
          <ThemeProvider>
            <AuthGuard>{children}</AuthGuard>
            {/* Every page but /dashboard* and /sign-in* (it hides itself there). */}
            <ConsentBanner />
            <Toaster />
          </ThemeProvider>
        </ConvexClientProvider>
      </body>
    </html>
  )
}
