#!/bin/bash
# Compile every generated translation unit with em++ (no link) to find wasm-incompatible code.
source /d/mkw-web/web/env.sh
R=/d/mkw-web/Wiicompiled
G=/d/mkw-web/native/WiiCompiled/BuildWorkspace/generated
O=/d/mkw-web/web/build-smoke/gen
mkdir -p $O
compile() {
  f="$1"; out="$O/$(basename "$f" .cpp).o"
  if em++ -c -O2 -std=gnu++17 -fno-fast-math -ffp-contract=off -w -pthread -msimd128 -msse4.2 \
      -DMKW_TRANSLATED_GUEST_REGION=1 -DTARGET_PC -I$R/runtime/include -I$R/runtime/src -I$R \
      -I$R/aurora-main/include -I"$(dirname "$f")" -I$G "$f" -o "$out" 2>"$out.err"; then
    rm -f "$out.err"; echo "OK $f"
  else
    echo "FAIL $f"
  fi
}
export -f compile; export R G O
find $G -name '*.cpp' | grep -v retro_rewind | xargs -P 10 -I{} bash -c 'compile "$@"' _ {}
