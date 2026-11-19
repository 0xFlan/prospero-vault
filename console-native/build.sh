#!/usr/bin/env bash
# Prospero Vault native title.
#
#   ./console-native/build.sh
#
# Produces:
#   console-native/dist/PVLT00001/      the home-screen title folder
#   console-native/dist/PVLT00001.tar   the same folder, uncompressed
#   console-native/dist/install.elf     one-shot elfldr installer
#
# The toolchain is not vendored: it is the native-app toolchain under
# PS5_NATIVE_TOOLCHAIN. See console-native/README.md and tools/bootstrap-toolchain.sh.
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd -- "$root/.." && pwd)
toolchain=${PS5_NATIVE_TOOLCHAIN:-$HOME/ps5-harness/.deps/native/drakmor-boilerplate}
sdk=${PS5_PAYLOAD_SDK:-$HOME/ps5-harness/.deps/ps5-payload-sdk}

find_cxx() {
    if [[ -n ${PS5_CLANG:-} ]]; then
        printf '%s\n' "$PS5_CLANG"
        return
    fi
    local candidate
    for candidate in \
        /opt/homebrew/opt/llvm@20/bin/clang++ \
        /opt/homebrew/opt/llvm/bin/clang++ \
        /usr/bin/clang++-18 \
        /usr/bin/clang++; do
        if [[ -x $candidate ]]; then
            printf '%s\n' "$candidate"
            return
        fi
    done
    return 1
}

cxx=$(find_cxx) || {
    echo "build: no Clang with the PS5 target support found; set PS5_CLANG" >&2
    exit 2
}
if [[ -z ${LLVM_CONFIG:-} ]]; then
    llvm_bin=$(dirname -- "$cxx")
    if [[ -x $llvm_bin/llvm-config ]]; then
        export LLVM_CONFIG=$llvm_bin/llvm-config
    fi
fi

for required in \
    "$toolchain/tooling/prospero-clang18" \
    "$toolchain/tooling/native/app_crt.cpp" \
    "$toolchain/tooling/native/app_cpp_runtime.cpp" \
    "$toolchain/tooling/native/ps5-pie.ld" \
    "$toolchain/tooling/native/app-symbols.map" \
    "$toolchain/build/host/ps5-native-tool" \
    "$toolchain/build/host/libc.prx" \
    "$sdk/bin/prospero-lld"; do
    if [[ ! -e $required ]]; then
        echo "build: missing $required" >&2
        echo "build: see console-native/tools/bootstrap-toolchain.sh" >&2
        exit 2
    fi
done

out="$root/build"
app="$root/dist/PVLT00001"
mkdir -p "$out/obj" "$app/sce_sys" "$app/sce_module" "$app/assets"

compile_target() {
    local source=$1
    local object=$2
    PS5_CLANG="$cxx" PS5_PAYLOAD_SDK="$sdk" \
        sh "$toolchain/tooling/prospero-clang18" \
        -std=c++17 -O2 -Wall -Wextra -fno-exceptions -fno-rtti \
        -ffunction-sections -fdata-sections -c "$source" -o "$object"
}

compile_target "$root/app.cpp" "$out/obj/app.o"
compile_target "$root/render.cpp" "$out/obj/render.o"
compile_target "$toolchain/tooling/native/app_crt.cpp" "$out/obj/app_crt.o"
compile_target "$toolchain/tooling/native/app_cpp_runtime.cpp" "$out/obj/app_cpp_runtime.o"

"$sdk/bin/prospero-lld" -T "$toolchain/tooling/native/ps5-pie.ld" --eh-frame-hdr \
    --version-script "$toolchain/tooling/native/app-symbols.map" -e _start \
    -o "$out/llvm-pie.elf" \
    "$out/obj/app_crt.o" "$out/obj/app_cpp_runtime.o" \
    "$out/obj/app.o" "$out/obj/render.o" \
    --as-needed "$sdk"/target/lib/*.so

"$toolchain/build/host/ps5-native-tool" link \
    --in "$out/llvm-pie.elf" --out "$out/eboot.elf" \
    --stub-dir "$sdk/target/lib" \
    --module-sdk 0x02000009 --companion-sdk 0x08050001 \
    --file-name eboot.elf

"$toolchain/build/host/ps5-native-tool" self --sign \
    --in "$out/eboot.elf" --out "$app/eboot.bin" --magic 0x1D3D154F

cp "$toolchain/build/host/libc.prx" "$app/sce_module/libc.prx"
cp "$repo/console/ui/icon0.png" "$app/sce_sys/icon0.png"

cat > "$app/sce_sys/param.json" <<'JSON'
{
  "ageLevel": { "default": 0 },
  "applicationCategoryType": 0,
  "applicationDrmType": "free",
  "attribute": 1,
  "attribute2": 0,
  "attribute3": 4,
  "conceptId": "00001",
  "contentBadgeType": 1,
  "contentId": "IV9999-PVLT00001_00-PROSPEROVAULT000",
  "contentVersion": "01.000.000",
  "downloadDataSize": 256,
  "gameIntent": { "permittedIntents": [ { "intentType": "launchActivity" } ] },
  "localizedParameters": { "defaultLanguage": "en-US", "en-US": { "titleName": "Prospero Vault" } },
  "masterVersion": "01.00",
  "pubtools": { "creationDate": "2026-11-19 00:00:00", "loudnessSnd0": "-28.00", "toolVersion": "2.00" },
  "requiredSystemSoftwareVersion": "0x0000000000000000",
  "sdkVersion": "0x0000000000000000",
  "titleId": "PVLT00001",
  "versionFileUri": ""
}
JSON

{
    printf 'Prospero Vault native title\n'
    printf 'build %s\n' "$(cd "$repo" && git rev-parse --short HEAD 2>/dev/null || echo local)"
    printf 'firmware 13.20\n'
} > "$app/assets/build.txt"

COPYFILE_DISABLE=1 tar --format=ustar -C "$root/dist" -cf "$root/dist/PVLT00001.tar" PVLT00001
cp "$root/dist/PVLT00001.tar" "$root/installer/PVLT00001.tar"

cat > "$out/obj/title_tar.S" <<'ASM'
    .section .rodata
    .global title_tar
    .global title_tar_end
    .p2align 4
title_tar:
    .incbin "PVLT00001.tar"
title_tar_end:
ASM
(
    cd "$root/installer"
    "$sdk/bin/prospero-clang" -c "$out/obj/title_tar.S" -o "$out/obj/title_tar.o"
)
"$sdk/bin/prospero-clang++" -std=c++17 -O2 -Wall -Wextra \
    -o "$root/dist/install.elf" "$root/installer/main.cpp" \
    "$out/obj/title_tar.o" -lSceSystemService

"$toolchain/build/host/ps5-native-tool" self --inspect --file "$app/eboot.bin"
ls -l "$app/eboot.bin" "$app/sce_module/libc.prx" "$root/dist/PVLT00001.tar" \
    "$root/dist/install.elf"
printf '\nInstall with:\n  nc -w 30 <console-ip> 9021 < %s\n' "$root/dist/install.elf"
