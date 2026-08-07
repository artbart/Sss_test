#!/usr/bin/env bash
# Deploy marketing homepage to Cloudflare Pages (project: sss-home).
# Usage: ./deploy-cf.sh
set -euo pipefail
cd "$(dirname "$0")"

PROJECT="sss-home"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

# Static site only — exclude docs, edge functions, local tooling.
#
# functions/ is excluded because Cloudflare compiles Pages Functions from the
# project root, not from a deployed asset directory. Whether `wrangler pages
# deploy` picks them up from a staged directory at all is UNRESOLVED — the Git
# integration (cf-build.sh) is the verified path and the one in use. If you ever
# need this script to ship /go, verify first that the Function actually runs on
# the resulting deployment; if it does not, pre-compile with
# `wrangler pages functions build --outfile=_worker.js`.
rsync -a \
  --exclude='.git' \
  --exclude='.gitignore' \
  --exclude='docs' \
  --exclude='sss5' \
  --exclude='supabase' \
  --exclude='.superpowers' \
  --exclude='deploy-cf.sh' \
  --exclude='functions' \
  --exclude='test' \
  --exclude='cf-build.sh' \
  --exclude='_site' \
  --exclude='.wrangler' \
  ./ "$STAGE/"

COMMIT_HASH=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
COMMIT_MSG=$(git log -1 --pretty=%s 2>/dev/null || echo "manual deploy")

npx wrangler pages deploy "$STAGE" \
  --project-name="$PROJECT" \
  --branch=main \
  --commit-hash="$COMMIT_HASH" \
  --commit-message="$COMMIT_MSG" \
  --commit-dirty=true

echo ""
echo "Production: https://sss-home-9y1.pages.dev"
echo "Custom:     https://stuffsosweet.com  (after DNS)"
echo "Dashboard:  https://dash.cloudflare.com → Workers & Pages → sss-home"
