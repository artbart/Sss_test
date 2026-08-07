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
refute "force=test does not serve v1 content"  "$body" "Step into"
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

# Meta in-app browsers are real people, not crawlers. This is the live ad
# channel, so a regex change that swept them into the bot branch would
# silently drop most of the experiment's traffic.
fbua="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/450.0.0.35.108]"
body=$(curl -s -A "$fbua" "$BASE/go?force=test")
check "Meta in-app browser is not a bot"       "$body" '"arm":"v2"'

echo
echo "== live flag evaluation =="

hdrs=$(curl -sD - -o /tmp/go-body.html "$BASE/go" -A "$UA")
body=$(cat /tmp/go-body.html)
check "real visitor gets a payload"            "$body" "__SSS_EXP__"
check "real visitor is exposed"                "$body" '"exposure":true'
check "new visitor gets an id cookie"          "$hdrs" "sss_did="
check "cookie is locked down"                  "$hdrs" "SameSite=Lax"
check "cookie is not readable by scripts"      "$hdrs" "HttpOnly"

# Stickiness: the same id must produce the same arm, and must not be reissued.
did="sticky-test-11111111"
one=$(visit -b "sss_did=$did" "$BASE/go" | grep -o '"variant":"[a-z]*"' | head -1)
two=$(visit -b "sss_did=$did" "$BASE/go" | grep -o '"variant":"[a-z]*"' | head -1)
if [ -n "$one" ] && [ "$one" = "$two" ]; then ok "arm is sticky per distinct_id ($one)"
else bad "arm is sticky per distinct_id ('$one' vs '$two')"; fi

hdrs=$(curl -sD - -o /dev/null -b "sss_did=$did" -A "$UA" "$BASE/go")
refute "known visitor is not re-cookied"       "$hdrs" "sss_did="

# Precedence, not just presence: when BOTH cookies are present the
# posthog-js identity must win, otherwise a returning visitor gets forked
# into a second PostHog person and their funnel splits across two ids.
phc='%7B%22distinct_id%22%3A%22ph-owned-id-42%22%7D'
body=$(visit -b "ph_phc_BzHnof4mQ7dmxTetogNVJF4aEynfmgDP4uHs5LBQZrFu_posthog=$phc; sss_did=sss-owned-id-99" "$BASE/go")
check "posthog-js identity beats sss_did"      "$body" '"distinctId":"ph-owned-id-42"'
refute "sss_did does not win"                  "$body" "sss-owned-id-99"

# A truncated or malformed posthog cookie must fall through to sss_did,
# not throw and not mint a fresh identity.
body=$(visit -b "ph_phc_BzHnof4mQ7dmxTetogNVJF4aEynfmgDP4uHs5LBQZrFu_posthog=%7Bnot-json; sss_did=fallback-id-77" "$BASE/go")
check "malformed ph cookie falls back to sss_did" "$body" '"distinctId":"fallback-id-77"'

stop_dev

echo
echo "== PostHog unreachable =="
start_dev --binding POSTHOG_HOST=http://127.0.0.1:9

body=$(visit "$BASE/go")
check "falls back to v1"                       "$body" "Step into"
refute "excluded from experiment"              "$body" "__SSS_EXP__"

echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ]
