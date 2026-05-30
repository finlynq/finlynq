# Finlynq — Google Play submission content (paste-ready)

All copy + every "App content" / Data Safety / content-rating answer for the Play
Console, plus the graphics checklist. Package `com.finlynq.mobile`. Target
audience already set to **18 and over**.

---

## 1. Store listing

**App name** (≤30): `Finlynq`

**Short description** (≤80):
```
Privacy-first finance: track accounts, budgets, investments & net worth.
```

**Full description** (≤4000):
```
Finlynq is a privacy-first personal finance app that brings everything together — bank accounts, credit cards, spending, budgets, investments, loans, goals, and net worth — and lets you analyze it anywhere with AI.

Track your money here, analyze it anywhere.

WHAT YOU CAN DO
• Accounts & net worth — See every account (assets and liabilities) and your real-time net worth, across multiple currencies.
• Transactions — Record income and expenses, categorize spending, and review recent activity at a glance.
• Budgets — Set monthly budgets per category and track progress as you spend.
• Investments — Follow your portfolio with holdings, cost basis, gains, and dividends, with live prices for stocks, crypto, and precious metals.
• Goals — Set savings and debt-payoff goals and watch your progress.
• Loans — Track mortgages, student loans, and other debt with amortization detail.
• Multi-currency — Accurate conversion with historical exchange rates so your totals are always right.
• Import — Bring in transactions from CSV, Excel, OFX, or PDF statements.

BUILT FOR AI
Finlynq ships a first-party MCP server, so you can connect AI assistants and ask natural questions about your money — "How much did I spend on groceries last month?", "What's my savings rate?", "Show my portfolio's realized gains this year." Your assistant works with your real data, securely.

PRIVATE BY DESIGN
• Your financial data is encrypted in transit and at rest.
• No ads. No third-party trackers. We don't sell your data.
• Open source (AGPL v3) — inspect the code or run it yourself.
• Donation-funded, not data-funded.

HOSTED OR SELF-HOSTED
Use the hosted version at finlynq.com, or run your own server with Docker and PostgreSQL and point the app at it — the server URL is configurable in Settings.

A Finlynq account is required to use the app. You can delete your account and all associated data at any time.
```

**App category:** Finance
**Tags:** personal finance, budgeting, investing
**Contact email:** <your support/developer email> (e.g. support@finlynq.com)
**Website:** https://finlynq.com
**Privacy policy:** https://finlynq.com/privacy

---

## 2. Graphics checklist

| Asset | Spec | Status |
|---|---|---|
| App icon | 512×512 PNG (32-bit, alpha) | ✅ already in the build (`assets/icon.png`) |
| Feature graphic | 1024×500 PNG/JPG, no alpha | ✅ generated → `mobile/store/feature-graphic.png` (regen: `node scripts/generate-feature-graphic.mjs`) |
| Phone screenshots | 2–8 images, PNG/JPG, each side 320–3840px, 16:9 or 9:16 | ⬜ **you capture on your phone** |

**Screenshots to capture** (4–6 recommended, portrait): Dashboard (net worth + recent), Accounts list, Account detail, Portfolio, Transactions, Budgets. Grab them from the installed app (Android: power + volume-down), then upload under Store listing → Phone screenshots.

---

## 3. App content declarations (Dashboard → Policy → App content)

| Section | Answer |
|---|---|
| **Privacy policy** | `https://finlynq.com/privacy` |
| **Ads** | No, my app does **not** contain ads. |
| **App access** | Some/all functionality is restricted (login required) → provide the reviewer login below. |
| **Content rating** | Complete the questionnaire (section 4). |
| **Target audience & content** | Target age **18 and over**; "designed to appeal to children" → **No**. |
| **Data safety** | Section 5. |
| **Government apps** | No. |
| **Financial features** | **My app does not provide any of these financial features.** Finlynq only *tracks/displays* the user's own data — it does not originate loans, manage debt, move money, provide banking/e-money, or execute trades/crypto exchange. |
| **Health** | No. |
| **News app** | No. |
| **COVID-19 contact tracing/status** | No. |

