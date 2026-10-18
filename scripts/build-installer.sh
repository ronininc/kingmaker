#!/bin/sh
# Build "Kingmaker Installer.app" (native SwiftUI, ~2 MB) and ship it in a DMG. The installer carries the release
# manifest it installs (scripts/release-parts.mjs writes it), its engine (installer/engine.sh) and the Ronin Inc crest.
#
#   scripts/build-installer.sh --manifest dist/release/v0.2.0/kingmaker-manifest.json
#       → dist/Kingmaker Installer.app and dist/Kingmaker-Installer-<release>.dmg
#   options: --out <dir> (default dist) · --no-dmg · --draft
#
# A DMG is what owners download, so it is built only when it can ship (lib/release-manifest.mjs shipProblems): a
# manifest of this checkout's version, with the packs and the Ronin Launcher, the right macOS floor, and the update
# enrollment (KINGMAKER_ENROLL_URL + KINGMAKER_ENROLL_CODE). Otherwise it stops and says why. --draft builds it anyway,
# named …-DRAFT.dmg, for a look on this Mac; --no-dmg builds only the app.
#
# Signing and notarization (env-driven; nothing is faked):
#   KINGMAKER_SIGN_IDENTITY   a codesigning identity. Default "-" (ad hoc): runs on this Mac; on another Mac Gatekeeper
#                             blocks it until "Open Anyway". For one-click on other Macs use a
#                             "Developer ID Application: …" identity (Apple Developer Program).
#   KINGMAKER_NOTARY_PROFILE  a `xcrun notarytool store-credentials` profile. With a Developer ID identity, the DMG is
#                             submitted, waited on and stapled. Without both, the build says plainly it is not notarized.
set -eu
here="$(cd "$(dirname "$0")/.." && pwd -P)"
manifest=""; out="$here/dist"; dmg=1; draft=0
while [ $# -gt 0 ]; do
  case "$1" in
    --manifest) manifest="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    --no-dmg) dmg=0; shift ;;
    --draft) draft=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
identity="${KINGMAKER_SIGN_IDENTITY:--}"
version="$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$here/package.json" | head -1)"
release="unreleased"
if [ -n "$manifest" ]; then
  [ -f "$manifest" ] || { echo "no manifest at $manifest (build one: node scripts/release-parts.mjs)" >&2; exit 2; }
  node -e 'import(process.argv[1]).then(({ readManifest }) => readManifest(process.argv[2]))' "$here/lib/release-manifest.mjs" "$manifest" \
    || { echo "the manifest at $manifest is not sound" >&2; exit 2; }
  release="$(plutil -extract tag raw -o - "$manifest")"
  version="$(plutil -extract version raw -o - "$manifest")"
else
  echo "! no --manifest: this installer will say it has nothing to download (fine for looking at the window, not for shipping)"
fi
# Before anything is built: would this DMG be fit to ship?
if [ "$dmg" = 1 ]; then
  problems="$(node -e '
    const [lib, file, pkg] = process.argv.slice(1);
    import(lib).then(async ({ shipProblems }) => {
      const m = file ? JSON.parse(require("node:fs").readFileSync(file, "utf8")) : null;
      const enroll = process.env.KINGMAKER_ENROLL_URL || process.env.KINGMAKER_ENROLL_CODE ? { url: process.env.KINGMAKER_ENROLL_URL, code: process.env.KINGMAKER_ENROLL_CODE } : null;
      const { readPin } = await import(new URL("release-identity.mjs", "file://" + lib).href);
      const out = m ? shipProblems(m, { pkgVersion: pkg, enroll, pin: readPin() }) : ["there is no --manifest: the installer would have nothing to download"];
      for (const p of out) console.log(p);
    });' "$here/lib/release-manifest.mjs" "$manifest" "$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$here/package.json" | head -1)")"
  if [ -n "$problems" ]; then
    if [ "$draft" = 1 ]; then
      printf '%s\n' "$problems" | sed 's/^/! not shippable: /'
      echo "! --draft: building it anyway, named -DRAFT. Never hand this one to anyone."
    else
      printf '%s\n' "$problems" | sed 's/^/✗ /' >&2
      echo "✗ This installer can't ship, so no DMG was built. Fix the above, or --draft for a look on this Mac, or --no-dmg for the app alone." >&2
      exit 3
    fi
  fi
fi

app="$out/Kingmaker Installer.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
swiftc -O -parse-as-library -target arm64-apple-macos14.0 -o "$app/Contents/MacOS/Kingmaker Installer" "$here/installer/KingmakerInstaller.swift" -framework SwiftUI -framework AppKit
cp "$here/installer/Resources/InstallerIcon.icns" "$here/installer/Resources/RoninCrest.png" "$app/Contents/Resources/"
cp "$here/installer/engine.sh" "$app/Contents/Resources/engine.sh"
cp "$here/TERMS.md" "$app/Contents/Resources/TERMS.md"   # the terms hook shows exactly this text
cp "$here/LICENSE" "$here/COMMERCIAL-LICENSE.md" "$here/THIRD_PARTY_NOTICES.md" "$app/Contents/Resources/"   # PolyForm Notices
chmod 755 "$app/Contents/Resources/engine.sh"
# The public pin of the Kingmaker Release certificate: the installer installs only an app signed by exactly it.
if [ -n "$(plutil -extract sha1 raw -o - "$here/lib/release-identity.json" 2>/dev/null || true)" ]; then
  cp "$here/lib/release-identity.json" "$app/Contents/Resources/release-identity.json"
