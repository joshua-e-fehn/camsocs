# UI/UX Design System — CAMsocs

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
| **App Name**    | CAMsocs (always "CAM" upper case, "socs" lower case; Young Serif, after the crest) |
| **Logo**        | The "Three pillars" crest (`components/molecules/crest.tsx`, `public/crest.svg`, `app/icon.svg`): a quartered shield in teal and deep river with a wave border; a mask, a quill, crossed oars and a knight. Our own drawing. `small` variant (quarters only) below 28px |
| **Tagline**     | Cambridge societies, events and talks, sourced (`SITE_TAGLINE`, lib/site.ts) |
| **Direction**   | "River & ink" (decided 2026-11-01): black ink on white paper, warmed by River & sunset — one sky band, teal links, apricot for today |
| **Tone**        | Plain, warm, a little wry, local — Mich/Lent/Easter, Week 0, formals, bops, supos, Sidgwick Site |
| **Never**       | The University's crest or arms or anything read as them (lions, the ermine cross, a book; no bridge, ships or castle), "University of Cambridge" as branding, Feijoa / Open Sans, the #8EE8D8-led brand palette, heritage dot/arrow patterns, implied endorsement |

The site is unofficial: the disclaimer sits in every footer, and copy may refer to Cambridge
factually ("for students in Cambridge") but never as if speaking for the University or a College.

---

## ✏️ Color Palette

Tokens live in `app/globals.css` (`:root` light, `.dark` dark) as hex, exposed to Tailwind
through `@theme inline`. **The token names are a contract** (spec §5): components use them and
the shadcn semantic names, never raw hex.

Light only: there is no dark theme and no toggle (decided 2026-11-01). The theme provider forces
light; no element carries `.dark`, so a stray `dark:` class never applies.

| Token | Value | Use |
| --- | --- | --- |
| `--background`, `--card`, `--popover` | #FFFFFF | paper |
| `--foreground` | #111111 | ink |
| `--muted` / `--muted-foreground` | #F4F8FA / #545B5E | quiet fills and hover, secondary text |
| `--faint` | #6E7477 | empty days, small print |
| `--border` / `--input` | #E3E5E6 / #D5D9DB | hairlines; section heads use a 1–2px ink rule instead |
| `--primary` | #111111 | buttons are ink |
| `--brand` / `--brand-text` | #1D7A7A / #1A6E6E | teal: the selected state (fills) and links (text) |
| `--ring` | #1D7A7A | focus |
| `--sky` / `--sky-line` | #E8F2F6 / #D2E4EB | the one band: home hero and footer; `--accent` is the same sky for menus |
| `--today` / `--today-text` | #F29E4C / #9A4C0E | apricot, for "today" and "now" only (dot, underline, the day's top bar) |
| `--events`, `--talks` (+ `-tint`) | teal on sky | kept as names; the pillars no longer have colours of their own |
| `--school-*` (+ `-tint`) | ink on #F2F4F5 | talk School chips, all alike |
| `--crest-*` | teal, deep river #0F2A33, wave #DCEBF2, white | the crest only |
| `--gilt`, `--backs` | apricot, sky line | decoration only, never text |

- Colour is rare on purpose: a page is ink and hairlines, with teal where you can act and apricot
  where something is happening today.
- `--success` / `--warning` (+ `-foreground`) stay for provenance chips only, always with an
  icon and a word.
- Every text pair above is ≥ 4.5:1 (checked 2026-11-01). Re-check when changing one.

---

## ✏️ Typography

| Role | Face | Notes |
| --- | --- | --- |
| Display | **Young Serif** (`font-serif`, `--font-serif`) | one weight, no italic (never synthesised). h1/h2, the wordmark, day numbers |
| UI / body | Figtree (`font-sans`) | rows, filters, buttons, body copy |
| Data | JetBrains Mono (`font-mono`, `tabular-nums`) | times, counts, date lines |

- Home h1 `clamp(2.75rem, 6.2vw, 5rem)`, leading 1.03, tracking −0.02em; section h2 serif 1.6–2.9rem.
- Mono lines are 12–13px and sentence case; keep mono for numbers and dates.
- Inputs are 16px on phones (no iOS zoom).

