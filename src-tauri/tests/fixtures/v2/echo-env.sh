#!/bin/sh
# v2 plugin fixture that reports, on command.execute, whether the marker env
# var SECRET_TEST_VAR was inherited into the plugin process. Used to assert the
# host clears the environment before spawning (env-sanitization test).
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$line" in
    *'"$initialize"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"ok":true}}\n' "$id" ;;
    *'"$activate"'*)   printf '{"jsonrpc":"2.0","id":%s,"result":{"ok":true}}\n' "$id" ;;
    *'"command.execute"'*)
      if [ -n "${SECRET_TEST_VAR:-}" ]; then present=true; else present=false; fi
      printf '{"jsonrpc":"2.0","id":%s,"result":{"secret_present":%s}}\n' "$id" "$present" ;;
    *'"$deactivate"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"ok":true}}\n' "$id"; exit 0 ;;
  esac
done
