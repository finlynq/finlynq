#!/usr/bin/env bash
# Runs on a booted Android emulator (see .github/workflows/mobile-r8-check.yml).
# R8 breaks reflection-heavy code only at runtime, so this runs the minified app:
#   1. as-shipped.apk, untouched: cold start to the login screen, native module there.
#   2. check.apk: every widget drawn, through scripts/widget-render-check.sh.
#   3. check.apk: signs in against a stub server, opens every tab and a few screens,
#      then force-stops and comes back signed in, which reads the session back out
#      of expo-secure-store.
#   4. check-no-r8.apk signed in, then check.apk installed over it: the update every
#      existing user gets, with the session written without R8 and read with it.
# Fails on a crash, a missing native module, or a class or method R8 took away.
# It can't do a real biometric prompt, or a real server's data: see the runbook.
set -uo pipefail

PKG=com.finlynq.mobile
OUT=r8-check
STUB_PORT=8788
STUB_URL="http://10.0.2.2:$STUB_PORT"
UI=/sdcard/r8-ui.xml
fail=0

err() { echo "::error::$*"; fail=1; }

# The text the app's own JS logged since the last `logcat -c`.
js_log() { adb logcat -d -s ReactNativeJS:V; }

wait_for_js_log() { # pattern, seconds
  local pattern=$1 left=$2
  while [ "$left" -gt 0 ]; do
    if js_log | grep -q "$pattern"; then return 0; fi
    sleep 2
    left=$((left - 2))
  done
  return 1
}

# Clears a system "isn't responding" dialog if one got up before the setting below
# took effect: one over the app hides everything under it from uiautomator. The app's
# own ANR still fails the run, from the log.
dump_ui() {
  local tries=5 xy
  while [ "$tries" -gt 0 ]; do
    if adb shell uiautomator dump "$UI" 2>/dev/null | grep -q 'dumped to'; then
      adb exec-out cat "$UI" > "$OUT/ui.xml"
      xy=$(find_node "Close app") || return 0
      # shellcheck disable=SC2086
      adb shell input tap $xy
    fi
    sleep 2
    tries=$((tries - 1))
  done
  echo "::warning::uiautomator could not dump the screen"
  return 1
}

