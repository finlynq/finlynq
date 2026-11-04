#!/usr/bin/env bash
# Runs on a macOS runner (see .github/workflows/mobile-ios-widget-check.yml), from
# mobile/. Compiles the extension's Swift with a small host app, draws every widget
# in each scenario, light and dark, on a simulator and saves the sheets under
# ./widget-render-ios. Compiling for the extension's own deployment target also
# catches a newer API used without an availability check.
set -euo pipefail

BUNDLE_ID=com.finlynq.widgetpreview
OUT=widget-render-ios
HOST="$RUNNER_TEMP/WidgetPreview.app"
EXPECTED_IMAGES=26
mkdir -p "$OUT" "$HOST"

sources=()
for file in targets/widget/*.swift; do
  # The host brings its own @main.
  [ "$(basename "$file")" = "FinlynqWidgetBundle.swift" ] || sources+=("$file")
done
sources+=(scripts/ios-widget-preview/WidgetPreviewHost.swift)

xcrun --sdk iphonesimulator swiftc \
  -target arm64-apple-ios16.1-simulator \
  -parse-as-library \
  -o "$HOST/WidgetPreview" \
  "${sources[@]}"

cp modules/finlynq-widgets/android/src/debug/assets/widget-snapshot.sample.json "$HOST/"
cat > "$HOST/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleExecutable</key><string>WidgetPreview</string>
  <key>CFBundleName</key><string>WidgetPreview</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>MinimumOSVersion</key><string>16.1</string>
  <key>UILaunchScreen</key><dict/>
</dict>
</plist>
PLIST
codesign --force --sign - "$HOST"

device=$(xcrun simctl list devices available -j | node -e "
  let s = '';
  process.stdin.on('data', (d) => (s += d)).on('end', () => {
    const phones = Object.values(JSON.parse(s).devices).flat().filter((d) => d.name.startsWith('iPhone'));
    if (!phones.length) process.exit(1);
    console.log(phones[phones.length - 1].udid);
  });
")
xcrun simctl boot "$device"
xcrun simctl bootstatus "$device" -b > /dev/null
xcrun simctl install "$device" "$HOST"
xcrun simctl launch "$device" "$BUNDLE_ID" > /dev/null

data=$(xcrun simctl get_app_container "$device" "$BUNDLE_ID" data)
for _ in $(seq 1 90); do
  [ -f "$data/Documents/DONE" ] && break
  sleep 2
done
cp "$data"/Documents/*.png "$OUT/" 2> /dev/null || true
xcrun simctl shutdown "$device" || true

count=$(find "$OUT" -name '*.png' | wc -l | tr -d ' ')
echo "Saved $count sheets"
if [ ! -f "$data/Documents/DONE" ] || [ "$count" -ne "$EXPECTED_IMAGES" ]; then
  echo "::error::Expected $EXPECTED_IMAGES sheets, got $count"
  exit 1
fi
