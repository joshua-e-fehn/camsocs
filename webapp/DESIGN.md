# UI/UX Design System — camsocs

> **This file is the single source of truth for all frontend design decisions.**
> It is referenced any time UI code is created or modified.
> Sections marked with ✏️ are meant to be edited by humans as the project evolves.

---

## Role

Act as a world-class Creative Developer (Awwwards-level) specializing in modern Next.js applications, sophisticated data-driven interfaces, and premium UX. You draw heavy inspiration from **Palantir's design language** — commanding dark interfaces, structured grid layouts, precise typography, restrained color use with purposeful accent highlights, and a sense of operational intelligence. Every screen should feel like a high-end control surface: powerful yet clear, data-rich yet uncluttered.

---

## Tech Stack (do not deviate)

| Layer         | Technology                                                                      |
| ------------- | ------------------------------------------------------------------------------- |
| Framework     | Next.js 16+ (App Router, Turbopack)                                             |
| Language      | TypeScript 5.9                                                                  |
| Runtime       | Bun                                                                             |
| Auth          | Better Auth + Convex                                                            |
| Backend / DB  | Convex (real-time)                                                              |
| UI Components | shadcn/ui + Radix UI                                                            |
| Styling       | Tailwind CSS v4 (CSS-first config)                                              |
| Animation     | Framer Motion (hero sections, onboarding, page transitions, micro-interactions) |
| Icons         | Lucide React                                                                    |
| Data Fetching | Convex hooks (`hooks/convex/`) — no REST layer, no React Query                  |

### Animation Guidelines (Framer Motion)

Use Framer Motion **generously** on:

- Landing / marketing pages (scroll-triggered reveals, parallax, hero animations)
- Onboarding flows (step transitions, progress celebrations)
- Page transitions (`AnimatePresence` + layout animations)
- Micro-interactions (card hovers, button feedback, list reordering)
- Data visualizations (number counters, chart entrances)

Use **CSS transitions only** for:

- Simple hover states on buttons/links
- Sidebar expand/collapse
- Skeleton shimmer (shadcn built-in)
- Tooltip/popover show/hide (Radix handles these)

**Motion rules:**

- Duration: 150–400ms (never exceed 600ms for UI elements)
- Easing: `[0.25, 0.1, 0.25, 1]` (smooth) or `[0.33, 1, 0.68, 1]` (snappy exit)
- Stagger children: 50–80ms delay between items
- Respect `prefers-reduced-motion` — wrap animated content with a check or use Framer's built-in support
- Scroll animations use `whileInView` with `viewport={{ once: true, margin: "-100px" }}`

---

## ✏️ Branding (EDIT THIS SECTION)

| Property        | Value                                                                          |
| --------------- | ------------------------------------------------------------------------------ |
| **App Name**    | camsocs                                                                        |
| **Tagline**     | A sourced directory of Cambridge societies and sports clubs                    |
| **Tone**        | Authoritative, precise, quietly confident                                      |
| **Personality** | Palantir meets clean SaaS — intelligent, structured, no unnecessary decoration |
| **Visual Mood** | Dark command center, surgical precision, data as art                           |

---

## ✏️ Color Palette (EDIT THIS SECTION)

Colors are defined as CSS custom properties in `app/globals.css` using oklch.
Update them there — these docs describe the **intent** behind each token.

The neutral family is shadcn's **mauve** (`components.json` → `tailwind.baseColor: "mauve"`,
style `radix-nova`): greys with a faint violet tint (oklch hue ≈ 320–326), not zinc.

### Current Theme Tokens

| Token                      | Role                            | Notes                                  |
| -------------------------- | ------------------------------- | -------------------------------------- |
| `--background`             | Page background                 | Near-white (light) / near-black (dark) |
| `--foreground`             | Primary text                    | High contrast against background       |
| `--primary`                | Key actions, buttons, links     | Dark mauve (light) / light mauve (dark) |
| `--primary-foreground`     | Text on primary surfaces        | Inverted from primary                  |
| `--secondary`              | Secondary actions, subtle fills | Lighter/darker mauve                   |
| `--accent`                 | Hover states, highlights        | Same family as secondary               |
| `--muted`                  | Disabled states, placeholders   | Subdued mauve                          |
| `--muted-foreground`       | Secondary text, captions        | Mid-tone mauve                         |
| `--destructive`            | Errors, delete actions          | Red                                    |
| `--border`                 | Dividers, card outlines         | Subtle mauve / white-alpha             |
| `--card`                   | Card surfaces                   | White (light) / dark mauve (dark)      |
| `--ring`                   | Focus rings                     | Mid mauve                              |
| `--chart-1` to `--chart-5` | Data visualization palette      | Teal/green spectrum                    |

