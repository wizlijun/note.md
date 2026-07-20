#!/bin/sh
# Like ok.sh, but $activate crashes the process with exit code 1
# (never responds to the $activate request).
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$line" in
    *'"$initialize"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"ok":true}}\n' "$id" ;;
    *'"$activate"'*)   exit 1 ;;
  esac
done
