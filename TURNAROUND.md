# PF Turnaround Plan — Execution Tracker

> **Model:** Cloud-primary, self-hosted as free side product
> **Target:** Launch in 6–8 weeks (8 sessions)
> **Created:** April 5, 2026

---

## Product Decisions

- **Cloud is the primary product.** Register → trial → upload CSV → start working.
- **Self-hosted is the free side product.** SQLite + SQLCipher, Docker, for devs and privacy users.
- **Dev/Prod mode toggle.** Admin sees all 41 features. Production users see ~20 curated features.
- **No bank sync for launch.** CSV + OFX import with saved templates instead.
- **MCP server is the key differentiator.** Replace built-in chat UI with MCP setup guide.
- **Time-limited trial** with Stripe billing for conversion.

---

## Session 1: Dev Mode + Feature Hiding

**Goal:** Build toggle, hide 17 features, drop 3. Instant product focus.

- [ ] Add `dev_mode` key to settings table with GET/PUT API endpoint
- [ ] Create `requireDevMode()` middleware (returns 404 when off)
- [ ] Tag every nav item in `nav.tsx` with `mode: "prod"` or `"dev"`, add filtering
- [ ] Add toggle switch to Settings page (admin only)
- [ ] Guard dev-mode pages with redirect to /dashboard when accessed in prod
- [ ] Guard dev-mode API routes with `requireDevMode()`
- [ ] Remove PDF import UI and route references
- [ ] Remove Excel import UI and route references
- [ ] Remove structured CSV wizard UI
- [ ] Test: toggle on/off, verify nav changes, verify routes return 404

**Notes:**
<!-- Add session notes, blockers, decisions here -->

---

## Session 2: Trial & Billing

**Goal:** Complete Stripe integration, trial period, billing page.

- [ ] Install `stripe` Node SDK, add env vars (`STRIPE_API_KEY`, `STRIPE_PUBLISHABLE_KEY`)
- [ ] Create `POST /api/billing/checkout` (Stripe checkout session with `trial_period_days`)
- [ ] Add webhook signature verification (`stripe.webhooks.constructEvent`)
- [ ] Add `"trial"` as valid plan value, set `planExpiresAt` to +14 days on registration
- [ ] Create trial expiry banner component (days remaining + upgrade CTA)
- [ ] Create billing/plan section in Settings (current plan, upgrade, cancel)
- [ ] Handle trial expiry: middleware check, downgrade to free tier
- [ ] Test: register → see trial banner → Stripe checkout → plan upgrade

**Notes:**

---

## Session 3: Import Templates — Backend

**Goal:** Schema, API, and matching logic for saved CSV mappings.

- [ ] Add `import_templates` table to `schema.ts` (SQLite) and `schema-pg.ts` (Postgres)
  - Fields: id, userId, name, accountId (FK), fileType, columnMapping (JSON), hasHeaders, dateFormat, amountFormat, isDefault, createdAt, updatedAt
- [ ] Run migrations for both databases
- [ ] Create CRUD API: `GET/POST /api/import/templates`, `PUT/DELETE /api/import/templates/:id`
- [ ] Build template-matching logic (compare file headers to saved templates, score 0–100%)
- [ ] Update `/api/import/preview` to accept optional `templateId` parameter
- [ ] Add MCP tools: `get_import_templates`, `import_with_template`
- [ ] Test: create template via API → retrieve → match against sample file

**Notes:**

---

## Session 4: Import Templates — Frontend + Email

**Goal:** UI for saved templates, auto-matching, email webhook integration.

- [ ] Add "Save as Template" button after successful CSV column mapping
- [ ] Add "Use Template" dropdown to import page header
- [ ] Build auto-match on file upload (compare headers → pre-select best template)
- [ ] Add template management section (list, edit, delete) on Import page
- [ ] Update email webhook to check saved templates when processing CSV attachments
- [ ] End-to-end test: upload → save template → re-upload same format → auto-match → import
- [ ] Test email flow: forward CSV → webhook → template match → auto-import → notification

**Notes:**

---

## Session 5: Core Feature Polish

**Goal:** Every visible feature is clean and launch-ready.

- [x] Dashboard: simplify to hero + 4 stat cards + spotlight + weekly recap
- [x] Dashboard: remove links/references to hidden pages
- [x] Dashboard: add Quick Import drag-drop widget
- [x] Budgets: clean envelope mode toggle, mobile layout, rollover indicators
- [x] Portfolio: basic holdings view, clean loading states, hide X-Ray tabs in prod
- [x] Reports: polish income statement and balance sheet, hide Sankey/YoY tabs in prod
- [x] Goals: verify account-linking auto-progress, improve empty state
- [ ] Health score: verify all 6 components calculate correctly (deferred — API working, no visible bugs)
- [ ] Accounts: improve empty states, mobile cards (already has EmptyState + Skeleton, acceptable for launch)
- [x] Transactions: better search UX, pagination, filters

