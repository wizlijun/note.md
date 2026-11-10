#!/bin/zsh
# Offscreen AppKit and real cross-process transport; no input-method install.
set -euo pipefail
sumi_repo="${0:A:h:h:h}"
cd "$sumi_repo"
sumi_output="$sumi_repo/tasks/sumi-macos-ime"
mkdir -p "$sumi_output"
for probe in candidates-view candidates-host candidates-bridge; do
    xcrun clang -fobjc-arc -fblocks -mmacosx-version-min=13.0 \
        -Wno-incompatible-pointer-types \
        -framework AppKit -framework CoreText -framework QuartzCore \
        "tauri-plugin-native-editor/native/$probe-probe.m" \
        -o "$sumi_output/$probe-probe"
    "$sumi_output/$probe-probe" | tee "$sumi_output/$probe.log"
done
if [[ $# -eq 1 ]]; then
    "$sumi_output/candidates-bridge-probe" --swift-client "$1" \
        | tee "$sumi_output/candidates-swift-peer.log"
fi
