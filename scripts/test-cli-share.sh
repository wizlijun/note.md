#!/usr/bin/env bash
# Manual end-to-end smoke test for `mdedit -s` against a real Share worker.
#
# Usage:
#   bash scripts/test-cli-share.sh
#
# Prereqs:
#   - M↓.app installed at /Applications/M↓.app
#   - 'mdedit' symlink installed (Help → Install 'mdedit' Command in PATH)
#   - Share plugin configured (Preferences → Plugins → Share: baseUrl + apiKey)

set -euo pipefail

TMP=$(mktemp -t mdedit-cli-smoke.XXXXXX.md)
trap "rm -f $TMP" EXIT

cat > "$TMP" <<'EOF'
# CLI Smoke Test

Body of the test markdown.
EOF

echo "→ mdedit help"
mdedit help | head -5

echo "→ mdedit version"
mdedit version

echo "→ mdedit plugin list"
mdedit plugin list

echo "→ mdedit -s $TMP"
URL=$(mdedit -s "$TMP")
if [[ -z "$URL" ]]; then
  echo "FAIL: empty URL"; exit 1
fi
echo "  URL: $URL"

echo "→ mdedit -s $TMP --json"
JSON=$(mdedit -s "$TMP" --json)
echo "$JSON" | python3 -m json.tool > /dev/null

echo "→ mdedit share $TMP --copy-link (idempotent re-fetch)"
URL2=$(mdedit share "$TMP" --copy-link)
if [[ "$URL" != "$URL2" ]]; then
  echo "FAIL: URL changed: $URL vs $URL2"; exit 1
fi

echo "→ mdedit share $TMP --unshare"
mdedit share "$TMP" --unshare

echo "→ all green"
