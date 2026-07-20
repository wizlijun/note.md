#!/bin/sh
# Minimal v2 plugin: NDJSON JSON-RPC over stdio.
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$line" in
    *'"$initialize"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"ok":true}}\n' "$id" ;;
    *'"$activate"'*)   printf '{"jsonrpc":"2.0","id":%s,"result":{"ok":true}}\n' "$id" ;;
    *'"command.execute"'*)
      printf '{"jsonrpc":"2.0","method":"host.toast","params":{"level":"success","message":"hi"}}\n'
      printf '{"jsonrpc":"2.0","id":%s,"result":{"echo":true}}\n' "$id" ;;
    *'"$deactivate"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"ok":true}}\n' "$id"; exit 0 ;;
  esac
done
