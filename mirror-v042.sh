#!/bin/bash
set -eu
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "STOP: CLOUDFLARE_API_TOKEN is set in this shell and would silently override the kingmaker-live profile."
  echo "Run: unset CLOUDFLARE_API_TOKEN  — then run this script again."
  exit 1
fi
cd /Users/robbiebrown/Projects/sol-ghost
REL=dist/release/v0.4.2
for i in 01 02 03 04 05 06 07 08; do
  wrangler r2 object put "kingmaker-releases/v0.4.2/Kingmaker-0.4.2.tar.gz.part$i" --file "$REL/Kingmaker-0.4.2.tar.gz.part$i" --remote --profile kingmaker-live
done
wrangler r2 object put "kingmaker-releases/v0.4.2/Ronin-Launcher-0.3.1-arm64.zip" --file "$REL/Ronin-Launcher-0.3.1-arm64.zip" --remote --profile kingmaker-live
wrangler r2 object put "kingmaker-releases/v0.4.2/kingmaker-manifest.json" --file "$REL/kingmaker-manifest.json" --remote --profile kingmaker-live
wrangler r2 object put "kingmaker-releases/v0.4.2/kingmaker-manifest.json.sig" --file "$REL/kingmaker-manifest.json.sig" --remote --profile kingmaker-live
wrangler r2 object put "kingmaker-releases/v0.4.2/SHA256SUMS" --file "$REL/SHA256SUMS" --remote --profile kingmaker-live
wrangler r2 object put "kingmaker-releases/public/Kingmaker-Installer-v0.4.2.dmg" --file "dist/Kingmaker-Installer-v0.4.2.dmg" --remote --profile kingmaker-live
echo "PARTS MIRRORED — latest.json NOT yet updated (separate step)."
