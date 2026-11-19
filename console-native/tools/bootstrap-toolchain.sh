#!/usr/bin/env bash
# Builds the native-app host tools and the clean-room runtime companion.
#
# Upstream describes the boilerplate as Linux/WSL-first. The two host programs
# are portable C++20, so they also build here with Homebrew LLVM and the system
# zlib. The console-side compiler, linker and converter are the same ones the
# payload SDK already uses.
set -euo pipefail

toolchain=${PS5_NATIVE_TOOLCHAIN:-$HOME/ps5-harness/.deps/native/drakmor-boilerplate}
sdk=${PS5_PAYLOAD_SDK:-$HOME/ps5-harness/.deps/ps5-payload-sdk}
cxx=${PS5_CLANG:-/opt/homebrew/opt/llvm@20/bin/clang++}

command -v git >/dev/null || { echo "bootstrap: git is required" >&2; exit 2; }
[[ -x $cxx ]] || { echo "bootstrap: set PS5_CLANG to a Clang++" >&2; exit 2; }
[[ -d $sdk/target/include ]] || { echo "bootstrap: PS5_PAYLOAD_SDK is not a payload SDK" >&2; exit 2; }

if [[ ! -d $toolchain/tooling/native ]]; then
    mkdir -p "$(dirname -- "$toolchain")"
    git clone --depth 1 https://github.com/drakmor/ps5-native-app-boilerplate "$toolchain"
fi

mkdir -p "$toolchain/build/host"
"$cxx" -std=c++20 -O2 -Wall -Wextra -Werror \
    "$toolchain/tooling/native/libc_builder.cpp" \
    -o "$toolchain/build/host/libc-builder"
"$cxx" -std=c++20 -O2 -Wall -Wextra -Werror \
    "$toolchain/tooling/native/native_app_builder.cpp" \
    "$toolchain/tooling/native/self_container.cpp" \
    "$toolchain/tooling/native/elf_object.cpp" \
    "$toolchain/tooling/native/sce_module_writer.cpp" \
    -lz -o "$toolchain/build/host/ps5-native-tool"

"$toolchain/build/host/libc-builder" \
    "$toolchain/tooling/native/runtime/api-surface.txt" \
    "$toolchain/tooling/native/runtime/imports.txt" \
    "$toolchain/build/host/libc.raw.elf"
"$toolchain/build/host/ps5-native-tool" self --sign \
    --in "$toolchain/build/host/libc.raw.elf" \
    --out "$toolchain/build/host/libc.prx"

raw=$(shasum -a 256 "$toolchain/build/host/libc.raw.elf" | cut -d' ' -f1)
signed=$(shasum -a 256 "$toolchain/build/host/libc.prx" | cut -d' ' -f1)
printf 'raw    %s\nsigned %s\n' "$raw" "$signed"
[[ $raw == 8ee6e124993e1af26420cb455890fd002f5d6c7e78883c860ce45734e7d002bb ]]
[[ $signed == e6ff45d16adf687855cc3b33b0c8a4132b6504360b221e0a34c7e99fb3ba0036 ]]
printf 'bootstrap: clean-room runtime is byte-identical to the pinned artifact\n'
