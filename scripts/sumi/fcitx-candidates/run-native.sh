#!/usr/bin/env bash
set -euo pipefail
script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
export SUMI_CANDIDATE_PRIVATE_BUS=1
exec dbus-run-session --config-file="$script_dir/dbus-test.conf" -- python "$script_dir/run-native.py" "$@"
