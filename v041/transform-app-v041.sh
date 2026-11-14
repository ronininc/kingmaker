#!/bin/bash
# transform-app-v041.sh — Solomon-flavored ghost bundle -> Kingmaker release layout.
# Run on the Mac. Fails loud, changes nothing until each step verifies.
# What it does (mirrors release-parts.mjs inspectApp's gate, in order):
#   1. asar: patch the launcher's runtime-folder name (extract -> sed -> repack)
#   2. Resources: solomon-runtime -> kingmaker-runtime; strip its web app/ folder
#      and any engine source maps; patch text files that name the old folder
#   3. MacOS: Solomon -> KingmakerEngine (the Swift wrapper 'Kingmaker' stays
#      the CFBundleExecutable; it names neither binary in source)
#   4. Re-sign inside-out with the pinned local identity (same signer the
#      packager used) and verify the seal.
# It never touches Resources/sol-ghost: payload.json hashes every file there,
# and the engine refuses to start if one byte differs.
set -eu

WT="$HOME/Projects/TSS/.claude/worktrees/distracted-babbage-1b4d8e"
APP="$WT/desktop/dist-ghost/Kingmaker.app"
RES="$APP/Contents/Resources"
OLD_RT="$RES/solomon-runtime"
NEW_RT="$RES/kingmaker-runtime"
SIGNER="$WT/scripts/solomon-mac-selfsigned-sign.mjs"
ENT="$WT/desktop/entitlements.mac.plist"
IDENT="3F7E2899428AF2EB6EBD1237977A90FFD423637B"
WORK="$(mktemp -d /tmp/km-transform.XXXXXX)"

echo "== preconditions =="
[ -d "$APP" ] || { echo "FAIL: no app at $APP"; exit 1; }
[ -d "$OLD_RT" ] || { echo "FAIL: $OLD_RT missing (already transformed?)"; exit 1; }
[ ! -e "$NEW_RT" ] || { echo "FAIL: $NEW_RT already exists"; exit 1; }
[ -f "$RES/sol-ghost/payload.json" ] || { echo "FAIL: payload not unpacked into the app yet"; exit 1; }
[ -x "$APP/Contents/MacOS/Solomon" ] || { echo "FAIL: MacOS/Solomon missing"; exit 1; }
echo "ok"

echo "== 1. asar: patch runtime folder name =="
ASAR_BIN="$WT/node_modules/.bin/asar"
if [ -x "$ASAR_BIN" ]; then ASAR="$ASAR_BIN"; else ASAR="npx --yes @electron/asar"; fi
cp "$RES/app.asar" "$WORK/app.asar.orig"
mkdir -p "$WORK/asar-out"
$ASAR extract "$RES/app.asar" "$WORK/asar-out"
HITS=$(grep -rlI "solomon-runtime" "$WORK/asar-out" || true)
echo "asar files naming solomon-runtime:"; echo "$HITS"
[ -n "$HITS" ] || { echo "FAIL: no asar references found - unexpected, stop"; exit 1; }
for f in $HITS; do sed -i '' 's/solomon-runtime/kingmaker-runtime/g' "$f"; done
REMAIN=$(grep -rlI "solomon-runtime" "$WORK/asar-out" || true)
[ -z "$REMAIN" ] || { echo "FAIL: asar still references solomon-runtime: $REMAIN"; exit 1; }
$ASAR pack "$WORK/asar-out" "$WORK/app.asar.new"
cp "$WORK/app.asar.new" "$RES/app.asar"
echo "asar repacked and swapped (original kept at $WORK/app.asar.orig)"

echo "== 2. runtime folder: rename, strip, patch =="
mv "$OLD_RT" "$NEW_RT"
if [ -d "$NEW_RT/app" ]; then rm -rf "$NEW_RT/app"; echo "stripped kingmaker-runtime/app (web files)"; fi
MAPS=$(find "$NEW_RT" -name "*.map" -not -path "*/node_modules/*" || true)
if [ -n "$MAPS" ]; then echo "$MAPS" | while read -r m; do rm -f "$m"; done; echo "stripped source maps:"; echo "$MAPS"; fi
HITS=$(grep -rlI "solomon-runtime" "$NEW_RT" || true)
echo "runtime files naming solomon-runtime:"; echo "$HITS"
if [ -n "$HITS" ]; then for f in $HITS; do sed -i '' 's/solomon-runtime/kingmaker-runtime/g' "$f"; done; fi
BINHITS=$(grep -rl "solomon-runtime" "$NEW_RT" || true)
if [ -n "$BINHITS" ]; then echo "WARNING: binary files still embed the old name (NOT patched):"; echo "$BINHITS"; fi
echo "== 3. engine binary rename =="
mv "$APP/Contents/MacOS/Solomon" "$APP/Contents/MacOS/KingmakerEngine"
ls "$APP/Contents/MacOS"

echo "== 4. re-sign + verify =="
cd "$WT"
SOLOMON_MAC_APP="$APP" SOLOMON_MAC_ENTITLEMENTS="$ENT" SOLOMON_SIGNING_IDENTITY="$IDENT" node "$SIGNER"
codesign --verify --deep --strict "$APP" && echo "codesign: VALID"

echo "== summary =="
ls "$RES"
echo "Transform complete. Work dir (asar backup): $WORK"