### ✏️ Semantic Colors (extend as needed)

When the project purpose is defined, add these custom tokens to `globals.css`:

```css
/* Example — uncomment and adjust when ready:
  --success: oklch(0.65 0.2 145);          /* Green — positive state        */
  --warning: oklch(0.75 0.15 85);          /* Amber — caution               */
  --info:    oklch(0.65 0.15 250);         /* Blue — informational          */
  --highlight: oklch(0.8 0.12 85);         /* Gold/amber — premium accent   */
*/
```

> **To rebrand:** Change values in `globals.css` → `:root` / `.dark` blocks.
> All shadcn/ui components and Tailwind classes (`bg-primary`, `text-muted-foreground`, etc.)
> pick up new colors automatically. No find-and-replace needed.

---

## ✏️ Typography

| Property           | Value                                                     |
| ------------------ | --------------------------------------------------------- |
| **Font Family**    | `Geist` via `var(--font-sans)` (`next/font/google`, app/layout.tsx) |
| **Mono Family**    | `Geist Mono` via `var(--font-mono)`                       |
| **Heading Weight** | `600` (semibold) – `700` (bold)                           |
| **Body Weight**    | `400` (regular)                                           |
| **Letter Spacing** | `tracking-tight` on headings, default on body             |
| **Line Height**    | Tailwind defaults (`leading-normal` / `leading-relaxed`)  |
| **Heading Style**  | Short (max ~8 words), uppercase sparingly for labels only |

> Palantir-inspired: prefer sentence case over title case.
> Use monospace (`font-mono`) for data values, IDs, timestamps, and code.

---

## Design Principles

### 1. Structured Precision (Palantir DNA)

Layouts follow a strict grid. Align elements to a consistent spatial system. Use clear visual hierarchy — size, weight, and placement communicate importance, not decoration. Negative space is a feature, not waste.

### 2. Data-Forward

Information density is acceptable when organized. Use tables, grids, and metric cards confidently. Let the data breathe with consistent padding, but don't hide it behind excessive drill-downs. Dashboards should feel like mission control.

### 3. Restrained Color

Use the monochromatic mauve palette as the foundation. Accent colors appear **sparingly** and with purpose — a single highlighted metric, an active state, an error. When everything is colorful, nothing stands out.

### 4. Progressive Disclosure

Don't overwhelm on first contact. Show essentials first, reveal complexity through interaction (expandable sections, dialogs, drill-downs). Keep forms short — split into steps if > 5 fields. Onboarding should feel guided, not gated.

### 5. Responsive & Mobile-First

Design for 375px first, then scale up. Touch targets minimum 44px. Sidebar collapses on mobile. Use `sm:` / `md:` / `lg:` breakpoints intentionally, not as afterthoughts.

### 6. Feedback on Every Action

- Buttons show loading spinners during async operations
- Form fields show inline validation errors immediately
- Success states confirmed visually (toast notification, check icon, color shift)
- Skeleton loaders for any data-dependent UI — never show blank screens
- Framer Motion for meaningful transitions (list reorder, step changes, entrance animations)

### 7. Accessible by Default

- All interactive elements reachable via keyboard
- Sufficient color contrast (WCAG AA minimum)
- Radix UI primitives handle ARIA roles, focus traps, and screen reader support
- Never rely on color alone to convey meaning — pair with icons or text labels
- `prefers-reduced-motion` respected in all Framer Motion animations

### 8. Both Themes Are First-Class

The theme **follows the operating system** (`defaultTheme="system"` in `components/providers/theme-provider.tsx`; press `d` to toggle). Design and test every screen in both light and dark — neither is an afterthought. Always use semantic tokens (`bg-card`, `text-muted-foreground`) — never hard-coded hex/oklch values in components.

> ✏️ Open decision: the template's original direction was dark-first (Palantir-style). If that is wanted, set `defaultTheme="dark"` in the theme provider and update this section — the code and this file must say the same thing.

---

## Component Conventions

### Layout

- **Page max-width:** `max-w-7xl mx-auto` for content areas
- **Dashboard:** Sidebar (`app-sidebar`) + header + scrollable main area
- **Public pages:** Full-width sections, `PublicHeader` with transparent-to-solid scroll effect
- **Auth pages:** Centered card on a clean background
- **Landing page:** Full-bleed hero, scroll-triggered sections, generous vertical spacing

### Cards

```
rounded-xl border bg-card text-card-foreground shadow-sm
```

- Internal padding: `p-6`
- Group related info in cards
- For data cards: include a subtle top accent border or left accent stripe for visual grouping
- Hover: `hover:border-primary/20 transition-colors duration-200`

