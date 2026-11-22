#!/bin/bash
set -eu
cd /Users/robbiebrown/Projects/sol-ghost
REL=dist/release/v0.4.2

if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "STOP: CLOUDFLARE_API_TOKEN is set in this shell and would override the kingmaker-live profile."
  echo "Run: unset CLOUDFLARE_API_TOKEN — then run this script again."
  exit 1
fi

echo "== Step 0: the rebuilt release must be finished and signed by Kingmaker Release"
if ls "$REL"/*.tmp >/dev/null 2>&1; then
  echo "STOP: release-parts is still writing (temp parts present). Wait for it to finish, then rerun."
  exit 1
fi
SIGNING=$(plutil -extract app.signing raw -o - "$REL/kingmaker-manifest.json")
if [ "$SIGNING" != "Kingmaker Release" ]; then
  echo "STOP: manifest says signed by: $SIGNING — expected: Kingmaker Release. Do not ship."
  exit 1
fi
ARCHIVE_SHA=$(plutil -extract app.sha256 raw -o - "$REL/kingmaker-manifest.json")
echo "   signing: $SIGNING"
echo "   archive sha256: $ARCHIVE_SHA"

echo "== Step 1: lift update enrollment from the current installer app (values stay in this shell)"
OLD_ENROLL="dist/Kingmaker Installer.app/Contents/Resources/enroll.json"
if [ ! -f "$OLD_ENROLL" ]; then
  echo "STOP: no enroll.json in the current installer app. Refusing to build an installer without enrollment."
  exit 1
fi
export KINGMAKER_ENROLL_URL=$(plutil -extract url raw -o - "$OLD_ENROLL")
export KINGMAKER_ENROLL_CODE=$(plutil -extract code raw -o - "$OLD_ENROLL")
echo "   enrollment captured (not printed)."

echo "== Step 2: build the installer DMG around the new manifest"
scripts/build-installer.sh --manifest "$REL/kingmaker-manifest.json"

echo "== Step 3: mirror parts + manifest + signature + sums + versioned DMG to the update host"
bash mirror-v042.sh

echo "== Step 4: refresh the unversioned public DMG (the one the site button serves)"
wrangler r2 object put "kingmaker-releases/public/Kingmaker-Installer.dmg" --file "dist/Kingmaker-Installer-v0.4.2.dmg" --remote --profile kingmaker-live

echo "== Step 5: point latest.json at the new archive"
if [ -f /tmp/latest-v042.json ]; then
  cp /tmp/latest-v042.json /tmp/latest-v042-new.json
else
  echo "   (no staged latest.json found; building the minimal known shape)"
  printf '{\n  "version": "0.4.2",\n  "tag": "v0.4.2"\n}\n' > /tmp/latest-v042-new.json
fi
ARCHIVE_SHA="$ARCHIVE_SHA" node -e 'const fs = require("node:fs"); const p = "/tmp/latest-v042-new.json"; const j = JSON.parse(fs.readFileSync(p, "utf8")); j.version = "0.4.2"; j.tag = "v0.4.2"; j.engineSha256 = process.env.ARCHIVE_SHA; j.publishedAt = new Date().toISOString(); fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n"); console.log("   latest.json staged, engineSha256 =", j.engineSha256);'
wrangler r2 object put "kingmaker-releases/latest.json" --file /tmp/latest-v042-new.json --remote --profile kingmaker-live

echo "== Step 6: replace the GitHub release assets in place"
gh release upload v0.4.2 --repo ronininc/Kingmaker --clobber "$REL"/Kingmaker-0.4.2.tar.gz.part01 "$REL"/Kingmaker-0.4.2.tar.gz.part02 "$REL"/Kingmaker-0.4.2.tar.gz.part03 "$REL"/Kingmaker-0.4.2.tar.gz.part04 "$REL"/Kingmaker-0.4.2.tar.gz.part05 "$REL"/Kingmaker-0.4.2.tar.gz.part06 "$REL"/Kingmaker-0.4.2.tar.gz.part07 "$REL"/Kingmaker-0.4.2.tar.gz.part08 "$REL/Ronin-Launcher-0.3.1-arm64.zip" "$REL/kingmaker-manifest.json" "$REL/kingmaker-manifest.json.sig" "$REL/SHA256SUMS" "dist/Kingmaker-Installer-v0.4.2.dmg"

echo ""
echo "FINISHER DONE. Corrected 4.2 is live on the update host and GitHub."
echo "Acceptance next: download the installer fresh from the update host, pick 8 GB LEAN + STREAM THE LIBRARY, install, launch."
