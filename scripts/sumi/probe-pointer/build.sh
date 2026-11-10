#!/usr/bin/env bash
set -euo pipefail
source_dir=$(cd -- "$(dirname -- "$0")" && pwd)
output_dir=${1:?usage: build.sh OUTPUT_DIRECTORY}
mkdir -p "$output_dir"
wayland-scanner client-header "$source_dir/wlr-virtual-pointer-unstable-v1.xml" "$output_dir/protocol.h"
wayland-scanner private-code "$source_dir/wlr-virtual-pointer-unstable-v1.xml" "$output_dir/protocol.c"
cc -I "$output_dir" "$source_dir/click.c" "$output_dir/protocol.c" -o "$output_dir/click" $(pkg-config --cflags --libs wayland-client)
wayland-scanner client-header "$source_dir/virtual-keyboard-unstable-v1.xml" "$output_dir/keyboard-protocol.h"
wayland-scanner private-code "$source_dir/virtual-keyboard-unstable-v1.xml" "$output_dir/keyboard-protocol.c"
cc -I "$output_dir" "$source_dir/keyboard.c" "$output_dir/keyboard-protocol.c" -o "$output_dir/keyboard" $(pkg-config --cflags --libs wayland-client xkbcommon)