### App access — reviewer login (paste into "Instructions")
```
All functionality requires signing in. The app connects to finlynq.com by default.

Username: demo@finlynq.com
Password: finlynq-demo

This is a shared demo account preloaded with sample data (it resets nightly). After signing in, all features are reachable from the bottom tabs (Home, Accounts, Portfolio, Transactions) and the More tab (Budgets, Goals, Settings).
```

---

## 4. Content rating (IARC questionnaire)

- **Category:** Utility, Productivity, Communication, or Other (it's a finance utility, not a game).
- Violence / realistic violence → **No**
- Sexual content or nudity → **No**
- Profanity or crude humor → **No**
- Controlled substances (drugs, alcohol, tobacco) → **No**
- Gambling — real or simulated → **No**
- Fear / horror → **No**
- Discrimination / hate → **No**
- Users can **interact, communicate, or share content** with each other → **No** (personal data only; no social features, no user-to-user messaging)
- Shares the user's **physical location** with other users → **No**
- Lets users **purchase digital goods** / contains in-app purchases → **No**
- Any other potentially objectionable content → **No**

**Expected rating:** Everyone (PEGI 3 / ESRB Everyone).

---

## 5. Data Safety (Dashboard → App content → Data safety)

**Does your app collect or share any required user data types?** → **Yes**
**Is all user data encrypted in transit?** → **Yes** (HTTPS/TLS to the backend)
**Account creation methods:** → **Username and password** (email counts as a username; no OAuth; biometric is local-unlock only)
**Do you provide a way to request data deletion?** → **Yes** (in-app account wipe + deletion URL — see note below)

**Data collected — Shared = No for every item:**

| Category → Data type | Collected | Required/Optional | Processed ephemerally | Purpose |
|---|---|---|---|---|
| Personal info → Name | Yes | Optional | No | App functionality, Account management |
| Personal info → Email address | Yes | Optional | No | App functionality, Account management |
| Personal info → User IDs (username) | Yes | Required | No | App functionality, Account management |
| Financial info → Other financial info (balances, transactions, budgets, investments) | Yes | Required | No | App functionality |
| **Files and docs** (uploaded CSV/Excel/OFX/PDF statements for import) | Yes | Optional | **Yes** (parsed server-side; raw file not retained as a file) | App functionality |

> **Files and docs is YES** because the in-app Import screen lets users upload a bank/statement file (`expo-document-picker` → `/api/import/preview` + `/api/import/execute`). The file is parsed into transactions server-side and isn't kept as a file, so mark **Processed ephemerally = Yes**. The transactions extracted from it are covered by "Other financial info."

**Everything else → NOT collected**, specifically:
- Location, Phone number, Physical address, Contacts, Calendar — No
- Messages, Photos/Videos, Audio — No
- Health & fitness — No
- **Device or other IDs** — No (no analytics/ad SDKs)
- **App activity / Web history** — No
- **App info & performance / Crash logs / Diagnostics** — No (the in-app diagnostics log is **local-only**, never transmitted → not "collected" per Google's definition)
- Financial info → User payment info / Purchase history / Credit score — No

**Data shared with third parties:** **None.** The app talks only to your own Finlynq backend (first-party / self-hostable). No ad networks, no third-party analytics.

**Security practices:**
- Encrypted in transit → **Yes**
- Users can request deletion → **Yes**
- Independent security review → **No** (optional; skip)
- Committed to Play Families Policy → **N/A** (18+)

---

## 6. ⚠️ One gap to close before production: data-deletion URL
Google requires a **reachable URL** where users can request account/data deletion
(in addition to the in-app wipe). Confirm finlynq.com exposes one (a Settings
deletion flow page, or a documented path). If it doesn't yet, add a short
"Delete your account" section to `/privacy` (or a `/account-deletion` page) and
use that URL. Until that URL exists, the Data Safety "deletion" entry can't be
fully completed.

---

## 7. Path to production (reminder)
- **Personal account:** Closed testing → ≥12 testers opted-in ≥14 days → apply for production access → promote Closed → Production (same `.aab`, no rebuild).
- **Organization account:** finish the above sections → create a Production release directly (no 12-tester/14-day gate).
- Subsequent uploads after the first manual one: `cd pf-app/mobile && EAS_NO_VCS=1 eas.cmd submit -p android --profile production` (needs `play-service-account.json`).
