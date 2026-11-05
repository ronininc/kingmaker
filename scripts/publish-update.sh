#!/bin/bash
# Publish a Kingmaker release to the update host, so every installed Kingmaker picks it up at its next launch or wake.
#
#   node scripts/release-parts.mjs --app <Kingmaker.app> --part-size 100000000
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
# Wrangler sends R2 objects through Cloudflare's API gateway. 300 MB parts have
# repeatedly spent about six minutes in that gateway and then returned 502. Keep
# release parts at 100 MB so an individual retry is short and bounded.
LIMIT=100000000
MAX_ATTEMPTS="${KINGMAKER_UPLOAD_ATTEMPTS:-3}"
STATE_DIR="$DIR/.publish-state"
mkdir -p "$STATE_DIR"

upload_object() {
  local file="$1" key="$2" content_type="${3:-}" digest receipt attempt
  digest="$(shasum -a 256 "$file" | cut -d' ' -f1)"
  receipt="$STATE_DIR/$(basename "$file").sha256"
  if [ -f "$receipt" ] && [ "$(cat "$receipt")" = "$digest  $key" ]; then
    echo "  already uploaded (checkpoint verified)"
    return 0
  fi
  attempt=1
  while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
    echo "  upload attempt $attempt/$MAX_ATTEMPTS"
    if [ -n "$content_type" ]; then
      if $WRANGLER r2 object put "$key" --file "$file" --content-type "$content_type" --remote >/dev/null; then
        printf '%s  %s\n' "$digest" "$key" > "$receipt"
        return 0
      fi
    elif $WRANGLER r2 object put "$key" --file "$file" --remote >/dev/null; then
      printf '%s  %s\n' "$digest" "$key" > "$receipt"
      return 0
    fi
    [ "$attempt" -lt "$MAX_ATTEMPTS" ] || return 1
    sleep $((attempt * 5))
    attempt=$((attempt + 1))
  done
}

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
  [ "$(stat -f %z "$DIR/$f")" -le "$LIMIT" ] || { echo "$f is over 100 MB: re-split with --part-size 100000000"; exit 1; }
done
for f in "${files[@]}"; do
  echo "· $TAG/$f"
  upload_object "$DIR/$f" "$BUCKET/$TAG/$f"
done
if [ -f "$DIR/NOTES.txt" ]; then
  NOTES="$(tr '\n' ' ' < "$DIR/NOTES.txt" | sed 's/\\/\\\\/g; s/"/\\"/g; s/  */ /g; s/ *$//')"
else
  NOTES="Kingmaker $VERSION is the current governed runtime and Launcher release."
  echo "! No NOTES.txt in $DIR: using a minimal release note."
fi
printf '{\n  "version": "%s",\n  "tag": "%s",\n  "engineSha256": "%s",\n  "notes": "%s",\n  "publishedAt": "%s"\n}\n' "$VERSION" "$TAG" "$ENGINE_SHA" "$NOTES" "$(date -u +%FT%TZ)" > "$DIR/latest.json"
# Activation is intentionally not checkpointed: every completed publication
# rewrites latest.json only after every immutable release object succeeded.
rm -f "$STATE_DIR/latest.json.sha256"
upload_object "$DIR/latest.json" "$BUCKET/latest.json" application/json
echo "✓ Kingmaker $VERSION ($TAG) published. Installed Macs update at their next launch or wake."
