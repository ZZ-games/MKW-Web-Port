#!/bin/bash
# Normalizes a runtime log for comparing native and web boots: drops web-only noise, masks hex
# values, timings and the user-data path, and prints unique lines.
grep -vE '^=====|\[heartbeat\]|\[stall\]|\[runtime\]   Loaded|\[page\]' "$1" \
  | sed -E -e 's/0x[0-9a-fA-F]+/X/g' -e 's/[0-9]+ ?(ms|msec|MiB|MB|bytes|Bytes)/N\1/g' \
           -e 's#D:.mkw-web.native.UserData#UD#g' -e 's#/opfs/WiiCompiled#UD#g' \
  | sort -u
