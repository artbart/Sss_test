#!/usr/bin/env bash
# cf-build.sh stages the published site into _site/. Anything that is source,
# tooling, or a Pages Function must not end up there.
set -uo pipefail
cd "$(dirname "$0")/.."

# Remove any stale _site/ first so a broken cf-build.sh that silently no-ops
# can't make this test pass by coasting on a previous run's output.
rm -rf _site

bash cf-build.sh >/dev/null || { echo "FAIL — cf-build.sh errored"; exit 1; }

FAIL=0
for path in functions test docs sss5 supabase deploy-cf.sh cf-build.sh; do
  if [ -e "_site/$path" ]; then echo "  FAIL — _site/$path was published"; FAIL=1
  else echo "  ok   — _site/$path absent"; fi
done
for path in index.html 2/index.html assets/posthog.js _redirects robots.txt; do
  if [ -e "_site/$path" ]; then echo "  ok   — _site/$path present"
  else echo "  FAIL — _site/$path missing"; FAIL=1; fi
done
exit $FAIL
