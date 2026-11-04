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
adb logcat -d > "$OUT/logcat-widgets.txt" || true

# The app itself: JS boots with the native module present (the login screen shows).
adb shell am force-stop "$PKG"
adb logcat -c
adb shell am start -W -n "$PKG/.MainActivity" > /dev/null
sleep 25
adb exec-out screencap -p > "$OUT/screen-app.png"
adb logcat -d -s ReactNativeJS:V > "$OUT/logcat-js.txt" || true
adb logcat -d > "$OUT/logcat-app.txt" || true

failure_lines="FATAL EXCEPTION|Failed to inflate|Error inflating AppWidget|updateAppWidget couldn't find remote view|could not draw"
fail=0
if grep -q "PREVIEW_BIND_FAILED" "$OUT/logcat-widgets.txt"; then echo "::error::A widget would not bind"; fail=1; fi
scenarios_done=$(grep -c "PREVIEW_DONE" "$OUT/logcat-widgets.txt" || true)
echo "Preview finished $scenarios_done times"
[ "$scenarios_done" -eq 20 ] || { echo "::error::Expected 20 finished previews, got $scenarios_done"; fail=1; }
for log in "$OUT/logcat-widgets.txt" "$OUT/logcat-app.txt"; do
  if grep -qE "$failure_lines" "$log"; then
    echo "::error::Crash or widget failure in $log"
    grep -nE -A12 "$failure_lines" "$log" | head -60 || true
    fail=1
  fi
done
if ! grep -q '"available":true\|available: true\|available.*true' "$OUT/logcat-js.txt"; then
  echo "::error::JS did not report the native widget module as available"
  tail -40 "$OUT/logcat-js.txt" || true
  fail=1
fi
count=$(find "$OUT/widgets" -name '*.png' | wc -l)
echo "Saved $count widget images"
[ "$count" -ge 120 ] || { echo "::error::Expected at least 120 widget images, got $count"; fail=1; }
exit "$fail"
