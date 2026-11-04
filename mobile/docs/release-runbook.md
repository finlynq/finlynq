# Finlynq mobile — release runbook

How to cut a new mobile version to **both stores' internal-testing tracks**. This is the
project-specific runbook that `~/claude-skills/drain-pending-tasks` (Step 7.6) discovers and
follows; it is also the fast path for a manual "release mobile 1.0.x" request.

> **Split:** Android builds + publishes on **GitHub Actions** (gradle, no EAS); iOS builds +
> submits on **EAS**. Both target internal tracks (Play internal / TestFlight) — never a public
> production track from this runbook.

## Context / where things live

- **Worktree:** `pf-mobile/` on branch **`mobile-dev`** — a separate worktree of `finlynq/finlynq`,
  distinct from `pf-app/` on `dev`. All mobile work + this release happen on `mobile-dev`.
- **Version source of truth:** `mobile/app.json` → `expo.version` is the **marketing version**
  (e.g. `1.0.9`), used for BOTH platforms. Do **not** set `expo.android.versionCode` in app.json —
  Android's versionCode comes from the release **tag**; iOS's buildNumber is EAS remote
  auto-increment.
- **`mobile/eas.json`:** `appVersionSource: "remote"`; the `production` profile has
  `autoIncrement: true` (EAS bumps the iOS buildNumber); submit profile → Android track `internal`,
  iOS `ascAppId 6775981169`.
- **Android build:** `.github/workflows/mobile-build-gradle.yml`. Tag-driven:
  - `mobile-release-v<N>` → builds **versionCode N** AND publishes to Play **internal**
    (track from repo var `PLAY_TRACK`, default `internal`; status `completed`).
  - `mobile-gradle-v<N>` → build only (no publish).
  - The trailing integer of the tag **is** the versionCode. Workflow reads the marketing version
    from `app.json` at the tagged commit, so **the tag must point at the commit that already has the
    bumped version**.
- **iOS build:** EAS cloud build + auto-submit to App Store Connect (→ TestFlight). Two targets since
  the widgets: the app and its WidgetKit extension `com.finlynq.mobile.widgets` (`mobile/targets/widget`,
  added at prebuild by `@bacons/apple-targets`), sharing the App Group `group.com.finlynq.mobile`.
- **Updates reach phones only through the stores.** Owner decision 2026-11-04: no OTA updates, so every
  change, JavaScript included, ships in a store build. `updates.enabled` is `false` in `mobile/app.json`. No
  app code uses `expo-updates`, so it stays installed and does nothing. Before this, every launch asked
  `u.expo.dev` and got a 400 (`"channel-name": Required`), measured on Android, because no build carries a
  channel, so an `eas update` could not have reached those builds. `eas.json` sets no channel for iOS either.
- **Auth needed:** `gh` logged in (HussienH) for the Android tag/CI; `eas` logged in
  (`eas whoami` → hussein.halawi). EAS holds the iOS dist cert, provisioning profiles, and ASC API
  key on its servers, so a non-interactive build resolves credentials itself, once they exist (see
  "New iOS target or capability" under Gotchas).

## Pick the new version numbers

- **Marketing version:** the new `expo.version` (e.g. `1.0.8` → `1.0.9`).
- **Android versionCode `N`:** highest existing release/build tag **+ 1**:
  ```bash
  git tag --list 'mobile-release-v*' 'mobile-gradle-v*' | grep -oE '[0-9]+$' | sort -n | tail -1
  ```
  (As of 1.0.8 the last was `16`, so 1.0.9 = versionCode `17`.)
- **iOS buildNumber:** don't pick one — EAS `autoIncrement` handles it.

## Steps