**Notes:**
Session 5 complete (2026-04-05). Key decisions:
- `useDevMode` hook (cached, no flicker) gates dev-only UI in one place
- Dashboard simplified to 3-row layout in prod: hero+health / 4 stats / spotlight+recap+quick-import
- Quick Import widget: drag-drop CSV/OFX → uploads to /api/import/upload → redirects to /import
- Reports: cashflow + YoY tabs hidden in prod (tabs disappear, not just disabled)
- Portfolio: ETF X-Ray + Benchmarks gated in prod
- Goals: empty state now shows type-aware quick-create buttons; summary cards hidden when goals=0
- Transactions: search is now a prominent full-width bar with clear button; filters compact in a second row
- Budgets: mode toggle now uses icons + primary/secondary styling; rollover pill shows clock icon with tooltip

---

## Session 6–7: MCP Guide + Landing Page

**Goal:** Users understand the MCP value prop and can connect their AI in under 5 minutes.

- [x] Create `/mcp-guide` page with setup instructions for Claude Desktop
- [x] Add setup instructions for ChatGPT and local LLMs
- [x] Add example prompts section (spending queries, budget checks, goal tracking, etc.)
- [x] Add MCP connection status indicator (can it reach the server?)
- [x] Replace Chat nav link with MCP Guide link in production mode
- [x] Redesign landing page: Cloud as primary CTA ("Start Free Trial")
- [x] Add self-hosted as secondary link on landing page
- [x] Add value proposition copy and 60-second demo video embed (placeholder)
- [x] Update `.well-known/mcp.json` with clear tool descriptions

**Notes:**
Session 6–7 complete (2026-04-05). Key decisions:
- `/mcp-guide` lives in `(app)` route group (requires login) — users connect their AI after signing up, not before.
- 5 setup tabs: Claude Desktop, Cursor, Cline, ChatGPT, Custom/Local LLMs. Claude Desktop is the primary recommendation.
- ChatGPT tab added; notes that remote MCP requires Plus/Pro and links to Claude Desktop as fallback.
- MCP status indicator pings `/api/healthz` on mount — shows green/red/checking badge.
- 12 example prompts across 6 categories, click-to-copy.
- `.well-known/mcp.json` homepage/api_docs updated to production URL (finance.nextsoftwareconsulting.com).
- Landing page: hero + video placeholder + 3 feature cards; "Start Free Trial" primary, "Self-host for free →" secondary.

---

## Session 8: Onboarding + Final QA

**Goal:** Launch-ready. New user from zero to AI-connected in under 10 minutes.

- [ ] Build cloud onboarding flow: register → upload first file → review → set budget → connect MCP
- [ ] Add empty state CTAs on all visible pages
- [ ] Configure SMTP for production email delivery (verification, reset, notifications)
- [ ] Security audit: all prod routes auth-gated, no dev routes leak in prod mode
- [ ] Performance audit: bundle size, loading times, mobile responsiveness
- [ ] Full walkthrough: new user journey from register to MCP connection
- [ ] Smoke test self-hosted mode (Docker) to make sure it still works

**Notes:**

---

## Feature Decision Table

### Keep & Improve (20) — Visible in Production

| Feature | Status | Session | Notes |
|---------|--------|---------|-------|
| Registration & Login | ✅ Working | 2 | Add trial banner, onboarding redirect |
| Admin Panel | ✅ Working | 1–2 | Add dev mode toggle, trial mgmt |
| Accounts & Balances | ✅ Working | 5 | Polish empty states, mobile |
| Transactions | ✅ Working | 5 | Better search, pagination |
| CSV Import | ✅ Working | 3–4 | **Major: saved templates** |
| OFX/QFX Import | ✅ Working | — | Keep as-is |
| Email Import | ✅ Working | 4 | Link to saved templates |
| Transaction Rules | ✅ Working | 3 | Verify batch-apply on import |
| Budgets (Envelope) | ✅ Working | 5 | Simplify mode toggle |
| Portfolio Tracker | ✅ Working | 5 | Basic view, clean loading |
| Dashboard | ✅ Working | 5–6 | Simplify, add quick import |
| Reports | ✅ Working | 5 | Income stmt + balance sheet only |
| Goals Tracker | ✅ Working | 5 | Verify account linking |
| MCP Server (27 tools) | ✅ Working | 6–7 | Write setup docs, guide page |
| Encryption & Unlock | ✅ Working | — | Self-hosted mode only |
| Dark Mode & Theme | ✅ Working | — | Already polished |
| Nav & Sidebar | ✅ Working | 1 | Add dev/prod filtering |
| Settings | ✅ Working | 1–2 | Add dev toggle, billing section |
| Landing Page | ✅ Working | 6–7 | Redesign: cloud primary |
| Stripe Billing | 🔧 Partial | 2 | Complete checkout, trial, UI |

