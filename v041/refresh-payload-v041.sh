#!/bin/bash
# refresh-payload-v041.sh — swap the rebuilt payload (carrying the enlarged
# 4.1 stack) into the already-transformed Kingmaker.app and re-sign with the
# same pinned local identity the transform used. Run on the Mac. Fails loud,
# changes nothing until each step verifies. Touches ONLY Resources/sol-ghost
# (the payload folder); the transform's work (asar, kingmaker-runtime, the
# KingmakerEngine binary) is left exactly as it is.
set -eu

SG="$HOME/Projects/sol-ghost"
TAR="$SG/dist/payload/kingmaker-payload.tar"
WT="$HOME/Projects/TSS/.claude/worktrees/distracted-babbage-1b4d8e"
APP="$WT/desktop/dist-ghost/Kingmaker.app"
RES="$APP/Contents/Resources"
SIGNER="$WT/scripts/solomon-mac-selfsigned-sign.mjs"
ENT="$WT/desktop/entitlements.mac.plist"
IDENT="3F7E2899428AF2EB6EBD1237977A90FFD423637B"

echo "== preconditions =="
[ -d "$APP" ] || { echo "FAIL: no app at $APP"; exit 1; }
[ -f "$TAR" ] || { echo "FAIL: no payload tar at $TAR"; exit 1; }
[ -d "$RES/kingmaker-runtime" ] || { echo "FAIL: kingmaker-runtime missing (transform not applied?)"; exit 1; }
[ -f "$RES/sol-ghost/payload.json" ] || { echo "FAIL: existing payload missing from the app"; exit 1; }
[ -x "$APP/Contents/MacOS/KingmakerEngine" ] || { echo "FAIL: KingmakerEngine binary missing"; exit 1; }
echo "ok"

echo "== 0. verify the tar against its recorded sha256 =="
cd "$SG/dist/payload"
shasum -a 256 -c kingmaker-payload.tar.sha256

echo "== 1. swap the payload =="
rm -rf "$RES/sol-ghost"
tar -xf "$TAR" -C "$RES"
[ -f "$RES/sol-ghost/payload.json" ] || { echo "FAIL: payload.json missing after unpack"; exit 1; }
COUNT=$(ls "$RES/sol-ghost/lib" | grep -c stack || true)
echo "stack entries inside the app payload: $COUNT"
[ "$COUNT" = "17" ] || { echo "FAIL: expected 17 stack entries inside the app payload"; exit 1; }

echo "== 2. re-sign + verify =="
cd "$WT"
SOLOMON_MAC_APP="$APP" SOLOMON_MAC_ENTITLEMENTS="$ENT" SOLOMON_SIGNING_IDENTITY="$IDENT" node "$SIGNER"
codesign --verify --deep --strict "$APP" && echo "codesign: VALID"

echo "Payload refreshed: the enlarged 4.1 stack is inside the app and the seal is re-applied."
