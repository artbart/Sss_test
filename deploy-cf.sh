#!/usr/bin/env bash
# Deploy marketing homepage to Cloudflare Pages (project: sss-home).
# Usage: ./deploy-cf.sh
set -euo pipefail
cd "$(dirname "$0")"

PROJECT="sss-home"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

# Static site only — exclude docs, edge functions, local tooling
rsync -a \
  --exclude='.git' \
  --exclude='.gitignore' \
  --exclude='docs' \
  --exclude='sss5' \
  --exclude='supabase' \
  --exclude='.superpowers' \
  --exclude='deploy-cf.sh' \
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
