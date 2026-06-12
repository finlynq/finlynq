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
- **iOS build:** EAS cloud build + auto-submit to App Store Connect (→ TestFlight).
- **Auth needed:** `gh` logged in (HussienH) for the Android tag/CI; `eas` logged in
  (`eas whoami` → hussein.halawi). EAS holds the iOS dist cert, provisioning profile, and ASC API
  key on its servers, so a non-interactive build resolves credentials itself.

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

## Gotchas

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
  in now prompts for the password instead of silently storing nothing) + tokenless bootstrap re-login.
