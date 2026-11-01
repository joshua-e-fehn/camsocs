# UI/UX Design System — camsocs

> **This file is the single source of truth for all frontend design decisions.**
> It is referenced any time UI code is created or modified.
> Sections marked with ✏️ are meant to be edited by humans as the project evolves.

---

## Role

Act as a creative developer building a warm, editorial, distinctly Cambridge student site: a
well-set college handbook crossed with a good local listings paper, made interactive. Dense
where data is dense (agendas, indexes), generous where it is editorial (heroes, footers). The
build contract for the current direction is `docs/talks-redesign-spec.md` §5–6.

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

## ✏️ Branding

| Property        | Value                                                                        |
| --------------- | ---------------------------------------------------------------------------- |
| **App Name**    | camsocs (always lower case; the wordmark is Newsreader italic + river glyph) |
| **Tagline**     | Cambridge societies, events and talks, sourced (`SITE_TAGLINE`, lib/site.ts)  |
| **Direction**   | "Backs & limestone": Ketton-limestone paper, ink, the Cam as a line           |
| **Tone**        | Plain, warm, a little wry, local — Mich/Lent/Easter, Week 0, formals, bops, supos, Sidgwick Site |
| **Never**       | University crest, arms, shields, "University of Cambridge" as branding, Feijoa / Open Sans, the #8EE8D8-led brand palette, heritage dot/arrow patterns, implied endorsement |

The site is unofficial: the disclaimer sits in every footer, and copy may refer to Cambridge
factually ("for students in Cambridge") but never as if speaking for the University or a College.

---

## ✏️ Color Palette