### Move to Dev Mode (17) — Hidden in Production, Visible to Admin

| Feature | Status | Notes |
|---------|--------|-------|
| AI Chat UI | ✅ Working | Undermines MCP story. Keep for demos. |
| FIRE Calculator | ✅ Working | v2 Pro feature |
| Monte Carlo Sim | ✅ Working | v2 Pro feature |
| Scenario Planner | ✅ Working | v2 Pro feature |
| Sankey Chart | ✅ Working | v2 Pro feature |
| YoY Reports | ✅ Working | Needs 12+ months data |
| Bill Calendar | ✅ Working | Nice-to-have |
| Subscription Tracker | ✅ Working | Fragile auto-detect |
| Tax Optimization | ✅ Working | Canada-only, modularize later |
| Loan Calculator | ✅ Working | Not core to launch |
| Spending Insights | ✅ Working | Let MCP/AI handle this |
| Crypto Portfolio | ✅ Working | v2 Pro feature |
| ETF X-Ray | ✅ Working | v2 Pro feature |
| Investment Benchmarks | ✅ Working | v2 Pro feature |
| Rebalancing Advisor | ✅ Working | v2 Pro feature |
| Recurring Transactions | ✅ Working | Keep lib for MCP, hide page |
| API Docs Page | ✅ Working | Dev-facing only |

### Dropped from UI (3)

| Feature | Reason |
|---------|--------|
| PDF Import | Unreliable heuristic parsing. CSV + OFX covers 95%. |
| Excel Import | Users can save-as CSV. Heavy mapper UI for edge case. |
| Structured CSV Wizard | One-time setup tool. Use API or admin instead. |

### New Features to Add (6)

| Feature | Session | Status | Notes |
|---------|---------|--------|-------|
| Dev/Prod Mode Toggle | 1 | ⬜ Not started | Foundation for everything else |
| Import Templates | 3–4 | ⬜ Not started | Define once, import forever |
| MCP Setup Guide Page | 6–7 | ⬜ Not started | Replaces chat page |
| Quick Import Widget | 5–6 | ⬜ Not started | Dashboard drag-drop |
| Trial Expiry Logic | 2 | ⬜ Not started | 14-day trial, Stripe checkout |
| Cloud Onboarding Flow | 8 | ⬜ Not started | Register → upload → budget → MCP |

---

## Post-Launch Roadmap (v2)

- [ ] **Month 1–2:** Introduce Pro tier ($8/mo). Gate MCP write tools, advanced import, envelope budgets.
- [ ] **Month 2–3:** Re-enable FIRE, scenarios, Sankey as Pro features.
- [ ] **Month 3–4:** Re-enable cloud sync (SQLite mode) as managed option.
- [ ] **Month 4–6:** Add Plaid/MX bank sync for mainstream adoption.
- [ ] **Month 6+:** Tax modules as country-specific plugins. Mobile PWA.

---

## Hosting

- **Current:** VPS at finance.nextsoftwareconsulting.com (good for launch, up to ~1000 users)
- **Growth:** Migrate to Vercel + managed DB (Neon/Supabase) when scaling needed
- **Self-hosted distribution:** Docker image, documented on landing page

---

## Changelog

| Date | Session | Changes |
|------|---------|---------|
| 2026-04-05 | — | Plan created. Product model defined. Feature table finalized. |
| 2026-04-05 | 1 | Dev/prod mode toggle, nav filtering, 17 features hidden, 3 dropped. |
| 2026-04-05 | 5 | Core feature polish: useDevMode hook, dashboard simplified, Quick Import widget, Reports/Portfolio gating, Goals empty state, Transactions search UX, Budgets mobile layout. |
| 2026-04-05 | 6–7 | MCP Guide page (5 tabs: Claude Desktop, Cursor, Cline, ChatGPT, Custom), example prompts, connection status indicator. Nav: Chat → dev mode, MCP Guide → prod. Landing page cloud-first. mcp.json updated. |
