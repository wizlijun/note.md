#!/bin/sh
# Like ok.sh, but the process dies mid-request: command.execute writes a line
# to stderr and exits 0 without ever responding. Pins the host behavior that
# in-flight requests fail fast when the reader loop ends (instead of hanging
# out the full request timeout).
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$line" in
    *'"$initialize"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"ok":true}}\n' "$id" ;;
    *'"$activate"'*)   printf '{"jsonrpc":"2.0","id":%s,"result":{"ok":true}}\n' "$id" ;;
    *'"command.execute"'*) echo "dying mid-request" >&2; exit 0 ;;
  esac
done
