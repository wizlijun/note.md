#!/bin/sh
# Like ok.sh, but command.execute never gets a response: the "work" runs in
# the background so the read loop stays responsive to $deactivate while the
# host's per-request timeout fires (spec §12: timeout fails the request only).
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$line" in
    *'"$initialize"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"ok":true}}\n' "$id" ;;
    *'"$activate"'*)   printf '{"jsonrpc":"2.0","id":%s,"result":{"ok":true}}\n' "$id" ;;
    *'"command.execute"'*)
      sleep 60 </dev/null >/dev/null 2>&1 &
      ;;
    *'"$deactivate"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"ok":true}}\n' "$id"; exit 0 ;;
  esac
done
