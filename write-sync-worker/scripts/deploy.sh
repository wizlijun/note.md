#!/usr/bin/env bash
set -euo pipefail
sumi_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$sumi_root"
sumi_wrangler="$sumi_root/../worker/node_modules/.bin/wrangler"
sumi_version="$(node -p "require('../worker/node_modules/wrangler/package.json').version")"
if [[ "$sumi_version" != "3.114.17" ]]; then
  echo "Expected existing Wrangler 3.114.17; refusing an unverified deployment toolchain." >&2
  exit 1
fi
mkdir -p ../tasks/sumi-sync
export WRANGLER_LOG_PATH="$sumi_root/../tasks/sumi-sync/wrangler.log"
export WRANGLER_SEND_METRICS=false
case "${1:---dry-run}" in
  --dry-run)
    "$sumi_wrangler" deploy --dry-run --outdir ../tasks/sumi-sync/bundle
    ;;
  --deploy)
    # Account API Token only. This never invokes browser OAuth or prints credentials.
    : "${CLOUDFLARE_API_TOKEN:?Set the existing Account API Token in the environment}"
    : "${CLOUDFLARE_ACCOUNT_ID:?Set the intended Cloudflare account ID}"
    "$sumi_wrangler" deploy
    ;;
  *) echo 'Usage: scripts/deploy.sh [--dry-run|--deploy]' >&2; exit 2 ;;
esac
