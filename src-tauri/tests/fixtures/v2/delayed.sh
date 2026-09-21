#!/bin/sh
# A valid request can remain silent longer than idle_shutdown_seconds. The
# lifecycle must not reap the process while that request is still in flight.
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$line" in
    *'"$initialize"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"ok":true}}\n' "$id" ;;
    *'"$activate"'*)   printf '{"jsonrpc":"2.0","id":%s,"result":{"ok":true}}\n' "$id" ;;
    *'"ui.request"'*)
      sleep 1.5
      printf '{"jsonrpc":"2.0","id":%s,"result":{"delayed":true}}\n' "$id"
      ;;
    *'"$deactivate"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"ok":true}}\n' "$id"; exit 0 ;;
  esac
done
