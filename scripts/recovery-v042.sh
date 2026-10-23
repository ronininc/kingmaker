#!/bin/bash
set -eu
cd /Users/robbiebrown/Projects/sol-ghost
REL=dist/release/v0.4.2

if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "STOP: CLOUDFLARE_API_TOKEN is set in this shell and would override the kingmaker-live profile."
  echo "Run: unset CLOUDFLARE_API_TOKEN — then run this script again."
  exit 1
fi

SIGNING=$(plutil -extract app.signing raw -o - "$REL/kingmaker-manifest.json")
if [ "$SIGNING" != "Kingmaker Release" ]; then
  echo "STOP: manifest says signed by: $SIGNING — expected: Kingmaker Release. Do not ship."
  exit 1
fi
ARCHIVE_SHA=$(plutil -extract app.sha256 raw -o - "$REL/kingmaker-manifest.json")
echo "   manifest signing: $SIGNING, archive sha256: $ARCHIVE_SHA"

echo "== Recovery 1: the objects the 502 stopped (part08, launcher, manifest, signature, sums, versioned DMG)"
wrangler r2 object put "kingmaker-releases/v0.4.2/Kingmaker-0.4.2.tar.gz.part08" --file "$REL/Kingmaker-0.4.2.tar.gz.part08" --remote --profile kingmaker-live
wrangler r2 object put "kingmaker-releases/v0.4.2/Ronin-Launcher-0.3.1-arm64.zip" --file "$REL/Ronin-Launcher-0.3.1-arm64.zip" --remote --profile kingmaker-live
wrangler r2 object put "kingmaker-releases/v0.4.2/kingmaker-manifest.json" --file "$REL/kingmaker-manifest.json" --remote --profile kingmaker-live
wrangler r2 object put "kingmaker-releases/v0.4.2/kingmaker-manifest.json.sig" --file "$REL/kingmaker-manifest.json.sig" --remote --profile kingmaker-live
wrangler r2 object put "kingmaker-releases/v0.4.2/SHA256SUMS" --file "$REL/SHA256SUMS" --remote --profile kingmaker-live
wrangler r2 object put "kingmaker-releases/public/Kingmaker-Installer-v0.4.2.dmg" --file "dist/Kingmaker-Installer-v0.4.2.dmg" --remote --profile kingmaker-live

echo "== Recovery 2: refresh the unversioned public DMG (the one the site button serves)"
wrangler r2 object put "kingmaker-releases/public/Kingmaker-Installer.dmg" --file "dist/Kingmaker-Installer-v0.4.2.dmg" --remote --profile kingmaker-live

echo "== Recovery 3: point latest.json at the new archive"
if [ -f /tmp/latest-v042.json ]; then
  cp /tmp/latest-v042.json /tmp/latest-v042-new.json
else
  echo "   (no staged latest.json found; building the minimal known shape)"
  printf '{\n  "version": "0.4.2",\n  "tag": "v0.4.2"\n}\n' > /tmp/latest-v042-new.json
fi
ARCHIVE_SHA="$ARCHIVE_SHA" node -e 'const fs = require("node:fs"); const p = "/tmp/latest-v042-new.json"; const j = JSON.parse(fs.readFileSync(p, "utf8")); j.version = "0.4.2"; j.tag = "v0.4.2"; j.engineSha256 = process.env.ARCHIVE_SHA; j.publishedAt = new Date().toISOString(); fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n"); console.log("   latest.json staged, engineSha256 =", j.engineSha256);'
wrangler r2 object put "kingmaker-releases/latest.json" --file /tmp/latest-v042-new.json --remote --profile kingmaker-live

echo "== Recovery 4: replace the GitHub release assets in place"
gh release upload v0.4.2 --repo ronininc/Kingmaker --clobber "$REL"/Kingmaker-0.4.2.tar.gz.part01 "$REL"/Kingmaker-0.4.2.tar.gz.part02 "$REL"/Kingmaker-0.4.2.tar.gz.part03 "$REL"/Kingmaker-0.4.2.tar.gz.part04 "$REL"/Kingmaker-0.4.2.tar.gz.part05 "$REL"/Kingmaker-0.4.2.tar.gz.part06 "$REL"/Kingmaker-0.4.2.tar.gz.part07 "$REL"/Kingmaker-0.4.2.tar.gz.part08 "$REL/Ronin-Launcher-0.3.1-arm64.zip" "$REL/kingmaker-manifest.json" "$REL/kingmaker-manifest.json.sig" "$REL/SHA256SUMS" "dist/Kingmaker-Installer-v0.4.2.dmg"

echo ""
echo "RECOVERY DONE. Corrected 4.2 is live on the update host and GitHub."
echo "Acceptance next: download the installer fresh from the update host, pick 8 GB LEAN + STREAM THE LIBRARY, install, launch."
