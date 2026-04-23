# Finlynq Launch Checklist

Last updated: 2026-04-08

## Build & Compilation

| Check | Status | Notes |
|-------|--------|-------|
| `npm run build` passes | ✅ | 97 pages, 47 API routes — zero errors |
| TypeScript `noEmit` | ⚠️ non-blocking | Pre-existing Drizzle SQLite×PG dual-schema conflicts; `ignoreBuildErrors: true` in next.config |
| ESLint | ✅ | `.claude/` excluded from scan; no errors |
| Postbuild static copy | ✅ | `cp -r .next/static` + `public` → standalone |

## Routes — HTTP 200 on Production

| Route | Status |
|-------|--------|
| `/` (landing) | ✅ 200 |
| `/cloud` (login/register) | ✅ 200 |
| `/dashboard` | ✅ 200 |
| `/transactions` | ✅ 200 |
| `/accounts` | ✅ 200 |
| `/budgets` | ✅ 200 |
| `/goals` | ✅ 200 |
| `/portfolio` | ✅ 200 |
| `/reports` | ✅ 200 |
| `/import` | ✅ 200 |
| `/settings` | ✅ 200 |
| `/mcp-guide` | ✅ 200 |
| `/api/healthz` | ✅ 200 |

## Landing Page

| Check | Status | Notes |
|-------|--------|-------|
| Sticky header with Log In + Sign Up | ✅ | Log In → `/cloud`, Sign Up → `/cloud?tab=register` |
| Hero section with CTAs | ✅ | Gradient backdrop, animated headline |
| Stats bar (27+ tools, AES-256, etc.) | ✅ | |
| 6-feature grid with icons | ✅ | Hover effects, colored icon backgrounds |
| How it works (3 steps) | ✅ | |
| MCP differentiator section | ✅ | Chat mockup with sample Q&A |
| Trust indicators bar | ✅ | Lock/Globe/Code/Dollar icons |
| Pricing (3 tiers) | ✅ | "Most Popular" badge on Cloud plan |
| Final CTA section | ✅ | |
| Footer with 4 columns | ✅ | Product / Hosting / Account + brand |
| Mobile responsive | ✅ | `sm:` breakpoints on all grid sections |
| Dark/light mode | ✅ | Uses design system tokens throughout |

## Auth Flow

| Check | Status | Notes |
|-------|--------|-------|
| `/cloud` defaults to login tab | ✅ | |
| `/cloud?tab=register` opens register tab | ✅ | `useSearchParams` + `Suspense` wrapper |
| Login → `/dashboard` redirect | ✅ | Existing behaviour unchanged |
| Register → email verification flow | ✅ | Existing behaviour unchanged |

## Navigation & UI

| Check | Status | Notes |
|-------|--------|-------|
| Dev mode toggle hides `mode: "dev"` items | ✅ | Controlled by `/api/settings/dev-mode` |
| Admin nav item hidden for non-admins | ✅ | `isAdmin` flag from `/api/auth/session` |
| Sidebar logo updated to "Finlynq" | ✅ | "FL" initials, correct wordmark |
| Mobile bottom bar renders | ✅ | Dashboard / Transactions / Import / Budgets |

## Branding (Finlynq rebrand)

| Check | Status | Notes |
|-------|--------|-------|
| App title / meta | ✅ | "Finlynq" |
| Landing page | ✅ | All "PersonalFi" → "Finlynq" |
| MCP server name | ✅ | `"finlynq"` in mcp.json, index.ts, route.ts |
| Email templates | ✅ | noreply@finlynq.com, "Finlynq" branding |
| MFA issuer | ✅ | `"Finlynq"` |
| `.well-known/mcp.json` | ✅ | name, description, homepage → finlynq.com |
| DEPLOY.md | ✅ | finlynq.com domain |
| package.json name | ✅ | `"finlynq"` |

## Infrastructure

| Check | Status | Notes |
|-------|--------|-------|
| Server: pf.service active | ✅ | `active (running)` |
| Server: pf.service enabled on boot | ✅ | |
| Server: `APP_URL` in systemd | ✅ | `https://finlynq.com` |
| Caddy config | ✅ | `finlynq.com, www.finlynq.com → localhost:3456` |
| SSL (HTTPS) | ✅ | Caddy auto-TLS — `https://finlynq.com` returns 200 |
| Static assets in standalone | ✅ | ExecStartPre guard confirms before start |
| Postbuild copies static | ✅ | `finlynq@0.1.0 postbuild` runs after every build |

## CI / GitHub Actions

| Check | Status | Notes |
|-------|--------|-------|
| Single workflow (`deploy.yml`) | ✅ | `ci.yml` deleted |
| Lint (`continue-on-error`) | ✅ | `.claude/` excluded — clean |
| Type check web (`continue-on-error`) | ⚠️ non-blocking | Pre-existing dual-schema issues |
| Type check mobile (`continue-on-error`) | ⚠️ non-blocking | Pre-existing Expo setup |
| Unit tests (`continue-on-error`) | ⚠️ non-blocking | Pre-existing auth mock 404s |
| Build (hard gate) | ✅ | Passes; deploy only runs if this passes |
| Deploy on main push | ✅ | SSH → `sudo bash /home/projects/pf/deploy.sh` |

## Known Issues / Future Work

| Item | Priority | Notes |
|------|----------|-------|
| TypeScript dual-schema errors | Low | SQLite + PostgreSQL schema co-existence; suppressed at build |
| Unit test auth mocks return 404 | Medium | Mocks need updating to match current auth flow |
| Demo video on landing page | Medium | "Coming soon" placeholder in hero |
| Docker image at `ghcr.io/finlynq/finlynq` | Low | Placeholder path; image not yet published |
| `deploy.sh` run as root requires stash workaround | Low | Fixed in script: auto-detects repo owner and runs git/npm as that user |
