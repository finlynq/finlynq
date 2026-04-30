# UI design system

Premium fintech dark theme, rebranded 2026-04-22. Pulled out of CLAUDE.md on 2026-04-28.

## Design philosophy

Modeled on the landing design bundle from claude.ai/design: near-black ink, warm amber accent, hairline rules, no drop shadows as ornament. The previous indigo/violet multi-hue palette is gone — one brand color (amber `#f5a623`), two semantic signals (teal up, coral down), everything else grayscale.

All shadcn components inherit this via the CSS custom properties in [globals.css](../src/app/globals.css), so there's no need to edit individual pages when tuning the design.

## Color system (shadcn tokens in [globals.css](../src/app/globals.css))

- **Dark mode:** Near-black page (`--background` ≈ `#0b0d10`), three-tier depth (card ≈ `#101317` → popover ≈ `#161a1f`), hairline borders (`--border` ≈ `#1e242b`). Amber `#f5a623` as `--primary` and `--ring`.
- **Light mode:** Warm off-white background, pure-white cards, same amber primary. Both modes share the brand accent so theme-switching preserves identity.
- **Chart colors:** `--chart-1` amber (primary), `--chart-2` teal `#5ac8a8` (positive), `--chart-3` coral `#e5624b` (negative), `--chart-4` muted blue, `--chart-5` muted violet.
- **Text hierarchy:** foreground `#e8eaed` → muted-foreground `#9aa3ad` → dim `#6b737d`.

## Typography

Geist (UI), Geist Mono (numerics + tags), Instrument Serif italic (display accents, used in `<em>` inside `.display-xl`/`.display-l` on the landing). Font variables: `--font-geist-sans`, `--font-geist-mono`, `--font-instrument-serif` (all loaded via `next/font/google` in [layout.tsx](../src/app/layout.tsx)).

## Landing page styles

Scoped under `.fl-landing` in [src/app/landing.css](../src/app/landing.css), imported only by [page.tsx](../src/app/page.tsx) at `/`. The landing hardcodes the ink palette so it looks the same regardless of `next-themes` state.

Key motifs:
- Sticky blur nav
- Scrolling ticker
- Draw-on hero chart (SVG `stroke-dasharray` animation)
- 3-column feature grid with mini-SVG vizzes
- 4-node privacy diagram
- Flat $0 plan card

Scroll reveals via `IntersectionObserver` — elements get the `.in` class once visible.

**Do NOT use `.fl-*` classes outside the landing route** — they don't exist in the app scope.

## Visual treatments (globals.css utilities)

- **`.noise-bg`** — SVG fractal noise overlay at 3.5% opacity (dark mode), tactile texture on body.
- **`.bg-dot-pattern`** — Subtle dot grid on main content area.
- **`.glass`** — Glassmorphism: `blur(20px) saturate(1.5)` + 6% white border (dark mode).
- **`.card-hover`** — 1px translateY lift + soft shadow on hover.
- **`.hero-number`** — Tabular figures + tight letter-spacing (`-0.025em`) for large financial values.
- **`.animate-shimmer`** — Sweeping gradient skeleton loader.
- **`.text-gradient`** — Amber → warm-orange gradient text.

## Logo

[FinlynqLogo.tsx](../src/components/FinlynqLogo.tsx) renders the new mark: amber-stroked rounded square (`#f5a623`, viewBox `0 0 22 22`) with an ascending bar-chart path and a filled dot at the peak. Replaces the prior indigo/violet "F + chain link" mark. [public/favicon.svg](../public/favicon.svg) uses the same art so browser tabs match.

## Card component (card.tsx)

- Whisper-thin `border-border/50` instead of ring.
- Inset top-edge highlight (`inset 0 1px 0 0 oklch(1 0 0 / 4%)`) — simulates light hitting the top edge.
- Tiny drop shadow `0 1px 3px`.

## Layout & navigation

- Collapsible sidebar (240px ↔ 56px) with grouped nav items.
- Mobile: fixed bottom tab bar (4 links + "More") + slide-up "More" panel. Sign out lives in the "More" panel on mobile.
- Active nav items: `bg-white/[0.08]` with glowing 3px left-edge indicator in `--sidebar-primary` (amber).
- Nav icons use a single `text-primary` accent on active state — was 12 different `text-*-400` category colors before the rebrand, flattened to match the landing's restraint. Inactive icons muted via `text-sidebar-foreground/40`. See `ACTIVE_ACCENT` constant in [nav.tsx](../src/components/nav.tsx).
- Nav group labels: `tracking-widest` uppercase at 30% opacity.
- **Sign out lives in the sidebar footer** (above the theme toggle / collapse row). The previous "Self-Hosted / Cloud Mode" account chip + dropdown was removed on 2026-04-23 — it duplicated info that only matters on the landing and confusingly labeled every logged-in user as "Self-Hosted". Admin-flag fetch moved to `/api/auth/session` as part of the same change.

