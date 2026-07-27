#!/usr/bin/env bash
#
# Post-deploy smoke check — the gate that decides whether a deploy worked.
#
# Usage: smoke-check.sh <base-url> [timeout-seconds]
#   e.g. smoke-check.sh http://localhost:3456 90
#
# Exits 0 only if the app is genuinely serving. Exits 1 otherwise — and that
# non-zero exit is the whole point of this file. Both callers (deploy.sh step 8
# and the "Verify deployment" step in deploy-{prod,dev}.yml) previously ran a
# single `curl ... || echo "app may still be warming up"`, which cannot fail:
# the `|| echo` swallows the error and, being the last command, leaves the exit
# code at 0. A production deploy that came back 500-ing on every request was
# reported as green. Do not reintroduce a `|| echo` / `|| true` around these
# checks — a check that cannot fail is not a check.
#
# Three signals, chosen to be unauthenticated, side-effect-free, and to cover
# distinct failure modes:
#   1. /api/healthz        — process is up AND the DB pool is live (503 if not)
#   2. /                   — Next is rendering pages, not just answering API routes
#   3. /api/auth/session   — the auth stack + JSON serialization work end to end
#
# Only (1) is retried. It is the readiness gate: a fresh `systemctl restart`
# needs time to boot and for instrumentation.ts to bring up the DB adapter.
# Once healthz is green the app is warm, so (2) and (3) get one shot each —
# retrying them would just mask a real intermittent fault.

set -uo pipefail

BASE_URL="${1:-}"
TIMEOUT="${2:-90}"
POLL_INTERVAL=3

if [ -z "$BASE_URL" ]; then
  echo "ERROR: usage: smoke-check.sh <base-url> [timeout-seconds]" >&2
  exit 2
fi

BASE_URL="${BASE_URL%/}"

# Fetch a path; sets HTTP_STATUS and HTTP_BODY. Returns non-zero only when the
# request itself failed (connection refused, timeout) — an HTTP error status is
# reported through HTTP_STATUS so callers can assert on it.
fetch() {
  local path="$1"
  local raw
  # Deliberately no `-f`: a 500 body is the most useful thing to print when
  # diagnosing, and -f would discard it.
  raw="$(curl -sS --max-time 15 -w $'\n%{http_code}' "${BASE_URL}${path}" 2>&1)"
  local rc=$?
  if [ $rc -ne 0 ]; then
    HTTP_STATUS="000"
    # curl still emits the -w status line on failure; strip it so the diagnostic
    # shows only the actual error text ("Failed to connect to ...").
    HTTP_BODY="${raw%$'\n'*}"
    return 1
  fi
  HTTP_STATUS="${raw##*$'\n'}"
  HTTP_BODY="${raw%$'\n'*}"
  return 0
}

fail() {
  echo ""
  echo "==> SMOKE CHECK FAILED: $1"
  echo "    URL:    ${BASE_URL}${2:-}"
  echo "    Status: ${HTTP_STATUS:-n/a}"
  if [ -n "${HTTP_BODY:-}" ]; then
    echo "    Body:   $(printf '%s' "$HTTP_BODY" | head -c 500)"
  fi
  echo ""
  echo "    The deploy has ALREADY been applied — the new code is live and broken."
  echo "    To roll back: revert the merge commit on main and let the deploy re-run."
  echo "    If this release included a database migration, restoring is NOT just a"
  echo "    revert — see scripts/restore-backup.sh and the pre-deploy dump in"
  echo "    /opt/finlynq-backups/ (newest file is from minutes ago)."
  exit 1
}

echo "==> Smoke check against ${BASE_URL} (readiness timeout ${TIMEOUT}s)"

# ── 1. Readiness gate: /api/healthz must return 200 with status "ok" ─────────
# healthz returns 503 when the DB pool is down, so a plain status check already
# covers "process alive but database unreachable". The body assertion guards
# against a future check being added that degrades without changing the code.
DEADLINE=$(( SECONDS + TIMEOUT ))
READY=false
ATTEMPT=0

while [ $SECONDS -lt $DEADLINE ]; do
  ATTEMPT=$(( ATTEMPT + 1 ))
  if fetch "/api/healthz" && [ "$HTTP_STATUS" = "200" ] && \
     printf '%s' "$HTTP_BODY" | grep -q '"status":"ok"'; then
    READY=true
    echo "==> [1/3] /api/healthz OK (ready after ${SECONDS}s, ${ATTEMPT} attempt(s))"
    break
  fi
  sleep "$POLL_INTERVAL"
done

if [ "$READY" != true ]; then
  fail "app did not become healthy within ${TIMEOUT}s (${ATTEMPT} attempts)" "/api/healthz"
fi

# ── 2. Page rendering: / must not error ─────────────────────────────────────
# Accept any non-error status — the landing page is a 200 today, but a future
# redirect (e.g. a maintenance interstitial) is not a deploy failure. What this
# catches is a 5xx render crash, which healthz alone would never see.
fetch "/" || fail "landing page unreachable" "/"
if [ "$HTTP_STATUS" -ge 400 ] 2>/dev/null; then
  fail "landing page returned HTTP $HTTP_STATUS" "/"
fi
echo "==> [2/3] / OK (HTTP $HTTP_STATUS)"

# ── 3. Auth stack: unauthenticated session must be a clean 200 ──────────────
# GET /api/auth/session with no cookie returns 200 {"authenticated":false} — it
# is NOT a 401. A 500 here means requireAuth or the DB read behind it is broken,
# which would lock every user out while healthz still reported "ok".
fetch "/api/auth/session" || fail "session endpoint unreachable" "/api/auth/session"
if [ "$HTTP_STATUS" != "200" ]; then
  fail "session endpoint returned HTTP $HTTP_STATUS (expected 200)" "/api/auth/session"
fi
if ! printf '%s' "$HTTP_BODY" | grep -q '"authenticated":false'; then
  fail "session endpoint did not report an unauthenticated session" "/api/auth/session"
fi
echo "==> [3/3] /api/auth/session OK (unauthenticated session clean)"

echo "==> Smoke check PASSED — app is serving"