```bash
cd pf-mobile                      # git root of the mobile worktree

# 0. Clean + current
git fetch origin --prune
git status --porcelain            # must be empty; all intended work committed + pushed

# 1. Bump the marketing version in mobile/app.json  ("version": "1.0.8" -> "1.0.9")
#    (edit the file; do NOT add android.versionCode)

# 2. Commit on mobile-dev + push.  Use a message FILE or single-line -m.
#    (In the Bash tool, do NOT use PowerShell here-string `@'...'@` — it leaks literal `@`
#     into the message. Plain `-m` or `-F msgfile`.)
git add mobile/app.json
git commit -F .commitmsg            # subject e.g.: "mobile: bump versionName to 1.0.9 (vc17)"
git push origin mobile-dev

# 3. ANDROID — tag the bumped commit; the push triggers build + Play-internal publish.
git tag -a mobile-release-v17 -m "Finlynq mobile 1.0.9 (versionCode 17)" HEAD
git push origin mobile-release-v17
gh run list --repo finlynq/finlynq --workflow mobile-build-gradle.yml --limit 3   # ~21 min

# 4. iOS — build in the cloud + auto-submit to App Store Connect (TestFlight).
cd mobile
npx eas build --platform ios --profile production --auto-submit --non-interactive --no-wait
#   Prints the build URL + submission URL. ~20-40 min; auto-submit fires when the build completes.
```

## After the builds land (~20-40 min)

- **Android** publishes to Play **internal** automatically — installable for internal testers.
- **iOS** lands in **TestFlight**; you may need to assign the build to the internal testing group in
  App Store Connect.
- Then run on-device acceptance and report which `kind: human` test cases passed so the related
  DevManager item(s) can move to **Done**.

## R8 (Android release builds are minified)

Google Play's production track flagged 1.0.27: "DEX code optimization is below our threshold: Obfuscation
(1%)", fix by Feb 2027. Release builds now run R8. `plugins/withAndroidR8.js` sets the gradle property Expo's
template reads, `android.enableMinifyInReleaseBuilds`; the SDK 54 template doesn't read the older
`android.enableProguardInReleaseBuilds`, and a name it doesn't read does nothing, silently. Resource shrinking
stays off. The app has no keep rules of its own: what the
libraries ship was enough, and the manifest keeps the widget providers.

Measured with `mobile-r8-check` on an x86_64 build: APK 34.6 → 28.6 MB, DEX inside it 25.1 → 8.0 MB, and 92%
of the 11,007 classes left are renamed. R8 only touches the DEX, which is the same for every ABI, so expect
about 6 MB off a Play download. Play's own score only exists after an upload: check that the warning clears
on the first R8 build.

- **Mapping file.** It travels inside the bundle (`BUNDLE-METADATA/com.android.tools.build.obfuscation/proguard.map`)
  and Play reads it from there, so the publish step has no `mappingFile` and crash reports stay readable. The
  release workflow fails before publishing if R8 left no mapping, which also catches an Expo upgrade renaming
  the property. It is kept 90 days as the run's `finlynq-vc<N>-mapping` artifact. After the first R8 upload,
  confirm it in Play Console → App bundle explorer → that version → Downloads (ReTrace mapping file).
- **Run the check after anything native changes** (an Expo or React Native upgrade, a new native module, the
  widgets). R8 breaks reflection-heavy code only at runtime, so a green build proves nothing. About 25 minutes;
  it publishes nothing and uses no versionCode:
  ```bash
  git tag -a mobile-r8-check-<n> -m "R8 check <n>" HEAD && git push origin mobile-r8-check-<n>
  ```
  It builds the release variant and runs it on an emulator (`scripts/r8-check.sh`): the APK as shipped to the
  login screen; every widget drawn in every scenario; a sign-in against a stub server, every tab, the Budgets,
  Widgets and Settings screens, and a cold start back into the session through `expo-secure-store`; and a
  build without R8 signed in, then updated in place to the R8 one, which is how every existing user gets it.
  It fails on a crash, an ANR in the app, a missing native module, or a class or method R8 took away. Read the
  screenshots in the `r8-check` artifact too.
- **Only a device can confirm**, so check these on the first R8 build before promoting it past internal:
  - **Biometric sign-in.** Turning it on, the real OS prompt, and silent re-login after the session is rejected.
    No finger is enrolled on the emulator, so the credential stored behind `requireAuthentication` and
    `BiometricPrompt` never ran under R8. An existing user's stored credential surviving the update is part of
    this: the check proves it only for the plain session token.
  - **A real session with real data.** The stub answers 404 to everything but sign-in, so screens after it
    showed their error states: charts, lists, forms, loans, portfolio operations and reconcile never drew data.
  - **Widgets on a real launcher**, their tap links, and the document picker (Import).

