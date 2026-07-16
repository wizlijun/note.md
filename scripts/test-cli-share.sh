#!/usr/bin/env bash
# Manual end-to-end smoke test for `notemd --share` against a real Share worker.
#
# Usage:
#   bash scripts/test-cli-share.sh
#
# Prereqs:
#   - note.md.app installed at /Applications/note.md.app
#   - 'notemd' symlink installed (Help → Install 'notemd' Command in PATH)
#   - Share configured (Settings → Share: baseUrl + apiKey)

set -euo pipefail

TMP=$(mktemp -t notemd-cli-smoke.XXXXXX.md)
trap "rm -f $TMP" EXIT

cat > "$TMP" <<'EOF'
# CLI Smoke Test

Body of the test markdown.
EOF

echo "→ notemd help"
notemd help | head -5

echo "→ notemd version"
notemd version

echo "→ notemd plugin list"
notemd plugin list

echo "→ notemd --share $TMP"
URL=$(notemd --share "$TMP")
if [[ -z "$URL" ]]; then
  echo "FAIL: empty URL"; exit 1
fi
echo "  URL: $URL"

echo "→ notemd --share $TMP --json"
JSON=$(notemd --share "$TMP" --json)
echo "$JSON" | python3 -m json.tool > /dev/null

echo "→ notemd share $TMP --copy-link (idempotent re-fetch)"
URL2=$(notemd share "$TMP" --copy-link)
if [[ "$URL" != "$URL2" ]]; then
  echo "FAIL: URL changed: $URL vs $URL2"; exit 1
fi

echo "→ notemd share $TMP --unshare"
notemd share "$TMP" --unshare

echo "→ all green"
