#!/bin/bash
#
# Builds "Prospero Vault.app": a menu bar app with its own Bun runtime, the
# server sources and the icon. Double-clicking it starts the same server this
# repo runs from a terminal, on the usual port, as the login user.
#
#   ./tools/build-app.sh
#   BUN_BIN=/path/to/bun ./tools/build-app.sh
#
# Optional signing/notarization, read from the environment and skipped when
# absent:
#   DEVELOPER_ID_APPLICATION="Developer ID Application: Name (TEAMID)"
#   NOTARY_PROFILE="profile"                       # xcrun notarytool --keychain-profile
#   or APPLE_ID + APPLE_TEAM_ID + APPLE_APP_PASSWORD
#
# Output: build/Prospero Vault.app (override with APP_OUT).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${APP_OUT:-$ROOT/build/Prospero Vault.app}"
CONTENTS="$APP/Contents"
RES="$CONTENTS/Resources"
MACOS="$CONTENTS/MacOS"
VERSION="0.10.0"

say() { printf '  %s\n' "$*"; }

if [ "$(uname -s)" != "Darwin" ]; then
  echo "build-app: a macOS app bundle has to be built on macOS" >&2
  exit 1
fi

# A real runtime inside the bundle: the user does not need Bun, Homebrew, or a
# terminal. Resolve the symlink Homebrew installs so the copy is self-contained.
BUN_BIN="${BUN_BIN:-$(command -v bun || true)}"
if [ -z "$BUN_BIN" ] && [ -n "${FREEBUFF_BUN:-}" ]; then BUN_BIN="$FREEBUFF_BUN"; fi
if [ -z "$BUN_BIN" ] || [ ! -x "$BUN_BIN" ]; then
  echo "build-app: bun was not found. Install it or set BUN_BIN, then try again." >&2
  exit 1
fi
BUN_BIN="$(cd "$(dirname "$BUN_BIN")" && pwd -P)/$(basename "$BUN_BIN")"

rm -rf "$APP"
mkdir -p "$RES/app" "$RES/app/app" "$RES/app/public" "$MACOS" "$ROOT/build"

say "runtime   $BUN_BIN"
cp "$BUN_BIN" "$RES/bun"
chmod 755 "$RES/bun"

# Only what the server imports at run time. The root is the app folder, so the
# server's own ROOT/public/data defaults line up exactly as in the repo.
cp "$ROOT"/app/*.ts "$RES/app/app/"
cp "$ROOT"/public/* "$RES/app/public/"
cp "$ROOT/package.json" "$RES/app/package.json"

# The packer that ships inside the app must not require the user to have .NET.
# A self-contained publish statically carries the runtime; without a local SDK
# the existing dll is copied so the app still works where dotnet is installed.
PACKER_DIR="$RES/app/packer/bin/Release/net10.0"
mkdir -p "$PACKER_DIR"
if [ -f "$ROOT/packer/.deps/LibProsperoPkg/src/LibProsperoPkg/LibProsperoPkg.csproj" ] && command -v dotnet >/dev/null; then
  say "packer    self-contained acpack"
  if ! dotnet publish "$ROOT/packer/ProsperoAcPack.csproj" -c Release -r osx-arm64 --self-contained true \
      -p:LibProsperoPkgPath="$ROOT/packer/.deps/LibProsperoPkg/src/LibProsperoPkg/LibProsperoPkg.csproj" \
      -o "$PACKER_DIR" >/tmp/pv_app_pack.log 2>&1; then
    say "packer    publish failed; keeping the existing build (see /tmp/pv_app_pack.log)"
  fi
  rm -f "$PACKER_DIR"/*.pdb "$PACKER_DIR"/*.xml
elif [ -d "$ROOT/packer/bin/Release/net10.0" ]; then
  say "packer    copying the existing build (no dotnet here)"
  cp -R "$ROOT/packer/bin/Release/net10.0/." "$PACKER_DIR/"
fi
if [ ! -x "$PACKER_DIR/acpack" ] && [ ! -f "$PACKER_DIR/acpack.dll" ]; then
  say "packer    no acpack found; run ./packer/build.sh first if you want real builds"
fi

say "building  menu bar shell"
swiftc -O -o "$MACOS/ProsperoVault" "$ROOT/tools/menubar.swift"
chmod 755 "$MACOS/ProsperoVault"

say "icon"
ICONSET="$ROOT/build/AppIcon.iconset"
rm -rf "$ICONSET"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$ROOT/console/ui/icon0.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$ROOT/console/ui/icon0.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$RES/AppIcon.icns" >/dev/null
rm -rf "$ICONSET"

sed "s/0\.10\.0/$VERSION/g" "$ROOT/tools/app-info.plist" > "$CONTENTS/Info.plist"

# Ad-hoc first so the bundle runs on this Mac even with no certificate. A real
# Developer ID, when present, replaces it below.
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true

if [ -n "${DEVELOPER_ID_APPLICATION:-}" ]; then
  say "signing   $DEVELOPER_ID_APPLICATION"
  codesign --force --deep --options runtime --timestamp \
    --sign "$DEVELOPER_ID_APPLICATION" "$APP"
else
  say "signing   skipped (set DEVELOPER_ID_APPLICATION for a distributable build)"
fi

if [ -n "${NOTARY_PROFILE:-}" ]; then
  say "notarize  profile $NOTARY_PROFILE"
  ZIP="$ROOT/build/Prospero Vault.zip"
  rm -f "$ZIP"
  ditto -c -k --keepParent "$APP" "$ZIP"
  xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$APP"
  rm -f "$ZIP"
elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ] && [ -n "${APPLE_APP_PASSWORD:-}" ]; then
  say "notarize  Apple ID $APPLE_ID"
  ZIP="$ROOT/build/Prospero Vault.zip"
  rm -f "$ZIP"
  ditto -c -k --keepParent "$APP" "$ZIP"
  xcrun notarytool submit "$ZIP" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" \
    --password "$APPLE_APP_PASSWORD" --wait
  xcrun stapler staple "$APP"
  rm -f "$ZIP"
else
  say "notarize  skipped (set NOTARY_PROFILE, or APPLE_ID + APPLE_TEAM_ID + APPLE_APP_PASSWORD)"
fi

echo
echo "Built $APP"
echo "  open \"$APP\""
