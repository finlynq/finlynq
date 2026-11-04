#!/usr/bin/env bash
# What R8 did to a build, from the files .github/workflows/mobile-r8-check.yml keeps
# in the folder given as $1 (as-shipped.apk, as-shipped.aab, no-r8.apk, mapping.txt).
# Fails if the bundle would reach Play without its mapping file. Prints markdown.
set -euo pipefail

dir=$1
bundle_mapping=BUNDLE-METADATA/com.android.tools.build.obfuscation/proguard.map

fail=0
if unzip -l "$dir/as-shipped.aab" | grep -q "$bundle_mapping"; then
  bundle_note="yes ($bundle_mapping)"
else
  bundle_note="NO"
  echo "::error::The bundle has no $bundle_mapping, so Play would not get a mapping file" >&2
  fail=1
fi

mb() { awk -v b="$1" 'BEGIN { printf "%.1f", b / 1048576 }'; }
dex_bytes() { unzip -l "$1" | awk '$4 ~ /^classes[0-9]*\.dex$/ { sum += $1 } END { print sum + 0 }'; }

off_apk=$(stat -c %s "$dir/no-r8.apk")
on_apk=$(stat -c %s "$dir/as-shipped.apk")
off_dex=$(dex_bytes "$dir/no-r8.apk")
on_dex=$(dex_bytes "$dir/as-shipped.apk")

# A mapping line for a class is `original.Name -> new.Name:` with no indent.
classes=$(grep -c ' -> .*:$' <(grep -v '^[ #]' "$dir/mapping.txt") || true)
renamed=$(grep -v '^[ #]' "$dir/mapping.txt" | awk '/ -> .*:$/ { to = $3; sub(/:$/, "", to); if ($1 != to) n++ } END { print n + 0 }')
pct=$(awk -v a="$renamed" -v b="$classes" 'BEGIN { printf "%.0f", b ? 100 * a / b : 0 }')

cat <<EOF
### What R8 did (x86_64 only)

| | R8 off | R8 on | Saved |
|---|---|---|---|
| APK | $(mb "$off_apk") MB | $(mb "$on_apk") MB | $(mb $((off_apk - on_apk))) MB |
| classes*.dex in it | $(mb "$off_dex") MB | $(mb "$on_dex") MB | $(mb $((off_dex - on_dex))) MB |

Classes left after shrinking: $classes, of which renamed: $renamed ($pct%).

Mapping inside the bundle: $bundle_note
EOF
exit "$fail"
