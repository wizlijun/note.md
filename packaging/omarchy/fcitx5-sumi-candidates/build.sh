#!/usr/bin/env bash
# Build from the adjacent frozen source archive; no repository checkout needed.
set -euo pipefail
cd -- "$(dirname -- "$0")"
export SOURCE_DATE_EPOCH=1794412702
python3 verify.py --source-only
makepkg --cleanbuild --noconfirm
python3 verify.py
