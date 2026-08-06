#!/usr/bin/env bash
# Cloudflare Pages build step for project sss-home.
#
# Set in the Pages project (Settings → Builds & deployments):
#   Build command:            bash cf-build.sh
#   Build output directory:   _site
#
# Without this, the Git integration deploys the repo ROOT, which publishes
# sss5/ (the dev mirror, blocked in robots.txt) and docs/ on the live
# marketing site. Keep the exclude list here in sync with deploy-cf.sh.
set -euo pipefail
cd "$(dirname "$0")"

OUT=_site
rm -rf "$OUT"
mkdir -p "$OUT"

# Static site only — exclude docs, edge functions, local tooling.
rsync -a \
  --exclude='.git' \
  --exclude='.github' \
  --exclude='.gitignore' \
  --exclude='docs' \
  --exclude='sss5' \
  --exclude='supabase' \
  --exclude='.superpowers' \
  --exclude='deploy-cf.sh' \
  --exclude='cf-build.sh' \
  --exclude="$OUT" \
  ./ "$OUT/"

echo "Staged $(find "$OUT" -type f | wc -l | tr -d ' ') files into $OUT/"
