# Mobile Setup Guide

Finlynq has a companion mobile app — a React Native (Expo) client for iOS and Android that connects to your Finlynq backend (hosted or self-hosted). It covers the Dashboard, Transactions, Import, Budgets, and Settings screens. It's a client only: it talks to your Finlynq server over HTTP(S) and signs in with the same account you use on the web.

> The mobile app is optional and evolving. The web app at [finlynq.com/cloud](https://finlynq.com/cloud) is the primary, fully-featured way to use Finlynq.

## Prerequisites

- A **Finlynq account** (sign up at [finlynq.com/cloud](https://finlynq.com/cloud), or on your own self-hosted server).
- A reachable **Finlynq backend**: either the hosted service, or your self-hosted server running and on the same network as your phone.
- **Node.js** 20 or later (to run the dev server).
- The **Expo Go** app on your phone ([iOS](https://apps.apple.com/app/expo-go/id982107779) / [Android](https://play.google.com/store/apps/details?id=host.exp.exponent)).

## Run the app

The mobile project lives in `pf-app/mobile/`:

```bash
cd pf-app/mobile
npm install
npx expo start
```

Expo prints a QR code in your terminal. Open **Expo Go** on your phone and scan it (use the in-app scanner on Android, or the Camera app on iOS) — the app loads on your device.

## Point the app at your server

The app needs to know where your Finlynq backend lives. It defaults to the hosted service (`https://finlynq.com`). To change it, tap **Server** on the sign-in screen to reveal the URL field — handy on first run, before you have a session. Once you're signed in you can change it any time from the **Settings** screen.

### Hosted backend

Use the hosted URL:

```
https://finlynq.com
```

### Self-hosted on your own network

When your Finlynq server runs on your computer and the app runs on your phone, `localhost` won't work — the phone needs your computer's **local network IP**:

1. Start your Finlynq server (`npm run dev` in `pf-app/`).
2. Find your computer's LAN IP:
   - **macOS** — System Settings → Wi-Fi → Details → IP Address (e.g. `192.168.1.100`)
   - **Windows** — run `ipconfig` and look for the IPv4 Address
   - **Linux** — `hostname -I` or `ip addr show`
3. In the app's Settings, set the server URL to that IP and port, e.g.:
   ```
   http://192.168.1.100:3000
   ```
4. Make sure the phone and computer are on the **same Wi-Fi network**.

For a self-hosted server you want to reach from anywhere, put it behind a reverse proxy (Caddy, nginx, or a Cloudflare Tunnel) with HTTPS and use that public `https://...` URL instead.

## Sign in

The app signs you in with your **Finlynq account** — the same username (or email) and password you use on the web. You can also **create an account** from the sign-in screen (a username is required; an email is optional and used only for password recovery). Sessions are stored securely on the device. If your device supports it, you can enable **biometric unlock** (Face ID / fingerprint) and an **auto-lock** timeout in Settings, so the app re-locks after a period in the background. Auto-lock only takes effect when biometric unlock is enabled — otherwise there'd be no way back in short of signing in again.

> There's no separate "passphrase" — your account password is what unlocks your data, and your encryption key is derived from it server-side, exactly as on the web.

## Available screens

| Screen | Description |
|--------|-------------|
| **Dashboard** | Net worth, spending summaries, and financial-health overview |
| **Transactions** | Browse, filter, add, and edit transactions |
| **Import** | Upload and review transactions from files |
| **Budgets** | Budget progress and spending by category |
| **Settings** | Server URL, sign-out, biometric unlock, and auto-lock |

## Troubleshooting

### "Network request failed" or can't connect

- Confirm your Finlynq server is running and reachable.
- Check that your phone and computer are on the same Wi-Fi network.
- Use your computer's **local IP** in the server URL — not `localhost` or `127.0.0.1`.
- Some firewalls block port 3000 — add an exception if needed.
- For a hosted or remote server, make sure the URL uses **https://** and is publicly reachable.

### App loads but shows no data

- Make sure you're signed in (the app should show your dashboard, not the sign-in screen).
- Verify the server URL in Settings points to the right backend.
- Confirm the same account works in a browser at the same URL.

### Sign-in fails

- Passwords are case-sensitive. Use the same credentials that work on the web.
- If you recently restarted a self-hosted server, sign in again to reload your session.

### Expo Go won't scan the QR code

- Ensure both devices are on the same network.
- Try pressing `s` in the Expo terminal to switch to Expo Go mode.
- On Android use Expo Go's built-in scanner; on iOS use the Camera app.

## Building a standalone app (installable APK)

The reliable path is a cloud build with **EAS Build** — it compiles on Expo's Linux
infrastructure, so it works regardless of your local OS/CPU (local `expo prebuild` /
`expo run:android` require a full local Android/Xcode toolchain and fail outright on
Windows-on-ARM64). One-time setup needs an Expo account (`eas login`) and an EAS
project (`eas init`); the build profiles live in [`mobile/eas.json`](../mobile/eas.json).

```bash
cd pf-app/mobile
# internal-distribution APK you can sideload onto an Android device:
EAS_NO_VCS=1 npx eas-cli build --platform android --profile preview
```

EAS prints a build page with a QR + a downloadable `.apk`. On Android, open it and
allow "install from this source". iOS device builds additionally require a paid
Apple Developer account (or EAS's Mac workers). See the
[EAS Build docs](https://docs.expo.dev/build/introduction/).

### Build gotchas (read before changing mobile deps/config)

- **Dependencies must match the installed Expo SDK.** After any dependency change, run
  `npx expo install --fix` and `npx expo-doctor`. Mismatched native module versions
  (e.g. a too-new `@react-native-async-storage/async-storage`) fail the Android gradle
  build with unresolved-artifact errors.
- **`babel.config.js` must use `babel-preset-expo`** (plus `react-native-worklets/plugin`
  for Reanimated). Do **not** add `loose: true` private-field/class-property transforms —
  they break `event-target-shim` (which RN's `fetch`/`AbortController` use) with
  `TypeError: cannot assign to read-only property 'NONE'`, making every network request
  throw. Hermes handles private fields natively in the cloud build.
- **Sign-in uses the session cookie.** Login returns an httpOnly `pf_session` cookie
  (no token in the body); React Native's native cookie jar carries it on subsequent
  requests. The app treats HTTP 200 as a successful login. Point the app at your server
  via the server-URL field on the sign-in screen (or the Settings screen).
