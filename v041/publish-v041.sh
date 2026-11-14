#!/bin/sh
# Kingmaker 0.4.1 — create the DRAFT GitHub release with all 13 assets.
# Draft only: nothing goes public. Publish (undraft) is a separate, later call.
set -eu
cd /Users/robbiebrown/Projects/sol-ghost
gh release create v0.4.1 --repo ronininc/kingmaker --draft --title "Kingmaker 0.4.1" \
  "dist/release/v0.4.1/Kingmaker-0.4.1.tar.gz.part01" \
  "dist/release/v0.4.1/Kingmaker-0.4.1.tar.gz.part02" \
  "dist/release/v0.4.1/Kingmaker-0.4.1.tar.gz.part03" \
  "dist/release/v0.4.1/Kingmaker-0.4.1.tar.gz.part04" \
  "dist/release/v0.4.1/Kingmaker-0.4.1.tar.gz.part05" \
  "dist/release/v0.4.1/Kingmaker-0.4.1.tar.gz.part06" \
  "dist/release/v0.4.1/Kingmaker-0.4.1.tar.gz.part07" \
  "dist/release/v0.4.1/Kingmaker-0.4.1.tar.gz.part08" \
  "dist/release/v0.4.1/Ronin-Launcher-0.3.1-arm64.zip" \
  "dist/release/v0.4.1/kingmaker-manifest.json" \
  "dist/release/v0.4.1/kingmaker-manifest.json.sig" \
  "dist/release/v0.4.1/SHA256SUMS" \
  "dist/Kingmaker-Installer-v0.4.1.dmg"
echo "DRAFT RELEASE CREATED — upload finished."
