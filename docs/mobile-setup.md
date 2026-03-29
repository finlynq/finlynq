# Mobile Setup Guide

The PF mobile app is a React Native (Expo) application that connects to your PF web server. It provides Dashboard, Transactions, Import, Budgets, and Settings screens on iOS and Android.

## Prerequisites

- **PF web server** running on your computer (or a hosted deployment)
- **Node.js** 18 or later
- **Expo Go** app installed on your phone ([iOS](https://apps.apple.com/app/expo-go/id982107779) / [Android](https://play.google.com/store/apps/details?id=host.exp.exponent))
- Phone and computer on the **same local network** (for local server mode)

## Installation

```bash
cd mobile
npm install
```

## Start the Mobile App

```bash
cd mobile
npx expo start
```

This launches the Expo development server and displays a QR code in your terminal.

### Connect from Your Phone

1. Open **Expo Go** on your phone
2. Scan the QR code shown in the terminal
3. The app will load on your device

## Connecting to the PF Server

The mobile app connects to the PF Next.js backend to access your financial data. The default server URL is `http://localhost:3000`.

### Local Network Setup

When running PF on your computer and the mobile app on your phone:

1. Start the PF web server on your computer:
   ```bash
   npm run dev
   ```

2. Find your computer's local IP address:
   - **macOS**: System Settings > Wi-Fi > Details > IP Address (e.g., `192.168.1.100`)
   - **Windows**: `ipconfig` in Command Prompt, look for IPv4 Address
   - **Linux**: `hostname -I` or `ip addr show`

3. In the mobile app, go to **Settings** and set the server URL to:
   ```
   http://192.168.1.100:3000
   ```
   (Replace with your computer's actual IP address)

4. Make sure both devices are on the same Wi-Fi network.

### Hosted Server Setup

If you deploy PF to a hosted server (e.g., a VPS or cloud service):

1. Set the server URL in the mobile app's Settings to your hosted URL:
   ```
   https://your-pf-server.example.com
   ```

2. Ensure your server has HTTPS enabled for security.

## Unlocking

The mobile app shows an **Unlock** screen on launch, just like the web app. Enter your passphrase to decrypt and access your data. The passphrase is sent to the PF server over your local network (or HTTPS for hosted setups) and is not stored on the device.

## Available Screens

| Screen | Description |
|--------|-------------|
| **Dashboard** | Net worth overview, spending summaries, financial health |
| **Transactions** | Browse and filter your transactions |
| **Import** | Import transactions from files |
| **Budgets** | View budget progress and spending by category |
| **Settings** | Server URL configuration, lock/unlock, preferences |

## Troubleshooting

### "Network request failed" or can't connect

- Verify the PF web server is running (`npm run dev`)
- Check that your phone and computer are on the same Wi-Fi network
- Confirm the server URL uses your computer's **local IP** (not `localhost` or `127.0.0.1`)
- Some firewalls block port 3000 -- add an exception if needed

### App loads but shows no data

- Make sure you've unlocked the database (enter your passphrase on the unlock screen)
- Check the server URL in Settings points to the correct address
- Verify the web app works in a browser at the same URL

### Expo Go won't scan the QR code

- Ensure both devices are on the same network
- Try pressing `s` in the Expo terminal to switch to Expo Go mode
- On Android, use the Expo Go app's built-in scanner; on iOS, use the Camera app

## Building for Production

To create a standalone app (without Expo Go):

```bash
cd mobile
npx expo prebuild
npx expo run:ios     # or run:android
```

For app store distribution, see the [Expo build documentation](https://docs.expo.dev/build/introduction/).
