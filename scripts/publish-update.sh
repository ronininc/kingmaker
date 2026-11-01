#!/bin/bash
# Publish a Kingmaker release to the update host, so every installed Kingmaker picks it up at its next launch or wake.
#
#   node scripts/release-parts.mjs --app <Kingmaker.app> --part-size 300000000   # R2 uploads stop at 315 MB a file
#   scripts/publish-update.sh dist/release/<tag>
#
# Uploads the parts, the manifest, SHA256SUMS and this checkout's installer engine into kingmaker-releases/<tag>/,
# then latest.json LAST (with the spoken release notes from <release dir>/NOTES.txt, what Kingmaker reads out when
# asked "what's in it?"), so a Mac never sees a version whose files are not all up yet. WRANGLER overrides the
# wrangler command (default: npx wrangler, logged in to the account that holds the bucket).
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$(cd "${1:?usage: scripts/publish-update.sh dist/release/<tag>}" && pwd)"
TAG="$(basename "$DIR")"
MANIFEST="$DIR/kingmaker-manifest.json"
[ -f "$MANIFEST" ] || { echo "No kingmaker-manifest.json in $DIR"; exit 1; }
VERSION="$(plutil -extract version raw -o - "$MANIFEST")"
[ "$(plutil -extract tag raw -o - "$MANIFEST")" = "$TAG" ] || { echo "The manifest's tag is not $TAG"; exit 1; }
WRANGLER="${WRANGLER:-npx wrangler}"
BUCKET=kingmaker-releases
LIMIT=314572800

cp "$HERE/installer/engine.sh" "$DIR/engine.sh"
ENGINE_SHA="$(shasum -a 256 "$DIR/engine.sh" | cut -d' ' -f1)"
# The engine we publish MUST be the one pinned in the signed manifest, or the updating app (which authenticates the
# engine against the signed manifest, lib/update.mjs) will refuse it. Fail loudly rather than ship a mismatch.
MANIFEST_ENGINE_SHA="$(plutil -extract engine.sha256 raw -o - "$MANIFEST" 2>/dev/null || true)"
if [ -n "$MANIFEST_ENGINE_SHA" ] && [ "$MANIFEST_ENGINE_SHA" != "$ENGINE_SHA" ]; then
  echo "engine.sh ($ENGINE_SHA) does not match the signed manifest's engine.sha256 ($MANIFEST_ENGINE_SHA)." >&2
  echo "Rebuild the release from this checkout (node scripts/release-parts.mjs) so the pinned engine matches." >&2
  exit 1
fi
# The detached manifest signature: required for a signed release, and the app refuses an update without it. Publish
# it alongside; warn loudly if it's missing (an unsigned release can't auto-update installs on signed builds).
SIG="$MANIFEST.sig"
n="$(plutil -extract parts raw -o - "$MANIFEST")"
files=(); i=0
while [ "$i" -lt "$n" ]; do files+=("$(plutil -extract "parts.$i.name" raw -o - "$MANIFEST")"); i=$((i + 1)); done
files+=(kingmaker-manifest.json SHA256SUMS engine.sh)
# The Ronin Launcher is a required part: an updating Mac fetches it from this same folder (engine.sh, with the
# update key) unless its pin names another url, and the repo's GitHub release is private, so it must be here.
L_ARCHIVE="$(plutil -extract launcher.archive raw -o - "$MANIFEST" 2>/dev/null || true)"
if [ -n "$L_ARCHIVE" ]; then
  L_URL="$(plutil -extract launcher.url raw -o - "$MANIFEST" 2>/dev/null || true)"
  case "$L_URL" in ""|null) ;; *) echo "The launcher pin names $L_URL: updating Macs would fetch it there, not from the update host. Rebuild the pin without a url." >&2; exit 1 ;; esac
  files+=("$L_ARCHIVE")
fi
# With a Kingmaker Release certificate pinned, installed Macs run only an installer script it signed (lib/update.mjs).
if [ -n "$(plutil -extract sha1 raw -o - "$HERE/lib/release-identity.json" 2>/dev/null || true)" ]; then
  node "$HERE/scripts/kingmaker-release-identity.mjs" sign-file "$DIR/engine.sh" || { echo "Could not sign engine.sh with the Kingmaker Release certificate"; exit 1; }
  files+=(engine.sh.sig)
else echo "! No Kingmaker Release certificate pinned: installed Macs can't check who made this update (node scripts/kingmaker-release-identity.mjs create)."; fi
if [ -f "$SIG" ]; then files+=(kingmaker-manifest.json.sig); else echo "! No $SIG: this release is UNSIGNED and installed Kingmakers will refuse to auto-update to it. Sign it: node scripts/release-parts.mjs --sign-key <offline-private.pem>"; fi
for f in "${files[@]}"; do
  [ -f "$DIR/$f" ] || { echo "Missing $DIR/$f"; exit 1; }
  [ "$(stat -f %z "$DIR/$f")" -le "$LIMIT" ] || { echo "$f is over 300 MB: re-split with --part-size 300000000"; exit 1; }
done
for f in "${files[@]}"; do
  echo "· $TAG/$f"
  $WRANGLER r2 object put "$BUCKET/$TAG/$f" --file "$DIR/$f" --remote >/dev/null
done
NOTES="$(tr '\n' ' ' < "$DIR/NOTES.txt" 2>/dev/null | sed 's/\\/\\\\/g; s/"/\\"/g; s/  */ /g; s/ *$//')"
[ -n "$NOTES" ] || echo "! No NOTES.txt in $DIR: Kingmaker will have nothing to say when asked what's in this update."
printf '{\n  "version": "%s",\n  "tag": "%s",\n  "engineSha256": "%s",\n  "notes": "%s",\n  "publishedAt": "%s"\n}\n' "$VERSION" "$TAG" "$ENGINE_SHA" "$NOTES" "$(date -u +%FT%TZ)" > "$DIR/latest.json"
$WRANGLER r2 object put "$BUCKET/latest.json" --file "$DIR/latest.json" --content-type application/json --remote >/dev/null
echo "✓ Kingmaker $VERSION ($TAG) published. Installed Macs update at their next launch or wake."
