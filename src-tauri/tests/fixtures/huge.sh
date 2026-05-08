#!/usr/bin/env bash
# Print one valid response line, then 100 MB of trailing junk.
echo '{"success":true,"actions":[]}'
yes x | head -c $((100 * 1024 * 1024))
