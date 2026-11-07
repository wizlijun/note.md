#!/bin/bash
# Capability probe only. Default mode prints a command; recording is explicit.
# Do not run record during benchmarks, a locked screen, or a host rebuild.
set -euo pipefail
sumi_repo="$(cd "$(dirname "$0")/../.." && pwd)"
sumi_mode="${1:-help}"
if [[ "$sumi_mode" == help || "$sumi_mode" == --help ]]; then
  printf '%s\n' 'Usage: probe-input-present.sh plan|record ACCEPTANCE_PID' \
    'plan validates the existing isolated app and prints the 30-second attach command.' \
    'record attaches only that PID; never launches an app or records all processes.' \
    'Wait for the controller to confirm benchmarks ended, screen unlocked, and new app running.'
  exit 0
fi
if [[ "$sumi_mode" != plan && "$sumi_mode" != record ]]; then
  printf '%s\n' 'Expected plan or record' >&2; exit 2
fi
sumi_pid="${2:-}"
if [[ ! "$sumi_pid" =~ ^[1-9][0-9]*$ ]]; then
  printf '%s\n' 'An explicit existing Acceptance PID is required' >&2; exit 2
fi
sumi_app="$sumi_repo/src-tauri/target/aarch64-apple-darwin/debug/bundle/macos/note.md Sumi Acceptance.app"
python3 - "$sumi_repo" "$sumi_app" "$sumi_pid" <<'PY'
import json, plistlib, subprocess, sys
from pathlib import Path
repo, app, pid = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
info = plistlib.loads((app/'Contents/Info.plist').read_bytes())
assert info['CFBundleIdentifier'] == 'net.notemd.sumi.acceptance', 'Unexpected app identity'
expected = (app/'Contents/MacOS'/info['CFBundleExecutable']).resolve()
running = subprocess.check_output(['ps', '-p', pid, '-o', 'comm='], text=True).strip()
assert Path(running).resolve() == expected, 'PID is not this checkout\'s Acceptance executable'
support = Path.home()/'Library/Application Support/net.notemd.sumi.acceptance'
marker = json.loads((support/'.sumi-acceptance.json').read_text())
assert marker['identifier'] == info['CFBundleIdentifier']
assert Path(marker['vault']).resolve() == (repo/'tasks/sumi-native/host-acceptance/vault').resolve()
assert (Path(marker['vault'])/'.sumi-acceptance-vault').read_text() == 'sumi-acceptance-only\n'
assert json.loads((support/'shared.json').read_text())['sotvault'] == marker['vault']
print('Verified existing isolated Acceptance process:', pid)
PY
sumi_output="$sumi_repo/tasks/sumi-core/performance-20261108/input-present-$(date -u +%Y%m%dT%H%M%SZ)-$sumi_pid.trace"
sumi_command=(xcrun xctrace record --template 'Animation Hitches' --instrument 'Frame Lifetimes' --instrument 'Core Animation Activity' --instrument 'Core Animation Server' --attach "$sumi_pid" --time-limit 30s --output "$sumi_output")
printf 'Capability probe command:'
printf ' %q' "${sumi_command[@]}"
printf '\n'
if [[ "$sumi_mode" == plan ]]; then exit 0; fi
mkdir -p "$(dirname "$sumi_output")"
"${sumi_command[@]}"
xcrun xctrace export --input "$sumi_output" --toc --output "$sumi_output.toc.xml"
printf '%s\n' 'Recording ended; inspect actual tables and HID/frame/surface associations before computing any latency.' \
  "TOC: $sumi_output.toc.xml"
