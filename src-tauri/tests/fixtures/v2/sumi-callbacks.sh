#!/bin/sh
# Independent auth/status callbacks followed by a legitimate void result.
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$line" in
    *'"command.execute"'*)
      printf '{"jsonrpc":"2.0","id":900,"method":"host.sumi.service","params":{"method":"auth_load"}}\n'
      printf '{"jsonrpc":"2.0","id":901,"method":"host.sumi.service","params":{"method":"status"}}\n'
      printf '{"jsonrpc":"2.0","id":%s,"result":null}\n' "$id" ;;
    *'"$deactivate"'*) printf '{"jsonrpc":"2.0","id":%s,"result":null}\n' "$id"; exit 0 ;;
  esac
done
