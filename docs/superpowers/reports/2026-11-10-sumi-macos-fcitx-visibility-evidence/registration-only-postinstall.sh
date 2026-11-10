#!/bin/sh
set -eu
[ "${3:-}" = / ] || exit 1
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
"$script_dir/register-input-source"