## Dashboard

- Time-based greeting ("Good morning/afternoon/evening")
- Hero net worth card with mouse-following spotlight, decorative gradient orbs
- Spotlight widget: actionable alerts with dismiss + severity colors
- Weekly recap: collapsible spending summary with top categories bar chart
- Metric cards with animated count-up numbers, gradient border hover
- Health score ring with per-component mini progress bars
- Chart line glow filter (SVG `feGaussianBlur` merge)
- Glass tooltips on all charts

## Animations (Framer Motion)

- Count-up hero numbers (1.2s easeOut)
- Staggered card fade-in (0.08s between, 0.4s duration)
- Health score ring spring animation
- Progress bar fill animations with delay
- Theme toggle icon rotation transition (AnimatePresence)
- Spotlight widget dismiss animation (slide-out)

## Recharts conventions

- Tooltip formatter: use `(v) => formatCurrency(Number(v), "CAD")` — do not use typed params.
- Pie chart label: `percent` can be undefined — always use `(percent ?? 0)`.

## Select component

- `onValueChange` returns `string | null` — always add `?? ""` fallback.

## Combobox component (type-ahead dropdowns)

For user-data-backed dropdowns (categories, accounts, holdings, currencies) prefer `<Combobox>` from [src/components/ui/combobox.tsx](../src/components/ui/combobox.tsx) over `<Select>`. Built on `@base-ui/react/combobox`, visually identical to `<Select>` (same Tailwind tokens) but adds a search input and per-user pinned ordering.

High-level usage (drop-in for most `<Select>` sites):

```tsx
import { Combobox, type ComboboxItemShape } from "@/components/ui/combobox";
import { useDropdownOrder } from "@/components/dropdown-order-provider";

const sortAccount = useDropdownOrder("account");

<Combobox
  value={form.accountId}
  onValueChange={(v) => setForm({ ...form, accountId: v })}
  items={sortAccount(
    accounts.map((a): ComboboxItemShape => ({ value: String(a.id), label: a.name })),
    (a) => Number(a.value),
    (a, z) => a.label.localeCompare(z.label),
  )}
  placeholder="Select account"
  searchPlaceholder="Search accounts…"
  emptyMessage="No matches"
  className="w-full"
/>
```

- `onValueChange` receives a coerced `string` (the wrapper applies `?? ""` for you).
- Pass `items` as `Array<{ value, label, disabled? }>`. Filtering uses base-ui's collator against `label`.
- Use `<Combobox>` for: categories, accounts, portfolio holdings, currencies, rule `assignCategoryId`. Keep `<Select>` for short fixed enums (transaction type I/E/T/R, frequency, account group/type, date presets, column-name pickers in the import mapper).
- Use `useDropdownOrder(kind)` (kind = `"category" | "account" | "holding" | "currency"`) to apply the user's saved pin order before `.map()`. The hook is SSR-safe and returns the items in fallback order until `DropdownOrderProvider` (mounted in `(app)/layout.tsx`) hydrates.

Persistence — `GET`/`PUT /api/settings/dropdown-order` writes a JSON map `{ version: 1, lists: { category, account, holding, currency } }` keyed `dropdown_order` in the `settings` table. Identifiers are opaque (numeric IDs / ISO codes); no display names enter the row, so the value is unencrypted. The forthcoming Section G "setup pages" UI is the only writer in production (manual `psql` insert is fine for dev).

## Form validation

- Use `useState<Record<string, string>>({})` for errors. Clear errors with `""`, NOT `undefined`.
- Chart colors: use shared palette from [src/lib/chart-colors.ts](../src/lib/chart-colors.ts).

## shadcn/ui v4 (base-ui)

Uses `@base-ui/react`, NOT `@radix-ui`. Components use the `render` prop pattern, NOT `asChild`.

Example:
```tsx
// Right (base-ui)
<DialogTrigger render={<Button />}>

// Wrong (radix-style — won't work)
<DialogTrigger asChild><Button /></DialogTrigger>
```