## The update prompt

Home shows an **Update available** card when the store has a newer release, for people with auto-update
turned off (`components/UpdateBanner.tsx`, `hooks/useAppUpdate.ts`, `lib/app-update.ts`). **There is nothing to
do on a release:** both answers come from the store, so there is no version to bump, and a build still in
review never prompts.

- **Android** asks Google Play's in-app update API through the local module `modules/finlynq-app-update`. Play
  answers for this install, so internal testers hear about internal builds. The card's **Update** opens the Play
  listing; there is no in-app download.
- **iOS** asks the public App Store lookup (`itunes.apple.com/lookup?bundleId=com.finlynq.mobile`) and compares
  it with the installed version, so a TestFlight build ahead of the store stays quiet. It also stays quiet when
  the phone's iOS is below the release's minimum. Apple's answer can lag a store release by up to a day.
- **Not now** lasts until the next release (`pf_update_dismissed` in AsyncStorage). It checks when Home opens and
  on returning to the app, at most every 12 hours. A failed check shows nothing.
- **Only a device can confirm the card appearing for real.** Jest covers the logic, and `mobile-r8-check` proves
  the Android module loads under R8 and survives Play having no answer, because the emulator has no Play Store.
  So the first real test is the second release that contains it: install the first from Play, upload the second
  to the same track, and Home should offer it (Play can take a few hours to notice). Until that second release
  exists, the card has nothing to announce.

## Gotchas

- **New iOS target or capability = the owner logs in once.** A new bundle id needs its own provisioning
  profile, and a new capability (the App Group) invalidates the existing ones. A non-interactive build
  can create neither: without an Apple login it stops on the new target, and it would not notice the
  capability on the old one. So the first build after such a change starts with the owner running this
  in a terminal and logging in to Apple; EAS registers the bundle id and App Group and makes the profiles.
  `credentials:configure-build` has no `--non-interactive`. After that the usual command works again.
  ```bash
  npx eas credentials:configure-build --platform ios --profile production
  ```
  Apple refuses this with a 403 ("PLA Update available") whenever a new Program License Agreement is
  waiting, and the same lock covers App Store Connect and its API, so a submit would fail too. Only the
  owner can accept it, under Account at developer.apple.com. Each refused non-interactive attempt still
  uses up a build number; the gap is harmless.
- **The EAS submit queue is slow on the free tier:** build 16 took 7 minutes to build, then waited 40 in
  the queue for a 4-second upload. "Queued" on the submission page is normal.
- **EAS uploads the working copy, uncommitted files included** (`requireCommit` is off). With other work
  in progress in `pf-mobile/`, build from a clean clone so it can't reach TestFlight:
  `git clone --depth 1 --branch mobile-dev https://github.com/finlynq/finlynq.git`, `npm ci` in its
  `mobile/`, and run `eas build` there.
- **Tag points at the version-bump commit.** If you tag before committing the `app.json` bump, the
  Android build ships the OLD marketing version with the new versionCode.
- **versionCode must strictly increase** over the last uploaded build, or Play rejects the upload.
- **No PowerShell here-strings in the Bash tool** for commit/tag messages — use `-F <file>` or a
  plain single-line `-m`.
- **`PLAY_TRACK`** repo variable overrides the default `internal` track for the `mobile-release-v*`
  tag path — check `gh variable list --repo finlynq/finlynq` if a publish lands on the wrong track.