fi
# The pinned release-signing public key travels with engine.sh so it can verify the manifest's signature. The private
# key is OFFLINE and never here. (lib/release-signing.mjs)
cp "$here/lib/kingmaker-release-public.pem" "$app/Contents/Resources/kingmaker-release-public.pem"
if [ -n "$manifest" ]; then
  cp "$manifest" "$app/Contents/Resources/kingmaker-manifest.json"
  # The detached signature, if the release was signed (release-parts.mjs --sign-key). engine.sh refuses a manifest whose
  # signature is present-but-bad, always; an absent one is allowed at first install but refused on --require-signed.
  if [ -f "$manifest.sig" ]; then
    cp "$manifest.sig" "$app/Contents/Resources/kingmaker-manifest.json.sig"
    echo "· release signature embedded (verified against the pinned key at install time)"
  else
    echo "! no $manifest.sig: this installer's release is UNSIGNED. Sign it: node scripts/release-parts.mjs --sign-key <offline-private.pem>"
  fi
fi
# Self-enrollment: with KINGMAKER_ENROLL_URL + KINGMAKER_ENROLL_CODE in the environment the installer carries
# enroll.json, and every Mac it installs gets its own update key (installer/engine.sh). Without them: no auto-updates.
if [ -n "${KINGMAKER_ENROLL_URL:-}" ] && [ -n "${KINGMAKER_ENROLL_CODE:-}" ]; then
  ( umask 077; printf '{"url": "%s", "code": "%s"}\n' "$KINGMAKER_ENROLL_URL" "$KINGMAKER_ENROLL_CODE" > "$app/Contents/Resources/enroll.json" )
  echo "· enrolls each Mac for updates at $KINGMAKER_ENROLL_URL"
else echo "! no KINGMAKER_ENROLL_URL/KINGMAKER_ENROLL_CODE: installed Macs will not get updates on their own"; fi
# Ronin pairing: KINGMAKER_PAIR_CRM=ronininc makes the installer carry pair.json (no key, no code), so each Mac it installs
# asks the owner to pair it on the site at first start (lib/ronin-pairing.mjs). Without it, Macs stay unpaired.
if [ "${KINGMAKER_PAIR_CRM:-}" = "ronininc" ]; then
  printf '{"crm": "ronininc"}\n' > "$app/Contents/Resources/pair.json"
  echo "· installed Macs ask to pair with Ronin CRM at first start"
fi
sed -e "s/@VERSION@/$version/g" -e "s/@RELEASE@/$release/g" "$here/installer/Info.plist" > "$app/Contents/Info.plist"
printf 'APPL????' > "$app/Contents/PkgInfo"

if [ "$identity" = "-" ]; then
  codesign --force --sign - "$app"
  signing="ad hoc (this Mac only; another Mac needs Open Anyway once)"
else
  codesign --force --options runtime --timestamp --sign "$identity" "$app"
  signing="$identity"
fi
codesign --verify --deep --strict "$app"
echo "built $app ($(du -sh "$app" | cut -f1), signed: $signing, release $release)"

[ "$dmg" = 1 ] || exit 0
stage="$out/.dmg-stage"
rm -rf "$stage"; mkdir -p "$stage"
cp -R "$app" "$stage/"
# (the suffix test must not fail the assignment: under set -e a false test here quietly ended the build before the DMG)
suffix=""; if [ "$draft" = 1 ] && [ -n "${problems:-}" ]; then suffix="-DRAFT"; fi
image="$out/Kingmaker-Installer-$release$suffix.dmg"
rm -f "$image"
hdiutil create -quiet -volname "Kingmaker Installer" -srcfolder "$stage" -ov -format UDZO "$image"
rm -rf "$stage"
[ "$identity" = "-" ] || codesign --force --sign "$identity" --timestamp "$image"
echo "built $image ($(du -h "$image" | cut -f1))"

case "$identity" in
  "Developer ID Application:"*)
    if [ -n "${KINGMAKER_NOTARY_PROFILE:-}" ]; then
      xcrun notarytool submit "$image" --keychain-profile "$KINGMAKER_NOTARY_PROFILE" --wait
      xcrun stapler staple "$image"
      echo "notarized and stapled $image"
    else
      echo "NOT notarized: set KINGMAKER_NOTARY_PROFILE (xcrun notarytool store-credentials) to notarize this Developer ID build."
    fi ;;
  *) echo "NOT notarized: notarization needs a Developer ID Application identity (KINGMAKER_SIGN_IDENTITY) and KINGMAKER_NOTARY_PROFILE." ;;
esac
