#!/bin/sh
# Activation SUCCEEDS ($initialize + $activate both answered), then the
# process immediately dies with exit code 1. Exercises the lifecycle crash
# supervision: unexpected exit → backoff restarts → circuit breaker trips
# to Disabled("crash-loop") after 3 crashes in the window.
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$line" in
    *'"$initialize"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"ok":true}}\n' "$id" ;;
    *'"$activate"'*)   printf '{"jsonrpc":"2.0","id":%s,"result":{"ok":true}}\n' "$id"; exit 1 ;;
  esac
done
