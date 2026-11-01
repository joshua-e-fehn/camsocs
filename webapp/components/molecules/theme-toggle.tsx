"use client"

import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react"
import { useTheme } from "next-themes"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

const THEMES = [
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
  { value: "system", label: "System", icon: MonitorIcon },
] as const

/**
 * The visible theme switch (spec §5: system by default, plus a toggle).
 *
 * `menu` is the header's icon button with a Light / Dark / System menu;
 * `inline` is a three-way segmented control for the mobile sheet. The icon
 * waits for mount — the server cannot know the visitor's theme.
 */
export function ThemeToggle({
  variant = "menu",
  className,
}: {
  variant?: "menu" | "inline"
  className?: string
}) {
  const { theme, resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const current = mounted ? (theme ?? "system") : undefined

  if (variant === "inline") {
    return (
      <fieldset className={cn("flex flex-col gap-2", className)}>
        <legend className="mb-2 font-mono text-[0.6875rem] tracking-[0.12em] text-muted-foreground uppercase">
          Theme
        </legend>
        <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
          {THEMES.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              aria-pressed={current === value}
              onClick={() => setTheme(value)}
              className="flex min-h-11 items-center justify-center gap-1.5 rounded-md text-sm text-muted-foreground transition-colors aria-pressed:bg-card aria-pressed:text-foreground aria-pressed:shadow-xs focus-visible:outline-2 focus-visible:outline-ring"
            >
              <Icon aria-hidden className="size-4" />
              {label}
            </button>
          ))}
        </div>
      </fieldset>
    )
  }

  const Icon = mounted && resolvedTheme === "dark" ? MoonIcon : SunIcon
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className={cn("size-10", className)}>
          <Icon aria-hidden />
          <span className="sr-only">Theme</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={current} onValueChange={setTheme}>
          {THEMES.map(({ value, label, icon: ItemIcon }) => (
            <DropdownMenuRadioItem key={value} value={value}>
              <ItemIcon aria-hidden />
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
