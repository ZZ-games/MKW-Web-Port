#!/bin/bash
# Configure the full web game build (runtime + aurora + translated shards) in web/build-game.
# The translated shards come from generated/ (a junction to the native install's output).
set -e
source /d/mkw-web/web/env.sh
R=/d/mkw-web/Wiicompiled
DEPS=$R/Launcher/artifacts/dependencies
TOOLS=$R/Launcher/artifacts/portable-tools
B=/d/mkw-web/web/build-game
args=()
# Same pinned offline sources the native build uses; native-only ones are skipped.
for d in "$DEPS"/*/; do
  name=$(basename "$d")
  case "$name" in SDL|dawn_prebuilt|native_prebuilt|cppwinrt|libusb) continue;; esac
  args+=("-DFETCHCONTENT_SOURCE_DIR_${name^^}=$d")
done
# Every object shares one wasm memory and one exception model.
FLAGS="-pthread -fwasm-exceptions -sSUPPORT_LONGJMP=wasm"
emcmake "$TOOLS/CMake/bin/cmake.exe" -S "$R/runtime" -B "$B" -G Ninja \
  -DCMAKE_MAKE_PROGRAM="$TOOLS/Ninja/ninja.exe" \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
  -DCMAKE_C_FLAGS="$FLAGS" -DCMAKE_CXX_FLAGS="$FLAGS" -DCMAKE_EXE_LINKER_FLAGS="$FLAGS" \
  -DMKW_BUILD_PRODUCTS=ON \
  -DMKW_NATIVE_PREBUILT_DIR= \
  -DAURORA_DAWN_PROVIDER=system -DAURORA_SDL3_PROVIDER=system \
  -DCMAKE_POLICY_DEFAULT_CMP0168=NEW -DFETCHCONTENT_FULLY_DISCONNECTED=ON \
  "${args[@]}" "$@"
