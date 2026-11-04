#!/usr/bin/env bash
# Runs on a booted Android emulator (see .github/workflows/mobile-widget-check.yml).
# Hosts every widget through a real AppWidgetHost in each scenario, in light and
# dark, saves what it drew under ./widget-render, and fails on a crash, a widget
# that would not bind or a missing native module.
set -euo pipefail

PKG=com.finlynq.mobile
PREVIEW="$PKG/com.finlynq.widgets.WidgetPreviewActivity"
OUT=widget-render
APK=android/app/build/outputs/apk/debug/app-debug.apk
mkdir -p "$OUT"

adb wait-for-device
adb install -r "$APK"
adb shell appwidget grantbind --package "$PKG" --user 0
adb logcat -c

for mode in no yes; do
  adb shell cmd uimode night "$mode"
  label=$([ "$mode" = yes ] && echo dark || echo light)
  for scenario in sample hidden warn over no-budget long stale nothing-due empty corrupt; do
    adb shell am force-stop "$PKG"
    adb shell am start -W -n "$PREVIEW" --es scenario "$scenario" > /dev/null
    sleep 5
    adb exec-out screencap -p > "$OUT/screen-$scenario-$label.png"
  done
done
adb shell cmd uimode night no

adb pull "/sdcard/Android/data/$PKG/files/preview" "$OUT/widgets" > /dev/null

# The app itself: JS boots with the native module present (the login screen shows).
adb shell am force-stop "$PKG"
adb logcat -c
adb shell am start -W -n "$PKG/.MainActivity" > /dev/null
sleep 25
adb exec-out screencap -p > "$OUT/screen-app.png"
adb logcat -d -s ReactNativeJS:V > "$OUT/logcat-js.txt" || true
adb logcat -d > "$OUT/logcat.txt" || true

fail=0
if grep -q "PREVIEW_BIND_FAILED" "$OUT/logcat.txt"; then echo "::error::A widget would not bind"; fail=1; fi
if grep -qE "FATAL EXCEPTION|Couldn't load|Failed to inflate|Can't load widget" "$OUT/logcat.txt"; then
  echo "::error::Crash or widget inflate failure in logcat"
  grep -nE -A12 "FATAL EXCEPTION|Couldn't load|Failed to inflate" "$OUT/logcat.txt" | head -60 || true
  fail=1
fi
if ! grep -q '"available":true\|available: true\|available.*true' "$OUT/logcat-js.txt"; then
  echo "::error::JS did not report the native widget module as available"
  tail -40 "$OUT/logcat-js.txt" || true
  fail=1
fi
count=$(find "$OUT/widgets" -name '*.png' | wc -l)
echo "Saved $count widget images"
[ "$count" -ge 100 ] || { echo "::error::Expected at least 100 widget images, got $count"; fail=1; }
exit "$fail"