### Buttons

- **Primary action:** `<Button>` (solid)
- **Secondary action:** `<Button variant="outline">`
- **Destructive:** `<Button variant="destructive">`
- **Ghost / icon:** `<Button variant="ghost" size="icon">`
- Only one primary button per visible section
- Loading state: `disabled` + animated spinner icon replacing the label text

### Forms

- Use shadcn `<Input>`, `<Label>`, `<Select>`, etc.
- Inline error messages below the field in `text-destructive text-sm`
- Labels always visible (no placeholder-only fields)
- Group related fields, add section headings for long forms
- Multi-step forms: use Framer Motion for step transitions with a progress indicator

### Empty States

Never show a blank area. Provide:

- A subtle icon (Lucide, `text-muted-foreground`, 48px)
- A short explanation (1–2 sentences)
- A call-to-action button

### Loading States

- **Page-level:** Full skeleton matching the layout shape
- **Component-level:** `Skeleton` component from shadcn/ui
- **Buttons:** `disabled` + spinner icon while loading
- **Data tables:** Skeleton rows matching expected column count
- **Page transitions:** Framer Motion `AnimatePresence` with fade/slide

### Tables & Data Grids

- Use shadcn `<Table>` with sticky headers
- Monospace font for numeric columns (`font-mono tabular-nums`)
- Alternating row shading optional — prefer clean divider lines in dark mode
- Sortable columns indicated by icon, not just hover

---

## Motion & Animation Patterns

### Framer Motion (rich interactions)

| Pattern               | Implementation                                                        |
| --------------------- | --------------------------------------------------------------------- |
| Page transition       | `AnimatePresence` + `motion.div` fade/slide (`y: 10` → `0`, 300ms)    |
| Hero text entrance    | Staggered `motion.span` per word, slide-up + fade-in, 50ms stagger    |
| Scroll reveal         | `whileInView={{ opacity: 1, y: 0 }}` with `viewport={{ once: true }}` |
| Card hover lift       | `whileHover={{ y: -4, transition: { duration: 0.2 } }}`               |
| List item entrance    | `motion.li` with stagger via parent `staggerChildren: 0.06`           |
| Step transition       | `AnimatePresence mode="wait"` with slide-left/slide-right             |
| Number counter        | `motion.span` with `useSpring` or `animate` from value to value       |
| Button press          | `whileTap={{ scale: 0.97 }}`                                          |
| Modal/dialog entrance | Scale from 0.95 + fade, 200ms, spring easing                          |
| Background glow/grid  | CSS animation or subtle SVG with `motion.path` draw                   |

### CSS Transitions (simple states)

| Pattern            | Implementation                                      |
| ------------------ | --------------------------------------------------- |
| Hover color change | `hover:text-primary transition-colors duration-150` |
| Focus ring         | Tailwind defaults via Radix                         |
| Sidebar expand     | `transition-[width] duration-200 ease-in-out`       |
| Skeleton shimmer   | shadcn `<Skeleton>` (built-in pulse)                |
| Tooltip appear     | Radix built-in (no custom needed)                   |

---

## Landing Page Direction

Inspired by palantir.com:

- **Hero:** Full-viewport, dark background with subtle animated grid/mesh. Large bold headline, concise subtext, single CTA. Consider a particle field or geometric animation.
- **Sections:** Alternate between full-bleed dark and slightly lighter `bg-card` bands. Each section: icon/visual left, text right (or reversed). Scroll-triggered entrance animations.
- **Metrics / Social proof:** Animated number counters, clean grid of stats.
- **Navigation:** Transparent on hero, solid on scroll. Minimal links, prominent CTA.
- **Footer:** Dark, minimal, structured columns. No clutter.
- **Overall feel:** Less "startup playful", more "enterprise intelligence". Confidence through restraint.

---

## Do NOT

- Use arbitrary color values (`bg-[#1a1a2e]`) in components — always use tokens
- Add external UI libraries (Material UI, Chakra, Ant, Mantine) — shadcn/ui + Radix only
- Create components outside the Atomic Design structure (`ui/` → `molecules/` → `organisms/`)
- Skip dark or light mode testing — the theme follows the system, both must work
- Use `any` in TypeScript — type all props, state, and API responses
- Add placeholder text like "Lorem ipsum" — use realistic copy
- Over-animate — if an animation doesn't aid comprehension or delight, remove it
- Use rounded-full on cards or large containers — prefer `rounded-xl` or `rounded-2xl`
- Use saturated background colors for large areas — backgrounds should be near-neutral
- Nest Framer Motion `AnimatePresence` more than 2 levels deep
