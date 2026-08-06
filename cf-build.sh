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
#
# Uses only coreutils — the Pages build image does not ship rsync.
set -euo pipefail
cd "$(dirname "$0")"

OUT=_site
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

# Copy the whole tree (including dotfiles), then prune what must not ship.
cp -a . "$STAGE/"

# Static site only — exclude docs, edge functions, local tooling.
rm -rf \
  "$STAGE/.git" \
  "$STAGE/.github" \
  "$STAGE/.wrangler" \
  "$STAGE/.superpowers" \
  "$STAGE/docs" \
  "$STAGE/sss5" \
  "$STAGE/supabase" \
  "$STAGE/$OUT"
rm -f \
  "$STAGE/.gitignore" \
  "$STAGE/deploy-cf.sh" \
  "$STAGE/cf-build.sh"

rm -rf "$OUT"
mkdir -p "$OUT"
cp -a "$STAGE"/. "$OUT"/

echo "Staged $(find "$OUT" -type f | wc -l | tr -d ' ') files into $OUT/"
echo "Top level: $(ls -A "$OUT" | tr '\n' ' ')"
