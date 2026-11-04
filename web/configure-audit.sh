#!/bin/bash
# Configure the web compile-only audit (runtime sources + aurora, no translated products).
set -e
source /d/mkw-web/web/env.sh
R=/d/mkw-web/Wiicompiled
DEPS=$R/Launcher/artifacts/dependencies
TOOLS=$R/Launcher/artifacts/portable-tools
B=/d/mkw-web/web/build-audit
args=()
# Same pinned offline sources the native build uses; native-only ones are skipped.
for d in "$DEPS"/*/; do
  name=$(basename "$d")
  case "$name" in SDL|dawn_prebuilt|native_prebuilt|cppwinrt|libusb) continue;; esac
  args+=("-DFETCHCONTENT_SOURCE_DIR_${name^^}=$d")
done
emcmake "$TOOLS/CMake/bin/cmake.exe" -S "$R/runtime" -B "$B" -G Ninja \
  -DCMAKE_MAKE_PROGRAM="$TOOLS/Ninja/ninja.exe" \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
  -DMKW_BUILD_PRODUCTS=OFF \
  -DMKW_NATIVE_PREBUILT_DIR= \
  -DAURORA_DAWN_PROVIDER=system -DAURORA_SDL3_PROVIDER=system \
  -DCMAKE_POLICY_DEFAULT_CMP0168=NEW -DFETCHCONTENT_FULLY_DISCONNECTED=ON \
  "${args[@]}" "$@"