- The biometric/secure-storage work (FINLYNQ-134) and the 401 interceptor (FINLYNQ-135) shipped in
  **1.0.8 / vc16**; **1.0.9 / vc17** re-cut them for the on-device acceptance pass; **1.0.10 / vc18**
  adds the FINLYNQ-134 enable-time credential-capture fix (enabling biometrics while already logged
  in now prompts for the password instead of silently storing nothing) + tokenless bootstrap re-login;
  **1.0.11 / vc19 (Android only)** binds the stored credential to an OS-level auth gate
  (`requireAuthentication`); iOS stayed on 1.0.10 for this one. **1.0.12 / vc20 (Android only)**
  auto-recovers from a `session_locked` (lost-DEK) session via silent re-login instead of
  stranding the user on undecryptable data. **1.0.13 / vc21 (Android only)** moves the biometric
  opt-in onto the login screen (captures the password at login — kills the "enabled but nothing
  stored" footgun). **1.0.14 / vc22 (Android only)** proactively recovers a lost-DEK session on
  open/resume/unlock (consumes the new `/api/auth/session` `encryptionLocked` flag) instead of
  only healing on a write — needs the web change deployed to the target backend.
- **1.0.17 / vc25 (Android only)** adds the **Subscriptions** screen (More → Subscriptions: list +
  calendar views, "found in your transactions" suggestions, weekly → annual incl. semi-annual).
  **Needs the 2026-10-01 web change (`d0db1f9`, merged Subscriptions page) on the target backend:**
  on a server without it, `/api/subscriptions` + `/api/recurring` are dev-mode gated and the screen
  shows "Subscriptions need a newer Finlynq server" for anyone not in dev mode. Promote the web
  change (dev → main) before moving this build past internal testing.
- **1.0.18 / vc26 (Android + iOS)** adds **category reports**: Reports → Categories (month by
  category vs a usual month) → a category's detail (6/12/24-month bars with average + budget,
  top payees, recent transactions); Income statement category rows tap through too. Needs the
  web release with `GET /api/reports/categories` + `/api/reports/category` (PR #356) on the
  target backend; older servers show "Category reports need a newer Finlynq server".
- **1.0.19 / vc27 (Android + iOS)**: fixes from a review of every summary screen against the current
  API. Dashboard in the display currency (was USD for everyone), refetch on focus + error banner,
  month tiles step back to the last complete month; archived accounts handled; Top Movers read the
  aggregated mover (were "+$0"); dividends / realized-gains totals no longer mix currencies; metal
  holdings; Sankey / YoY / 12-month preset / local dates; budgets saved in the display currency.
  The Income statement category tap-through needs PR #357 (income rows carry `categoryId`) on the
  target backend.
- **1.0.20 / vc28 (Android)**: **Transactions calendar** (List / Calendar toggle on the Transactions
  tab; month grid with each day's income, spending and count; tap a day for its transactions) —
  needs `GET /api/transactions/calendar` (prod since 2026-10-07, PR #367). **Cross-currency
  transfers**: an editable "Amount received" field pre-filled from `/api/fx/preview` replaces the old
  "use the web app" refusal. **Transfers edit as a pair** through `PUT /api/transactions/transfer`;
  the server refuses single-leg money edits on the generic route since PR #369, and the app shows
  that message if it ever hits it.
- **1.0.21 / vc29 (Android + iOS)**: everything in 1.0.20 (iOS's first build with it) plus **Week and
  Year calendar views** on the Transactions tab (week = seven days, year = twelve month tiles that open
  the month) — Week/Year need the `start`/`end` form of `GET /api/transactions/calendar` (prod since
  2026-10-07, PR #368; older servers show "Week and Year views need a newer Finlynq server"). And
  **portfolio-operation legs edit in the portfolio form**: any row whose `kind` is a portfolio op
  (incl. the bank-side leg of a brokerage deposit/withdrawal), or that links a holding, shows
  "In Portfolio" instead of the generic Edit (mirrors the web's `startEdit` mapping).
- **1.0.22 / vc31 (Android + iOS build 12)** (the `mobile-release-v30` run was cancelled before its
  publish step, so vc30 was never uploaded; Android was sent to production review the same day,
  2026-10-13): everything that reached the web on 2026-10-12/13. **Loans** (More →
  Loans): what is owed, each payment and end date, paid-off loans behind a toggle; tap a loan for its
  **payment schedule** (the server applies the loan's own manual schedule, edited interest and
  interest method). An account that a loan tracks shows **View loan**. **Cost basis method** (the note
  under Investment returns on the Portfolio tab, and Settings → Investments): simple average or
  advanced lot allocation, the same setting as the web. Reports: a **Yearly** trend period and
  **5 years** / **All time** ranges. Needs the web release of 2026-10-13 (PR #374/#375) on the target
  backend: before it `/api/loans` is Developer-mode only and `/api/settings/lot-allocation` does not
  exist (the Loans screen shows the server's error; the cost basis note is simply absent). Adding or
  changing a loan, its schedule and its interest entries, and changing which lots a sale used, stay on
  the web app.
- **1.0.23 / vc32 (Android internal testing only)** (2026-10-13; not promoted to production and no
  iOS build, pending the owner's check on a device): the things 1.0.22 left to the web. **Loans**: add,
  change and delete a loan (More → Loans → Add loan, or Edit on a loan), with the web form's three ways
  of working out interest and the linked account. **Payment schedule**: tap a payment to set the
  interest the lender really charged, reset edited payments, make the schedule your own and change its
  rows, or go back to the calculated one (`GET/PUT /api/loans/schedule`; uploading a spreadsheet stays
  on the web). **Interest entries** (on a loan): the calculated interest beside what is booked, booking
  one payment or everything due, choosing the interest category, the booked-versus-calculated verdict
  and applying its suggested rate (`/api/loans/interest`). **Sales and lots** (on a holding → Sales):
  each sale with the purchases it was matched to, and changing them with a preview before saving
  (`/api/portfolio/holdings/:id/lots` + `/lots/reassign`). **Currency decimals**: amounts use the
  currency's own decimals (no decimals for yen, three for Kuwaiti dinar), as on the web. Needs the web
  release of 2026-10-13 on the target backend.
- **1.0.24 / vc33 (Android internal testing only)** (2026-10-14; no iOS build): **Sales and lots**
  follows the server's re-matching rules. A sale that sold more than was held now counts that part
  ("N of them sold short") and the editor carries it as a **Sold short** row (sent as lot 0), so the
  total is the whole sale; a sale whose short a later purchase already closed offers no change and
  says why (Rebuild lots on the web re-matches it); a purchase made after the sale can keep only what
  the sale already takes from it. The server side is the web change `7db62e3` + `ddd983e` (on dev
  2026-10-14). Against a server without it, normal sales work as before and an oversold sale's
  re-match is refused (lot 0 fails validation) instead of silently dropping the short, as 1.0.23 did.
- **1.0.25 / vc34 (Android internal testing only)** (2026-10-14; no iOS build): a **month calendar on
  Home**, between the dashboard cards and Recent Transactions (`HomeCalendarCard`). Each day is
  shaded by what was spent (four shades on a square-root scale of the month's biggest day, so one
  large bill doesn't wash the rest out), a green dot marks days with income, and the month's
  income / spending / net sit under the grid. Tapping a day swaps those for the day's figures and a
  **See this day's transactions** button that opens the Transactions calendar on that day; **Open**
  opens the month there (`TransactionsList` takes `calendarDay` / `calendarMonth`, read once then
  cleared). Same data as the Transactions calendar (`GET /api/transactions/calendar?month=`); a
  server without that route hides the card. Pull-to-refresh on Home reloads it too.
- **1.0.26 / vc35 (Android internal testing only)** (2026-10-15; no iOS build): **Loans** are compact
  two-line rows grouped in one block instead of cards (in-app feedback: 17 loans, about three cards to
  a screen). **Email imports** (More → Email imports): record a bank-alert email (account, then a
  category or a transfer destination; amount with a ± flip, date and payee can be corrected; Record
  anyway on a possible duplicate; discard), and review an emailed statement file (choose its account,
  send its rows to the ledger, open Reconcile; discard). Same routes as the web's Email tab and
  /import/pending. **Dates are picked from a calendar** everywhere (transactions, investment entries,
  goals, loans, subscriptions, the email form) instead of typed. **Home calendar** shows what is still
  expected after today: a hollow dot per subscription or detected recurring payment, the list on a
  tapped day, and "Still expected this month" under the totals. **Reconcile** shows the server's note
  when an amount's sign is unusual for the category. The server stopped refusing those (web PR #379,
  prod 2026-10-15); against an older server such a row is still refused with its message.
- **1.0.27 / vc36 (Android + iOS build 13)** (2026-10-15; the owner checked it on a device, then Android was promoted internal → production and sent for review the same day, and iOS build 13 was built on EAS with auto-submit to TestFlight, uploaded 13:10 local, then version 1.0.27 created in App Store Connect with build 13 and submitted for App Review at 13:50 local, "Waiting for Review"): **Email imports**
  reworked after the owner tried 1.0.26 on a device. One list of emails with a **To record /
  Recorded** switch instead of "emails" beside "statement files": a bank-alert email, a
  statement-file email (opens the file review) and an email with no amount in it are all "to
  record"; recorded, rule-recorded, already-recorded and handled statement-file emails are
  "recorded" (discarded emails are left out). Opening an email shows **the email itself** first
  (subject, sender, date, its text; HTML reduced to readable lines, never rendered), then **What we
  read** with the web's "why this needs a look" reasons, then the record form. Recorded emails open
  read-only. Uses `GET /api/import/email-inbox/[id]` (on prod already). Upload and bank-feed files
  waiting for review are no longer listed here (they never were before 1.0.26).
- **1.0.28 / vc37 (Android internal testing only)** (2026-10-24; no iOS build): **Add Account offers
  your own currencies** (in-app feedback: Swiss francs could be chosen as the display currency but
  not for an account). The screen used a fixed CAD / USD / EUR / GBP list and started every new
  account in CAD; it now shows the "Currencies you use" list (`GET /api/settings/active-currencies`,
  the same list as the web's account form and the app's Add Loan / Goal / Subscription), starts a new
  account in the display currency, and has a **More…** list for any other currency. Works against
  any current server; the related web change (a new display currency joins a saved "Currencies you
  use" list, `5382bb3`) is on dev. Also in this build: a waiting email that a rule matched **says why
  it is waiting** and can be **recorded with that rule** in one tap (server side is web PR #381,
  prod since 2026-10-16).
- **1.0.29 / vc38 (Android; no iOS build)** (2026-11-04; promoted internal → production on the owner's word and approved the same day, live as a full rollout; the owner then confirmed the widgets on their Android phone): **Home-screen widgets**
  (GH #392): Left to spend, Upcoming payments, Net worth and Add transaction, added from More → Widgets
  or the launcher, with a Hide amounts switch. Native code. The app writes a snapshot of already-formatted figures after unlock, on returning to the
  foreground and shortly after a save; the widgets only read it and redraw from it every 30 minutes,
  so they hold no session, password or encryption key and they do not fetch on their own. Their
  figures are as of the last time the app was open, and say how old once an hour old. No server
  change: the figures come from `/api/budgets/month`, `/api/subscriptions`, `/api/recurring`,
  `/api/loans`, `/api/loans/schedule` and `/api/dashboard`, all on prod; a server missing one keeps
  that widget on "Open Finlynq to update". **Android only in this build**; iOS came later (see "iOS
  widgets" below). **Bank feed** (More → Bank feed): status and a Sync now button for
  accounts linked on the web (in-app feedback #29). **Entry type** on the investment income/expense
  form: Dividend, Interest, Fee or Other, so a dividend entered on the phone reaches the Dividends
  report without picking its category; this landed on dev in June (`a8d2e84`) and never reached
  mobile-dev.
  To see the widgets without a device, push a tag `mobile-widget-check-<n>`: it builds a debug app,
  hosts every widget on an emulator through a real AppWidgetHost in every scenario, light and dark, and
  leaves the images in the run's artifact (`scripts/widget-render-check.sh`). It uses no versionCode.
  It does not cover the app writing a real snapshot or a real launcher: check those on a device.
- **Next build (not cut yet; ships on the owner's say)**: **Your feedback** (More → Your feedback, in-app
  feedback #30): the user's feedback threads with a "New reply" marker and a count on the More row;
  a thread shows the original message and the replies, with a text reply box. The send form links to
  it. JavaScript only, no native code. No server change: `GET /api/feedback`, `GET /api/feedback/[id]`,
  `POST /api/feedback/[id]/reply` and `POST /api/feedback/[id]/read` are on prod. Attachments show by
  name with a link to the website's `/feedback` page; they don't open in the app, and replies from the
  phone are text only. **Check on a device before promoting:** the reply box stays above the keyboard
  on Android (`KeyboardAvoidingView behavior="padding"`, which no other screen uses on Android; it was
  only seen rendered through react-native-web and in jest), the marker and count clear after opening a
  thread, and on iOS "See your feedback and replies" leaves the send form (it uses `popTo` because a
  card pushed from a modal lands behind it).
- **Update prompt** (native on Android, so it needs a store build): see "The update prompt" above.
- **R8 on Android release builds**: see
  the R8 section above, including what to check on a device before promoting.
- **1.0.29 / iOS build 16 (TestFlight internal group only)** (2026-11-04, from `a9c654c`; not sent to App
  Review, not yet checked on a device). Apple marked it Validated, and App Store Connect's build metadata
  shows the app and `FinlynqWidget.appex` both signed with `group.com.finlynq.mobile`. The last iOS build was
  1.0.27, so this one also carries the 1.0.28 and 1.0.29 changes above and **Your feedback**. It does not
  carry R8, which is Android only, or the switch-off of OTA updates. **iOS widgets** (GH #392):
  the Android widgets on iOS 16.1+: **Left to spend** (small, Lock Screen circular), **Upcoming payments**
  (medium, Lock Screen rectangular), **Net worth** (small, medium), **Add transaction** (small). Added
  from the home screen, since iOS has no "add this widget" prompt; More → Widgets holds Hide amounts and
  Refresh now and explains how. No server change, and the same rules as Android: the extension only reads
  a snapshot of already-formatted figures from the App Group, holds no session, password or encryption
  key, never fetches, and redraws hourly and at midnight so dates and "Updated 2h ago" stay right. The
  figures are `privacySensitive()`, on top of Hide amounts. The snapshot file is out of iCloud backups,
  readable while locked but not after a restart until the first unlock, and deleted on sign-out; iOS does
  not say when the last widget goes, so the app deletes it when next opened with none left.
  **To see them without a Mac or a device, push a tag `mobile-ios-widget-check-<n>`:** it publishes
  nothing, uses no build number and costs no EAS build. One job compiles the extension's Swift against its
  deployment target and draws every widget in every scenario, light and dark, on the smallest and largest
  iPhone sizes (`scripts/ios-widget-render-check.sh`; artifact `widget-render-ios`, 26 sheets: read them,
  the first green run still had a label spilling out of a ring). The other runs a real prebuild and a
  Release build of the whole app, signed only to run locally, and starts it on a simulator (artifact
  `widget-render-ios-app`, its first screen should be the login).
  It draws through `ImageRenderer`, not WidgetKit, so **only a device can confirm:** widgets appear in the
  gallery and on the Lock Screen; the figures arrive after opening the app (`getCurrentConfigurations`
  really reports a placed widget, else More → Widgets → Refresh says "Add a widget first"); the app and the
  extension really share the file through the App Group; taps open the right screens, also from a cold start
  and while locked; the Lock Screen redacts while locked and uses its own colours; Hide amounts updates the
  widgets at once; sign-out empties them. If a check run says "The job was not acquired by Runner", GitHub
  had no `macos-15` free: re-run it later.
- **Next build (not cut yet)**: **a stored value that can't be read at startup goes to the login screen**
  (`2094c72`). The app used to wait on those reads with nothing to catch a failure, so a keychain that
  refused the session token left it on its spinner for good, with nothing to tap. The token stays stored for
  the next launch, and a self-hosted server address is kept. JavaScript only. Seen on an unsigned simulator
  build, spinner before and login after, and pinned in `useAuth.test.tsx`; not in iOS build 16 or Android vc38.
