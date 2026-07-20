#!/bin/sh
# Streaming + bidirectional-channel fixture (子项目②b Task 3).
#
# Proves BOTH directions of the v2 window channel through a real plugin
# process, without needing an SDK binary:
#
#  1. process → UI (host.ui.post streaming push): on $activate, respond ok and
#     then emit 3 `host.ui.post` notifications {"seq":1|2|3} on window "main"
#     (~50ms apart) followed by a final {"done":true}. The emit runs in a
#     background subshell so the read loop stays responsive to ui.request /
#     $deactivate meanwhile. Each printf writes one short line (< PIPE_BUF), so
#     writes from the loop and the background emitter never interleave mid-line
#     — the same atomicity slow.sh's background sleep relies on.
#
#  2. UI → process (ui.request round-trip): the host sends
#     {"method":"ui.request","params":{"method":"echo","params":{...}}}. We
#     echo the INNER params back as the result (method "echo"); "ping" → "pong".
#
# NOTE: the host wraps ui.request as {method:"ui.request", params:{method,params}}
# so the raw line contains BOTH the outer "ui.request" and an inner method — we
# match the outer method first, then extract the inner method/params with sed.
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$line" in
    *'"$initialize"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"ok":true}}\n' "$id" ;;
    *'"$activate"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"ok":true}}\n' "$id"
      # Background streamer: 3 seq frames + a final done frame, ~50ms apart.
      (
        n=1
        while [ "$n" -le 3 ]; do
          sleep 0.05
          printf '{"jsonrpc":"2.0","method":"host.ui.post","params":{"window_id":"main","payload":{"seq":%s}}}\n' "$n"
          n=$((n + 1))
        done
        sleep 0.05
        printf '{"jsonrpc":"2.0","method":"host.ui.post","params":{"window_id":"main","payload":{"done":true}}}\n'
      ) </dev/null &
      ;;
    *'"ui.request"'*)
      # Inner method: the FIRST "method" after the outer "ui.request".
      inner=$(printf '%s' "$line" | sed -n 's/.*"ui.request".*"method":"\([^"]*\)".*/\1/p')
      case "$inner" in
        echo)
          # Echo the inner params object verbatim as the result.
          params=$(printf '%s' "$line" | sed -n 's/.*"method":"echo","params":\(.*\)}}$/\1/p')
          printf '{"jsonrpc":"2.0","id":%s,"result":%s}\n' "$id" "$params" ;;
        ping)
          printf '{"jsonrpc":"2.0","id":%s,"result":"pong"}\n' "$id" ;;
        *)
          printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32000,"message":"unknown ui method %s"}}\n' "$id" "$inner" ;;
      esac ;;
    *'"$deactivate"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"ok":true}}\n' "$id"; exit 0 ;;
  esac
done
