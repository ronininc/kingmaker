#!/bin/sh
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ARMOR=$(CDPATH= cd -- "$HERE/.." && pwd)
OUT=${1:-"$ARMOR/../dist/Scripture Armor.app"}
GHIDRA_HOME=${SCRIPTURE_GHIDRA_HOME:?Set SCRIPTURE_GHIDRA_HOME to the verified Ghidra home}
JDK_HOME=${SCRIPTURE_JDK_HOME:-${JAVA_HOME:?Set SCRIPTURE_JDK_HOME or JAVA_HOME to the verified JDK home}}

test ! -e "$OUT" || { echo "release refused: output already exists: $OUT" >&2; exit 1; }
APP_CONTENTS="$OUT/Contents"
RESOURCES="$APP_CONTENTS/Resources"
MACOS="$APP_CONTENTS/MacOS"
mkdir -p "$RESOURCES" "$MACOS"

ICON_SOURCE="$ARMOR/ui/scripture-armor-app-icon-dark.png"
test -s "$ICON_SOURCE" || { echo "release refused: app icon source missing: $ICON_SOURCE" >&2; exit 1; }
ICON_TMP=$(mktemp -d "${TMPDIR:-/tmp}/scripture-armor-icon.XXXXXX")
trap 'rm -rf "$ICON_TMP"' EXIT HUP INT TERM
ICONSET="$ICON_TMP/ScriptureArmor.iconset"
mkdir -p "$ICONSET"
for ICON_SPEC in \
  '16 icon_16x16.png' '32 icon_16x16@2x.png' \
  '32 icon_32x32.png' '64 icon_32x32@2x.png' \
  '128 icon_128x128.png' '256 icon_128x128@2x.png' \
  '256 icon_256x256.png' '512 icon_256x256@2x.png' \
  '512 icon_512x512.png' '1024 icon_512x512@2x.png'
do
  ICON_SIZE=${ICON_SPEC%% *}
  ICON_NAME=${ICON_SPEC#* }
  sips -z "$ICON_SIZE" "$ICON_SIZE" "$ICON_SOURCE" --out "$ICONSET/$ICON_NAME" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$RESOURCES/ScriptureArmor.icns"

swiftc -j 1 "$HERE/ScriptureArmorApp.swift" "$HERE/LocalKeyAuthorization.swift" \
  "$HERE/ProtectedIdentityVault.swift" "$HERE/ProtectedGenerationStore.swift" "$HERE/NativeKeyRotation.swift" \
  -O -framework AppKit -framework WebKit -framework LocalAuthentication -framework Security \
  -o "$MACOS/Scripture Armor"
chmod 755 "$MACOS/Scripture Armor"

# Clone mode is opt-in and fails closed if the filesystem cannot clone.
set --
if [ "${SCRIPTURE_CLONE_RUNTIMES:-0}" = "1" ]; then set -- --clone-runtimes; fi
node "$ARMOR/build-standalone.mjs" --out "$RESOURCES/armor" --ghidra-home "$GHIDRA_HOME" --jdk-home "$JDK_HOME" --rea-dir "$ARMOR/../lib" "$@"

cat > "$APP_CONTENTS/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Scripture Armor</string>
<key>CFBundleDisplayName</key><string>Scripture Armor</string>
<key>CFBundleIdentifier</key><string>org.ronininc.scripture-armor</string>
<key>CFBundleExecutable</key><string>Scripture Armor</string>
<key>CFBundleIconFile</key><string>ScriptureArmor</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.2.2</string>
<key>CFBundleVersion</key><string>1.2.2</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST

plutil -lint "$APP_CONTENTS/Info.plist"
codesign --force --deep --sign - "$OUT"
codesign --verify --deep --strict --verbose=2 "$OUT"
echo "built native pane: $OUT"