---

## Design Principles

### 1. Editorial structure

Layouts follow a strict grid, set like a well-made printed index. Align elements to a consistent spatial system. Use clear visual hierarchy — size, weight, and placement communicate importance, not decoration. Negative space is a feature, not waste.

### 2. Data-Forward

Information density is acceptable when organized. Use tables, grids, and metric cards confidently. Let the data breathe with consistent padding, but don't hide it behind excessive drill-downs. Prefer ruled rows to stacks of identical cards.

### 3. Restrained Color

Paper and ink are the foundation. Teal marks what you can act on or have selected, apricot what
is on today, and the sky band appears twice per page at most (hero, footer).

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

### 8. Light Only

The site has one theme, light (`app/globals.css`: `color-scheme: light`, and no element carries
`.dark`; the toaster is fixed to light). There is no theme provider. Always use semantic tokens
(`bg-card`, `text-muted-foreground`, `text-brand-text`) — never hard-coded hex/oklch values in
components.

---

## Component Conventions

### Layout

- **Page max-width:** `max-w-7xl mx-auto` for content areas
- **Dashboard:** Sidebar (`app-sidebar`) + header + scrollable main area
- **Public pages:** sticky translucent `PublicHeader`, full-width sections, the sky-band `SiteFooter`
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

- **Header** (`public-header.tsx`): crest and wordmark, Events · Talks · Societies · About with a
  teal underline on the current page, the "Search everything ⌘K" box, the account menu (Sign in
  lives there); a right sheet on phones.
- **⌘K palette** (`organisms/command-palette.tsx`): ⌘K / Ctrl+K, `/` when not typing, the
  header box, or `openPalette()` (`lib/palette.ts`).
- **Footer** (`site-footer.tsx`): the sky band; crest and one line about the site, Browse / For
  societies / CAMsocs columns with the contact address, then the disclaimer and the term
  (`loadTermClock`, lib/term-dates.ts). "Cookie settings" in the CAMsocs column reopens the
  consent banner.
- **Consent banner** (`organisms/consent-banner.tsx`): paper, not sky, fixed to the bottom with a
  hairline and a shadow; "Accept analytics" and "Reject" as two identical outline buttons (equal
  prominence is a legal requirement, so neither is primary).
- **Reveal** never ships `opacity:0` in server HTML: it only tucks content away after mount, when
  motion is allowed and the block is still below the fold.
- Ruled rows with hairlines; a 2px ink rule over each column or section head.

## Landing page

In this order (`app/(site)/page.tsx`, `organisms/home-overview.tsx`): the sky-band hero (date and
term, "What's on in Cambridge today" with an apricot underline, one plain sentence on what the
site is (an unofficial, independent directory, `SITE_INTRO`) then today's counts,
one search box that opens the palette, "Try" links, the large crest) → Today / This week:
Events · Talks · Societies in three columns, five rows each (three on phones) → "The week
ahead", seven days that switch the columns above to that day → "Find your people", the
categories as compact rows → "Talks by School" → a one-line method note. No photography and no
fake numbers: a pillar without real data renders nothing.

## Do NOT

- Use arbitrary color values (`bg-[#1a1a2e]`) in components — always use tokens
- Add external UI libraries (Material UI, Chakra, Ant, Mantine) — shadcn/ui + Radix only
- Create components outside the Atomic Design structure (`ui/` → `molecules/` → `organisms/`)
- Add a dark theme or a theme toggle back without a new decision
- Use University marks, shields or the University's brand colours and fonts (see Branding)
- Use `any` in TypeScript — type all props, state, and API responses
- Add placeholder text like "Lorem ipsum" — use realistic copy
- Over-animate — if an animation doesn't aid comprehension or delight, remove it
- Use rounded-full on cards or large containers — prefer `rounded-xl` or `rounded-2xl`
- Use saturated background colors for large areas — backgrounds should be near-neutral
- Nest Framer Motion `AnimatePresence` more than 2 levels deep
