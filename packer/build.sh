#!/usr/bin/env bash
# Build acpack, applying the managed-SHA3 patch when the checkout needs it.
#
# macOS .NET has no SHA-3 at all, and every PS5 package path needs SHA3-256.
# The patch teaches LibProsperoPkg a managed sponge, so packages can be built
# on a Mac instead of only on Linux/Windows.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
deps="$here/.deps/LibProsperoPkg"

if [ ! -d "$deps/.git" ]; then
  echo "LibProsperoPkg is missing. Clone it first:" >&2
  echo "  git clone https://github.com/SvenGDK/LibProsperoPKG '$deps'" >&2
  exit 1
fi

if ! grep -q "class ManagedSha3" "$deps/src/LibProsperoPkg/Util/ManagedSha3.cs" 2>/dev/null; then
  echo "applying packer/patches/0001-managed-sha3.patch"
  git -C "$deps" apply "$here/patches/0001-managed-sha3.patch"
fi

dotnet build "$here/ProsperoAcPack.csproj" -c Release \
  -p:LibProsperoPkgPath="$deps/src/LibProsperoPkg/LibProsperoPkg.csproj"

echo "acpack: $here/bin/Release/net10.0/acpack.dll"
echo "Prospero Vault finds this automatically when no custom command is configured."
