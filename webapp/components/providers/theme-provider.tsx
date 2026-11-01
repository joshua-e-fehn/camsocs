"use client"

import { ThemeProvider as NextThemesProvider } from "next-themes"
import type * as React from "react"

/**
 * Light / dark / system theme (next-themes), following the operating system
 * by default. Switched with the visible toggle in the header
 * (components/molecules/theme-toggle.tsx).
 *
 * There is deliberately no keyboard shortcut: the bare `d` hotkey this used to
 * install was a single-character shortcut with no way to turn it off, which
 * fails WCAG 2.1.4 (speech input types letters).
 */
function ThemeProvider({ children, ...props }: React.ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      {...props}
    >
      {children}
    </NextThemesProvider>
  )
}

export { ThemeProvider }
