#!/usr/bin/env bash
# Integration tests for the /go A/B split.
#
# Boots `wrangler pages dev` against this directory and drives it with curl.
# There is no unit-test layer because functions/go.js is a single request
# handler whose interesting behaviour is entirely in its HTTP surface.
set -uo pipefail
cd "$(dirname "$0")/.."

PORT=8788
BASE="http://127.0.0.1:$PORT"
PASS=0
FAIL=0

ok()   { PASS=$((PASS+1)); echo "  ok   — $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL — $1"; }
check(){ # check <description> <haystack> <needle>
  if printf '%s' "$2" | grep -qF -- "$3"; then ok "$1"; else bad "$1 (missing: $3)"; fi
}
refute(){ # refute <description> <haystack> <needle>
  if printf '%s' "$2" | grep -qF -- "$3"; then bad "$1 (unexpectedly present: $3)"; else ok "$1"; fi
}

# Plain curl's default User-Agent (curl/x.y.z) matches BOT_RE's `curl\/` entry,
# and the bot check runs before ?force= is ever read — so any request meant to
# stand in for a real visitor must pass a browser user-agent explicitly.
UA="Mozilla/5.0 (iPhone) Safari"
visit()  { curl -s -A "$UA" "$@"; }                 # body, as a visitor
visith() { curl -sD - -o /dev/null -A "$UA" "$@"; } # headers only, as a visitor

start_dev() { # start_dev [extra wrangler args...]
  npx wrangler pages dev . --port "$PORT" --log-level error "$@" >/tmp/go-dev.log 2>&1 &
  DEV_PID=$!
  for _ in $(seq 1 60); do
    curl -sf "$BASE/robots.txt" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "wrangler pages dev failed to start; log:"; cat /tmp/go-dev.log; exit 1
}
stop_dev() { kill "$DEV_PID" 2>/dev/null; wait "$DEV_PID" 2>/dev/null; }
trap stop_dev EXIT

echo "== online (real PostHog) =="
start_dev

body=$(visit "$BASE/go?force=control")
check "force=control renders v1 headline"      "$body" "Step into"
check "force=control keeps v1 CTA"             "$body" 'href="/quiz/a"'
check "force=control injects payload"          "$body" "__SSS_EXP__"
check "force=control marks exposure false"     "$body" '"exposure":false'

body=$(visit "$BASE/go?force=test")
check "force=test renders v2 headline"         "$body" "Interactive"
check "force=test keeps v2 CTA"                "$body" 'href="/quiz2/"'
check "force=test uses v2 media"               "$body" "/2/media/d3.webp"
check "force=test reports arm v2"              "$body" '"arm":"v2"'

hdrs=$(visith "$BASE/go?force=control")
check "no-store"                               "$hdrs" "no-store"
check "noindex"                                "$hdrs" "noindex"

hdrs=$(curl -sD - -o /dev/null -A "facebookexternalhit/1.1" "$BASE/go")
body=$(curl -s -A "facebookexternalhit/1.1" "$BASE/go")
check "bot gets v1"                            "$body" "Step into"
refute "bot gets no payload"                   "$body" "__SSS_EXP__"
refute "bot gets no cookie"                    "$hdrs" "sss_did"

echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ]