# Centre of the Nth (default last) node with this exact text, or of the Nth edit
# field when the "text" is `edit:N`.
find_node() {
  python3 - "$OUT/ui.xml" "$1" <<'PY'
import re, sys, xml.etree.ElementTree as ET
path, wanted = sys.argv[1], sys.argv[2]
nodes = list(ET.parse(path).getroot().iter("node"))
if wanted.startswith("edit:"):
    edits = [n for n in nodes if n.get("class") == "android.widget.EditText"]
    index = int(wanted.split(":")[1])
    hits = edits[index:index + 1] if index >= 0 else edits[index:]
else:
    hits = [n for n in nodes if wanted in (n.get("text"), n.get("content-desc"))][-1:]
if not hits:
    sys.exit(1)
l, t, r, b = map(int, re.findall(r"\d+", hits[0].get("bounds")))
print((l + r) // 2, (t + b) // 2)
PY
}

shows_text() { dump_ui && find_node "$1" > /dev/null; }

tap() { # text; returns non-zero if it isn't on screen
  dump_ui || return 1
  local xy
  xy=$(find_node "$1") || { echo "::warning::'$1' is not on screen"; return 1; }
  # shellcheck disable=SC2086
  adb shell input tap $xy
  sleep 2
}

hide_keyboard() {
  if adb shell dumpsys input_method | grep -q 'mInputShown=true'; then
    adb shell input keyevent KEYCODE_BACK
    sleep 1
  fi
}

shot() {
  dump_ui || true
  adb exec-out screencap -p > "$OUT/screen-$1.png"
}

start_app() {
  adb shell am force-stop "$PKG"
  adb logcat -c
  adb shell am start -W -n "$PKG/.MainActivity" > /dev/null
}

sign_in() { # label, for errors and the screenshot
  start_app
  wait_for_js_log 'native module' 90 || err "$1: JS never logged the widgets native module line"
  sleep 3
  # The server field sits behind a toggle under the form, so set it up first.
  tap "Server: https://finlynq.com" || err "$1: no server toggle on the login screen"
  tap "edit:-1"
  adb shell input keyevent KEYCODE_MOVE_END
  for _ in $(seq 1 30); do adb shell input keyevent KEYCODE_DEL; done
  adb shell input text "$STUB_URL"
  hide_keyboard
  tap "edit:0"
  adb shell input text "r8check"
  hide_keyboard
  tap "edit:1"
  adb shell input text "not-a-real-password"
  hide_keyboard
  shot "$1-signin-filled"
  tap "Sign In" || err "$1: no Sign In button"
  wait_for_js_log 'sign-in succeeded' 30 || err "$1: sign-in against the stub did not succeed"
}

# 1. The APK as shipped ------------------------------------------------------------
adb wait-for-device
# The launcher tends to ANR on a software-rendered emulator, and its dialog sat over
# the app for the whole of an earlier run. The app's own ANR is caught from the log.
adb shell settings put global hide_error_dialogs 1
adb install -r "$OUT/as-shipped.apk" || err "as-shipped.apk would not install"
start_app
wait_for_js_log 'native module' 90 || err "as-shipped: JS never logged the widgets native module line"
sleep 5
shot as-shipped-login
js_log > "$OUT/logcat-js-as-shipped.txt"
adb logcat -d > "$OUT/logcat-as-shipped.txt"
grep -q 'native module.*true' "$OUT/logcat-js-as-shipped.txt" \
  || err "as-shipped: the widgets native module is not available"
shows_text "Sign In" || err "as-shipped: the login screen did not render"
# OTA is off (app.json), so the app must not be asking the update server.
if grep -q 'Remote update request|Failed to download remote update' "$OUT/logcat-as-shipped.txt"; then
  err "as-shipped: the app asked the update server, but OTA should be off"
fi
adb shell am force-stop "$PKG"
adb uninstall "$PKG" > /dev/null
# The widget service hears about an uninstall late. Installing again before it has
# means it drops the new install's widgets, and the first bind finds none.
for _ in $(seq 1 30); do
  adb shell dumpsys appwidget | grep "$PKG/com.finlynq.widgets" > /dev/null || break
  sleep 1
done

# 2. Every widget, minified --------------------------------------------------------
APK="$OUT/check.apk" OUT="$OUT/widgets" bash scripts/widget-render-check.sh \
  || err "The widget render check failed on the minified build"

# 3. Sign in against the stub, and come back ---------------------------------------
node scripts/r8-check-stub.mjs "$STUB_PORT" > "$OUT/stub.log" 2>&1 &
stub_pid=$!
trap 'kill "$stub_pid" 2>/dev/null || true' EXIT

sign_in check
sleep 6
shot home

for tab in Accounts Portfolio Transactions More; do
  tap "$tab" || err "check: no $tab tab, so the main screens did not render"
  sleep 3
  shot "tab-$tab"
done

# A few pushed screens, so react-native-screens does a real transition. Widgets also
# makes real calls into the native module. Settings reads the biometric status.
for screen in Budgets Widgets Settings; do
  tap "More"
  if tap "$screen"; then
    sleep 3
    shot "screen-$screen"
    adb shell input keyevent KEYCODE_BACK
    sleep 2
  else
    adb shell input swipe 500 1800 500 600 400
    sleep 1
    if tap "$screen"; then
      sleep 3
      shot "screen-$screen"
      adb shell input keyevent KEYCODE_BACK
      sleep 2
    else
      err "check: could not reach the $screen screen"
    fi
  fi
done
js_log > "$OUT/logcat-js-signed-in.txt"
adb logcat -d > "$OUT/logcat-signed-in.txt"
# Home asks Play for a newer release. Play can't answer on this emulator, so this is
# the failure path: the module loads under R8 and a failed check does no harm.
grep -q "update:', 'checked'" "$OUT/logcat-js-signed-in.txt" \
  || err "check: Home never finished its check for a new release"

# A cold start reads the token back through expo-secure-store and its Record options.
# The logger redacts hasStoredToken, but bootstrap only asks for the session when it
# got a token back, so that request is the evidence.
start_app
wait_for_js_log 'api/auth/session.*200' 90 \
  || err "check: the session token did not come back out of expo-secure-store"
sleep 10
shot restored
js_log > "$OUT/logcat-js-restored.txt"
adb logcat -d > "$OUT/logcat-restored.txt"
shows_text "Accounts" || err "check: did not come back signed in after a restart"
adb shell am force-stop "$PKG"

# 4. The update every user gets ----------------------------------------------------
adb uninstall "$PKG" > /dev/null
adb install "$OUT/check-no-r8.apk" || err "update: check-no-r8.apk would not install"
sign_in update
sleep 3
adb shell am force-stop "$PKG"
adb install -r "$OUT/check.apk" || err "update: check.apk would not install over check-no-r8.apk"
start_app
wait_for_js_log 'api/auth/session.*200' 90   || err "update: the session stored without R8 did not come back with R8"
sleep 10
shot updated
js_log > "$OUT/logcat-js-updated.txt"
adb logcat -d > "$OUT/logcat-updated.txt"
shows_text "Accounts" || err "update: signed out by the update to R8"
adb shell am force-stop "$PKG"

adb logcat -d -b crash > "$OUT/logcat-crash-buffer.txt" || true

# The verdict ----------------------------------------------------------------------
if grep -q "$PKG" "$OUT/logcat-crash-buffer.txt"; then
  err "The crash buffer names the app"
  head -60 "$OUT/logcat-crash-buffer.txt"
fi

# What a class or method R8 removed or renamed looks like, in the app's own lines.
casualties='ANR in |NoSuchMethodError|NoSuchFieldError|NoClassDefFoundError|ClassNotFoundException|AbstractMethodError|IncompatibleClassChangeError|KotlinReflectionInternalError|ExceptionInInitializerError|FATAL EXCEPTION|Unable to instantiate|Cannot find native module|Unhandled JS Exception'
for log in "$OUT"/logcat-as-shipped.txt "$OUT"/logcat-signed-in.txt "$OUT"/logcat-restored.txt "$OUT"/logcat-updated.txt; do
  pid_lines=$(grep -E "$casualties" "$log" | grep -E "ReactNative|AndroidRuntime|$PKG|expo\.|com\.facebook|com\.swmansion|com\.finlynq" || true)
  if [ -n "$pid_lines" ]; then
    err "A class or method went missing, or the app crashed, in $log"
    echo "$pid_lines" | head -30
  fi
done

echo "Stub saw:"
sort "$OUT/stub.log" | uniq -c | sort -rn | head -40
rm -f "$OUT/ui.xml"
exit "$fail"