Tokens live in `app/globals.css` (`:root` light, `.dark` dark) as hex, exposed to Tailwind
through `@theme inline`. **The token names are a contract** (spec §5): components use them and
the shadcn semantic names, never raw hex.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--background` | #F7F4EC | #0E1614 | limestone paper / night river (with a faint CSS paper grain) |
| `--card`, `--popover` | #FFFDF8 | #15201D | raised surfaces |
| `--foreground` | #16231F | #ECE8DE | ink |
| `--muted` / `--muted-foreground` | #EFEADD / #5B6660 | #1A2622 / #9AA49E | quiet fills, secondary text |
| `--border`, `--input` | #E2DCCD | #24302C | rules |
| `--primary` (Cam sage), `--ring` | #2E6A55 | #8CC7AE | **Societies**, primary actions, focus |
| `--accent` | #DCEBE2 | #1C3029 | sage tint (hover, selected rows, term strip) |
| `--events` / `--events-tint` | #A8432C / #F3DED6 | #E58B70 / #3A2019 | **Events** (Tudor brick) — `bg-events`, `text-events`, `bg-events-tint` |
| `--talks` / `--talks-tint` | #34407A / #E1E4F2 | #A9B3EA / #1F2440 | **Talks** (lecture-hall indigo) |
| `--gilt` | #B8902F | #D9B65A | decoration only, never text |
| `--backs` | #A9CDBB | #2F5446 | the river line; decoration only, never text |
| `--school-{arts,hss,bio,clinical,physical,tech,other}` + `-tint` | ink on tint, ≥ 5.8:1 | same | talk School chips |

- Pillar colour coding is fixed: Societies = sage, Events = brick, Talks = indigo. Use it for
  marks, rails, counters and active indicators — not for large backgrounds.
- `--success` / `--warning` (+ `-foreground`) stay for provenance chips only, always with an
  icon and a word.
- `--sidebar-*` tint the broker dashboard to match (a deeper limestone rail).
- Every text pair above is ≥ 4.5:1 in its mode (checked 2026-10-31). Re-check when changing one.
- The footer is a night-river band in both themes: it carries the `dark` class, which scopes the
  dark tokens to its subtree.

---

## ✏️ Typography

| Role | Face | Notes |
| --- | --- | --- |
| Display | **Newsreader** (`font-serif`, `--font-serif`) | variable with `opsz` + italic, `next/font/google`. h1/h2, the wordmark, big numerals, detail-page titles. Weight 300–400; italics for warmth ("this *term*"). |
| UI / body | Geist Sans (`font-sans`) | rows, filters, buttons, body copy |
| Data | Geist Mono (`font-mono`, `tabular-nums`) | times, counts, term stamps ("MICH · WK 4"), eyebrows |

- h1 `clamp(2.6rem, 7.2vw, 4.75rem)`, leading 1.02, tracking −0.025em; section h2 serif 2rem.
- Mono eyebrows: 11px, uppercase, tracking 0.12–0.16em. Use sparingly — mono everywhere reads
  as a dev dashboard.
- Inputs are 16px on phones (no iOS zoom).

---

## Design Principles

### 1. Editorial structure

Layouts follow a strict grid, set like a well-made printed index. Align elements to a consistent spatial system. Use clear visual hierarchy — size, weight, and placement communicate importance, not decoration. Negative space is a feature, not waste.

### 2. Data-Forward

Information density is acceptable when organized. Use tables, grids, and metric cards confidently. Let the data breathe with consistent padding, but don't hide it behind excessive drill-downs. Prefer ruled rows to stacks of identical cards.

### 3. Restrained Color

Paper and ink are the foundation; the three pillar colours carry meaning (sage societies, brick
events, indigo talks) and appear as marks, rails and numerals rather than fills. Gilt and the
Backs green are decoration only.

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

The theme **follows the operating system** (`defaultTheme="system"` in `components/providers/theme-provider.tsx`), with a visible Light / Dark / System toggle in the header and the mobile menu (`components/molecules/theme-toggle.tsx`). There is no single-key shortcut (WCAG 2.1.4). Design and test every screen in both light and dark. Always use semantic tokens (`bg-card`, `text-muted-foreground`, `text-events`) — never hard-coded hex/oklch values in components.

---

## Component Conventions

### Layout

- **Page max-width:** `max-w-7xl mx-auto` for content areas
- **Dashboard:** Sidebar (`app-sidebar`) + header + scrollable main area
- **Public pages:** term strip, sticky translucent `PublicHeader`, full-width sections, editorial `SiteFooter`
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
| Scroll reveal         | `<Reveal>` (CSS + IntersectionObserver, never hidden in server HTML) |
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

## Shell & motifs

- **Term clock strip** (`components/molecules/term-strip.tsx`, `lib/term-week.ts`): 28px mono
  strip above the header, "MICH · WK 4 · SAT 31 OCT" or "VACATION · LENT STARTS IN 9 WEEKS",
  from `termDates`. Weeks follow `termWeekLabel` (Thursday to Wednesday).
- **Header** (`public-header.tsx`): wordmark, Societies · Events · Talks · About with a
  pillar-coloured underline on the current page, the "Search ⌘K" pill, theme toggle, account
  menu (Sign in lives there); a right sheet with serif nav on phones.
- **⌘K palette** (`organisms/command-palette.tsx`): ⌘K / Ctrl+K, `/` when not typing, the
  header pill, or `openPalette()` (`lib/palette.ts`). Grouped results with serif small-caps
  headings, scope chips, recents; full screen below `sm`.
- **RiverLine** (`molecules/river-line.tsx`): one meandering stroke in `--backs` under the hero,
  between sections and above the footer (Grantchester → Baits Bite). It draws itself once by CSS
  under `prefers-reduced-motion: no-preference`.
- **Footer**: night-river band, river, link columns, the current term, an oversized italic
  wordmark and the disclaimer.
- **Reveal** never ships `opacity:0` in server HTML: it only tucks content away after mount, when
  motion is allowed and the block is still below the fold.
- Ruled, N°-numbered index rows (colleges, departments); dashed hairlines between agenda rows.

## Landing page

Mobile-first, in this order: serif hero with a scoped search (All / Societies / Events / Talks)
and quick chips, plus a "Next up" ledger on desktop → pillar counters in big serif numerals →
"This week", day by day, with pillar tabs → category tiles with real example names → talks by
School (wave 2) → by college (a ruled index with leader dots) → a footnote-style method note.
No photography and no fake numbers: a pillar without real data renders nothing.

## Do NOT

- Use arbitrary color values (`bg-[#1a1a2e]`) in components — always use tokens
- Add external UI libraries (Material UI, Chakra, Ant, Mantine) — shadcn/ui + Radix only
- Create components outside the Atomic Design structure (`ui/` → `molecules/` → `organisms/`)
- Skip dark or light mode testing — the theme follows the system, both must work
- Use University marks, shields or the University's brand colours and fonts (see Branding)
- Use `any` in TypeScript — type all props, state, and API responses
- Add placeholder text like "Lorem ipsum" — use realistic copy
- Over-animate — if an animation doesn't aid comprehension or delight, remove it
- Use rounded-full on cards or large containers — prefer `rounded-xl` or `rounded-2xl`
- Use saturated background colors for large areas — backgrounds should be near-neutral
- Nest Framer Motion `AnimatePresence` more than 2 levels deep
