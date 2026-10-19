#!/usr/bin/env bash
# Builds the native macOS app: universal (arm64 + x86_64) release binary,
# assembled into apps/macos/dist/TiboTattle.app, ad-hoc signed (not
# notarized), and zipped to apps/macos/dist/TiboTattle-macos.zip.
#
# Usage: apps/macos/build-app.sh
#   TIBOTATTLE_SINGLE_ARCH=1  fall back to a host-architecture build if the
#                             universal build fails (local machines without
#                             both slices of the toolchain).
#
# Makes no network requests beyond what `swift build` needs for a package
# with no dependencies (none).

set -euo pipefail

MACOS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$MACOS_DIR/../.." && pwd)"
DIST="$MACOS_DIR/dist"
APP="$DIST/TiboTattle.app"
ZIP="$DIST/TiboTattle-macos.zip"
PLIST_SRC="$MACOS_DIR/Resources/Info.plist"
ICON_SRC="$MACOS_DIR/Resources/AppIcon.icns"
WEB_SRC="$REPO_ROOT/apps/web"
WEB_FILES=(index.html app.js styles.css favicon.svg)

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-app.sh: macOS is required" >&2
  exit 1
fi

PLIST_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$PLIST_SRC")"
if [[ -z "$PLIST_VERSION" ]]; then
  echo "build-app.sh: Info.plist has no CFBundleShortVersionString" >&2
  exit 1
fi

cd "$MACOS_DIR"

ARCH_ARGS=(--arch arm64 --arch x86_64)
if swift build -c release "${ARCH_ARGS[@]}"; then
  BIN_DIR="$(swift build -c release "${ARCH_ARGS[@]}" --show-bin-path)"
elif [[ "${TIBOTATTLE_SINGLE_ARCH:-0}" == "1" ]]; then
  echo "build-app.sh: universal build failed; building for the host architecture only" >&2
  swift build -c release
  BIN_DIR="$(swift build -c release --show-bin-path)"
else
  echo "build-app.sh: universal build failed (set TIBOTATTLE_SINGLE_ARCH=1 to build for this machine only)" >&2
  exit 1
fi

BIN="$BIN_DIR/TiboTattle"
if [[ ! -x "$BIN" ]]; then
  echo "build-app.sh: executable not found after build" >&2
  exit 1
fi

rm -rf "$APP" "$ZIP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/web"

cp "$BIN" "$APP/Contents/MacOS/TiboTattle"
cp "$PLIST_SRC" "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"
cp "$ICON_SRC" "$APP/Contents/Resources/AppIcon.icns"
for f in "${WEB_FILES[@]}"; do
  cp "$WEB_SRC/$f" "$APP/Contents/Resources/web/$f"
done

plutil -lint "$APP/Contents/Info.plist" >/dev/null

# Strip debug and local symbols before signing.
strip -S -x "$APP/Contents/MacOS/TiboTattle"

# Ad-hoc signature with the hardened runtime; no timestamp server is contacted.
codesign --force --sign - --options runtime --timestamp=none "$APP"
codesign --verify --strict --verbose=2 "$APP"

echo "Architectures: $(lipo -archs "$APP/Contents/MacOS/TiboTattle")"

ditto -c -k --keepParent "$APP" "$ZIP"

echo "App bundle: $(du -sh "$APP" | cut -f1)"
echo "Zip archive: $(du -h "$ZIP" | cut -f1)"
